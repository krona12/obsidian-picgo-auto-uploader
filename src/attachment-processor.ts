import type {
  ErrorStage,
  JobFailure,
  JobRecord,
  PluginSettings,
  Result,
  SourceFingerprint,
} from "./domain";
import { isTerminalState, JobStore } from "./job-store";
import { isEligibleAttachment, normalizeVaultPath } from "./path-policy";
import { PicGoClient, validRemoteUrl } from "./picgo-client";
import type { PicGoFailure } from "./picgo-client";
import type { FileProbe, StabilityGate } from "./stability-gate";
import type {
  ReferenceBlocker,
  ReferenceDiscovery,
} from "./reference-rewriter";
import type {
  ReferenceMutationProof,
  RewriteFailure,
  RewriteSummary,
} from "./obsidian/reference-service";

export interface SourcePort<T> extends FileProbe {
  get(path: string): T | null;
  upload(
    file: T,
    expectedFingerprint: SourceFingerprint,
    client: Pick<PicGoClient, "uploadOne">,
    signal: AbortSignal,
  ): Promise<
    Result<
      {
        remoteUrl: string;
        fingerprint: SourceFingerprint;
        pendingSnapshotId?: string;
      },
      PicGoFailure & { pendingSnapshotId?: string }
    >
  >;
  fingerprint(file: T): Promise<SourceFingerprint | null>;
  cleanupSnapshot(snapshotId: string): Promise<boolean>;
  deletePermanently(
    file: T,
    expectedFingerprint: SourceFingerprint,
    proof: ReferenceMutationProof,
  ): Promise<void>;
}
export interface ReferencePort<T> {
  discover(file: T): Promise<ReferenceDiscovery>;
  rewrite(
    plan: ReferenceDiscovery,
    url: string,
  ): Promise<Result<RewriteSummary, RewriteFailure>>;
  waitForRefresh(
    paths: readonly string[],
    signal?: AbortSignal,
  ): Promise<Result<void, ReferenceBlocker>>;
  captureMutationProof(): ReferenceMutationProof;
  verifyNoLocalReferences(file: T): Promise<Result<void, ReferenceBlocker>>;
}
export interface TrashInput {
  remoteUrl: string | undefined;
  rewrittenReferenceCount: number;
  remainingReferences: number;
  blockers: number;
  stableFingerprint: SourceFingerprint | undefined;
  currentFingerprint: SourceFingerprint | null;
  localSnapshotClean: boolean;
  active: boolean;
  exactSourceExists: boolean;
  referenceProofValid: boolean;
}
export function sameFingerprint(
  left: SourceFingerprint | null | undefined,
  right: SourceFingerprint | null | undefined,
): boolean {
  const hashesMatch =
    left?.sha256 === undefined && right?.sha256 === undefined
      ? true
      : typeof left?.sha256 === "string" &&
        typeof right?.sha256 === "string" &&
        /^[a-f0-9]{64}$/.test(left.sha256) &&
        left.sha256 === right.sha256;
  return (
    !!left &&
    !!right &&
    Number.isSafeInteger(left.size) &&
    left.size >= 0 &&
    Number.isFinite(left.mtime) &&
    left.mtime >= 0 &&
    left.size === right.size &&
    left.mtime === right.mtime &&
    hashesMatch
  );
}
export function sameMetadata(
  left: SourceFingerprint | null | undefined,
  right: SourceFingerprint | null | undefined,
): boolean {
  return (
    !!left && !!right && left.size === right.size && left.mtime === right.mtime
  );
}
/** The sole deletion gate: every proof is required, including durable progress. */
export function canTrash(input: TrashInput): boolean {
  return (
    validRemoteUrl(input.remoteUrl) &&
    Number.isSafeInteger(input.rewrittenReferenceCount) &&
    input.rewrittenReferenceCount > 0 &&
    input.remainingReferences === 0 &&
    input.blockers === 0 &&
    sameFingerprint(input.stableFingerprint, input.currentFingerprint) &&
    typeof input.stableFingerprint?.sha256 === "string" &&
    typeof input.currentFingerprint?.sha256 === "string" &&
    input.localSnapshotClean &&
    input.active &&
    input.exactSourceExists &&
    input.referenceProofValid
  );
}
export interface ProcessorDependencies<T> {
  settings: Readonly<PluginSettings>;
  store: JobStore;
  source: SourcePort<T>;
  stability: Pick<StabilityGate, "wait">;
  client: Pick<PicGoClient, "uploadOne">;
  references: ReferencePort<T>;
}

export class AttachmentProcessor<T> {
  constructor(private readonly dependencies: ProcessorDependencies<T>) {}

  async process(vaultPath: string, signal: AbortSignal): Promise<void> {
    const { store, settings, source, stability, client, references } =
      this.dependencies;
    const path = normalizeVaultPath(vaultPath);
    if (!path) return;
    const current = () =>
      store.snapshot().jobs.find((job) => job.vaultPath === path);
    let stage: ErrorStage = "path";
    let uploadInFlight = false;
    let durablePendingSnapshotId: string | undefined;
    let durableConfirmedUpload:
      { remoteUrl: string; fingerprint: SourceFingerprint } | undefined;
    let refreshPaths: string[] = [];
    let referenceProof: ReferenceMutationProof | undefined;
    const fail = async (
      code: string,
      retry: JobFailure["retry"] = "safe",
      state: "failed" | "skipped" | "uncertain" | "cancelled" = "failed",
      notePath?: string,
    ) => {
      if (!current() || isTerminalState(current()!.state)) return;
      const failure: JobFailure = {
        code: /^[a-z][a-z0-9-]*$/.test(code) ? code : "operation-failed",
        stage,
        retry,
        message: "Attachment conversion could not be completed safely.",
        ...(notePath === undefined ? {} : { notePath }),
      };
      await store.transition(path, state, {
        failure,
        ...(durableConfirmedUpload ?? {}),
        ...(durablePendingSnapshotId === undefined
          ? {}
          : { pendingSnapshotId: durablePendingSnapshotId }),
      });
    };
    const cancelled = async () => {
      if (!signal.aborted) return false;
      stage = "lifecycle";
      await fail("aborted", "safe", "cancelled");
      return true;
    };
    try {
      let job = current();
      if (!job) {
        const now = Date.now();
        job = await store.upsert({
          vaultPath: path,
          state: "queued",
          createdAt: now,
          updatedAt: now,
          rewrittenNotePaths: [],
          rewrittenReferenceCount: 0,
        });
      }
      if (job.pendingSnapshotId) {
        stage = "upload";
        const snapshotId = job.pendingSnapshotId;
        durablePendingSnapshotId = snapshotId;
        if (!(await source.cleanupSnapshot(snapshotId))) {
          if (job.state !== "deleting") await fail("snapshot-cleanup-failed");
          return;
        }
        await store.completeSnapshotCleanup(path, snapshotId);
        durablePendingSnapshotId = undefined;
        job = current()!;
      }
      if (isTerminalState(job.state)) return;
      if (job.state === "deleting") {
        stage = "trash";
        const file = source.get(path);
        if (!file) {
          await store.transition(path, "trashed");
          return;
        }
        if (
          !validRemoteUrl(job.remoteUrl) ||
          !job.fingerprint?.sha256 ||
          job.pendingSnapshotId !== undefined ||
          job.rewrittenReferenceCount < 1
        )
          return await fail("invalid-deletion-intent", "non-retryable");
        const currentFingerprint = await source.fingerprint(file);
        if (!sameFingerprint(job.fingerprint, currentFingerprint))
          return await fail("source-changed");
        const plan = await references.discover(file);
        if (plan.blockers.length) {
          const blocker = plan.blockers[0]!;
          return await fail(
            blocker.code,
            blocker.retry,
            "failed",
            blocker.notePath,
          );
        }
        if (plan.references.length)
          return await fail("remaining-references", "safe", "failed");
        referenceProof = references.captureMutationProof();
        const verified = await references.verifyNoLocalReferences(file);
        if (!verified.ok)
          return await fail(
            verified.error.code,
            verified.error.retry,
            "failed",
            verified.error.notePath,
          );
        if (
          signal.aborted ||
          !referenceProof.isValid() ||
          source.get(path) !== file ||
          !sameFingerprint(job.fingerprint, await source.fingerprint(file))
        )
          return await fail(signal.aborted ? "aborted" : "source-changed");
        try {
          await source.deletePermanently(file, job.fingerprint, referenceProof);
          if (source.get(path)) throw new Error("The source is still present.");
          await store.transition(path, "trashed");
        } catch {
          // The durable intent is the recovery boundary: deletion may already
          // have completed, so never downgrade this state to a retryable failure.
        }
        return;
      }
      if (!isEligibleAttachment(path, settings))
        return await fail("ineligible-path", "non-retryable", "skipped");
      if (await cancelled()) return;
      if (job.state === "queued")
        await store.transition(path, "waiting-stable");
      stage = "stability";
      const stable = await stability.wait(path, settings, signal);
      if (await cancelled()) return;
      if (!stable.ok) return await fail(stable.error.code, stable.error.retry);
      await store.transition(path, "discovering-references", {
        ...(job.remoteUrl ? {} : { fingerprint: stable.value }),
      });
      stage = "reference";
      const file = source.get(path);
      if (!file) return await fail("file-missing");
      const plan = await references.discover(file);
      if (await cancelled()) return;
      if (plan.blockers.length) {
        const blocker = plan.blockers[0]!;
        return await fail(
          blocker.code,
          blocker.retry,
          "failed",
          blocker.notePath,
        );
      }
      job = current()!;
      if (job.remoteUrl) {
        stage = "upload";
        if (!validRemoteUrl(job.remoteUrl))
          return await fail("invalid-saved-url", "non-retryable");
        if (!job.fingerprint?.sha256) return await fail("source-changed");
        const currentFingerprint = await source.fingerprint(file);
        if (!currentFingerprint?.sha256) return await fail("source-changed");
        if (currentFingerprint.sha256 === job.fingerprint.sha256) {
          await store.upsert({ ...job, fingerprint: currentFingerprint });
          job = current()!;
        } else {
          job = await store.resetChangedSourceGeneration(
            path,
            job.fingerprint.sha256,
            currentFingerprint,
          );
        }
        stage = "reference";
      }
      if (
        !plan.references.length &&
        !(job.remoteUrl && job.rewrittenReferenceCount > 0)
      )
        return await fail("orphan", "safe", "skipped");
      if (
        !sameFingerprint(stable.value, await source.stat(path)) ||
        source.get(path) !== file ||
        !sameMetadata(stable.value, plan.fingerprint)
      )
        return await fail("source-changed");
      if (await cancelled()) return;
      if (!job.remoteUrl) {
        stage = "upload";
        await store.transition(path, "uploading");
        uploadInFlight = true;
        const uploaded = await source.upload(
          file,
          job.fingerprint ?? stable.value,
          client,
          signal,
        );
        if (!uploaded.ok) {
          durablePendingSnapshotId = uploaded.error.pendingSnapshotId;
          // Keep uncertainty until the terminal state (and its log) is durable.
          uploadInFlight = uploaded.error.retry === "uncertain";
          return await fail(
            uploaded.error.code,
            uploaded.error.retry,
            uploaded.error.state,
          );
        }
        // Carry snapshot cleanup through the same durable URL/terminal
        // checkpoint. If persistence itself fails, the outer failure write
        // retains this token rather than orphaning private bytes locally.
        durablePendingSnapshotId = uploaded.value.pendingSnapshotId;
        if (!validRemoteUrl(uploaded.value.remoteUrl))
          return await fail("invalid-result", "uncertain", "uncertain");
        durableConfirmedUpload = {
          remoteUrl: uploaded.value.remoteUrl,
          fingerprint: uploaded.value.fingerprint,
        };
        uploadInFlight = false;
        // Persist a confirmed upload before any local post-upload check can fail.
        // A retry can then reuse this exact snapshot URL instead of uploading it again.
        await store.transition(path, "rewriting", {
          ...durableConfirmedUpload,
          ...(uploaded.value.pendingSnapshotId === undefined
            ? {}
            : { pendingSnapshotId: uploaded.value.pendingSnapshotId }),
        });
        if (uploaded.value.pendingSnapshotId) {
          if (!(await source.cleanupSnapshot(uploaded.value.pendingSnapshotId)))
            return await fail("snapshot-cleanup-failed");
          await store.completeSnapshotCleanup(
            path,
            uploaded.value.pendingSnapshotId,
          );
          durablePendingSnapshotId = undefined;
        }
        const currentFingerprint = await source.fingerprint(file);
        if (
          !sameFingerprint(uploaded.value.fingerprint, currentFingerprint) ||
          source.get(path) !== file
        )
          return await fail("source-changed");
      } else {
        await store.transition(path, "rewriting");
      }
      if (await cancelled()) return;
      stage = "rewrite";
      refreshPaths = [
        ...new Set(plan.references.map((reference) => reference.notePath)),
      ];
      const rewritten = await references.rewrite(plan, current()!.remoteUrl!);
      const progress = rewritten.ok ? rewritten.value : rewritten.error;
      job = current()!;
      const checkpoint: JobRecord = {
        ...job,
        rewrittenNotePaths: [
          ...new Set([
            ...job.rewrittenNotePaths,
            ...progress.rewrittenNotePaths,
          ]),
        ],
        rewrittenReferenceCount:
          job.rewrittenReferenceCount + progress.rewrittenReferenceCount,
      };
      await store.upsert(checkpoint);
      if (!rewritten.ok)
        return await fail(
          rewritten.error.code,
          rewritten.error.retry,
          "failed",
          rewritten.error.notePath,
        );
      if (await cancelled()) return;
      stage = "verify";
      await store.transition(path, "verifying");
      const refreshed = await references.waitForRefresh(
        progress.rewrittenNotePaths,
        signal,
      );
      if (await cancelled()) return;
      if (!refreshed.ok)
        return await fail(
          refreshed.error.code,
          refreshed.error.retry,
          "failed",
          refreshed.error.notePath,
        );
      referenceProof = references.captureMutationProof();
      const verified = await references.verifyNoLocalReferences(file);
      if (await cancelled()) return;
      if (!verified.ok)
        return await fail(
          verified.error.code,
          verified.error.retry,
          "failed",
          verified.error.notePath,
        );
      const fingerprint = await source.fingerprint(file);
      if (await cancelled()) return;
      job = current()!;
      const exactSourceExists = source.get(path) === file;
      const fingerprintMatches = sameFingerprint(job.fingerprint, fingerprint);
      const referenceProofValid = referenceProof.isValid();
      if (
        !canTrash({
          remoteUrl: job.remoteUrl,
          rewrittenReferenceCount: job.rewrittenReferenceCount,
          remainingReferences: 0,
          blockers: 0,
          stableFingerprint: job.fingerprint,
          currentFingerprint: fingerprint,
          localSnapshotClean: job.pendingSnapshotId === undefined,
          active: !signal.aborted,
          exactSourceExists,
          referenceProofValid,
        })
      ) {
        if (signal.aborted) return await fail("aborted", "safe", "cancelled");
        return await fail(
          !exactSourceExists || !fingerprintMatches
            ? "source-changed"
            : !referenceProofValid
              ? "reference-state-changed"
              : "source-changed",
        );
      }
      stage = "trash";
      await store.transition(path, "deleting");
      if (signal.aborted || !referenceProof.isValid()) return;
      // JavaScript cannot interleave a Vault event between this synchronous proof
      // check and permanent-delete dispatch; the adapter asserts the same proof again.
      try {
        await source.deletePermanently(file, job.fingerprint!, referenceProof);
        if (source.get(path)) throw new Error("The source is still present.");
        await store.transition(path, "trashed");
      } catch {
        // Preserve the durable deletion intent; recovery distinguishes an
        // absent source from an unchanged or replaced source without re-uploading.
      }
    } catch {
      // Native exceptions may contain full paths or credentials. Never retain them.
      try {
        await fail(
          "operation-failed",
          uploadInFlight ? "uncertain" : "safe",
          uploadInFlight
            ? "uncertain"
            : signal.aborted
              ? "cancelled"
              : "failed",
        );
      } catch {
        /* Persistence itself is unavailable; settle without another side effect. */
      }
    } finally {
      referenceProof?.release();
      // A rewrite can install metadata listeners before cancellation or failure.
      // The reference service clears settled watches on its next fresh discovery.
      if (refreshPaths.length) {
        const cleanup = new AbortController();
        cleanup.abort();
        try {
          await references.waitForRefresh(refreshPaths, cleanup.signal);
        } catch {
          /* Cleanup must not reject background work. */
        }
      }
    }
  }
}
