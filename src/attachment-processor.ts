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
import type { FileProbe, StabilityGate } from "./stability-gate";
import type {
  ReferenceBlocker,
  ReferenceDiscovery,
} from "./reference-rewriter";
import type {
  RewriteFailure,
  RewriteSummary,
} from "./obsidian/reference-service";

export interface SourcePort<T> extends FileProbe {
  get(path: string): T | null;
  upload(
    file: T,
    client: Pick<PicGoClient, "uploadOne">,
    signal: AbortSignal,
  ): ReturnType<PicGoClient["uploadOne"]>;
  trash(file: T, system: false): Promise<void>;
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
  verifyNoLocalReferences(file: T): Promise<Result<void, ReferenceBlocker>>;
}
export interface TrashInput {
  remoteUrl: string | undefined;
  rewrittenReferenceCount: number;
  remainingReferences: number;
  blockers: number;
  stableFingerprint: SourceFingerprint | undefined;
  currentFingerprint: SourceFingerprint | null;
  active: boolean;
  exactSourceExists: boolean;
}
export function sameFingerprint(
  left: SourceFingerprint | null | undefined,
  right: SourceFingerprint | null | undefined,
): boolean {
  return (
    !!left &&
    !!right &&
    Number.isSafeInteger(left.size) &&
    left.size >= 0 &&
    Number.isFinite(left.mtime) &&
    left.mtime >= 0 &&
    left.size === right.size &&
    left.mtime === right.mtime
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
    input.active &&
    input.exactSourceExists
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
    let refreshPaths: string[] = [];
    const fail = async (
      code: string,
      retry: JobFailure["retry"] = "safe",
      state: "failed" | "skipped" | "uncertain" | "cancelled" = "failed",
    ) => {
      if (!current() || isTerminalState(current()!.state)) return;
      await store.transition(path, state, {
        failure: {
          code: /^[a-z][a-z0-9-]*$/.test(code) ? code : "operation-failed",
          stage,
          retry,
          message: "Attachment conversion could not be completed safely.",
        },
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
      if (isTerminalState(job.state)) return;
      if (!isEligibleAttachment(path, settings))
        return await fail("ineligible-path", "non-retryable", "skipped");
      if (await cancelled()) return;
      if (job.state === "queued")
        await store.transition(path, "waiting-stable");
      stage = "stability";
      const stable = await stability.wait(path, settings, signal);
      if (await cancelled()) return;
      if (!stable.ok) return await fail(stable.error.code, stable.error.retry);
      // A saved URL belongs to the old bytes; never assign it to a replacement.
      if (job.remoteUrl && !sameFingerprint(job.fingerprint, stable.value))
        return await fail("source-changed");
      await store.transition(path, "discovering-references", {
        fingerprint: stable.value,
      });
      stage = "reference";
      const file = source.get(path);
      if (!file) return await fail("file-missing");
      const plan = await references.discover(file);
      if (await cancelled()) return;
      if (plan.blockers.length) return await fail("discovery-blocked");
      job = current()!;
      if (
        !plan.references.length &&
        !(job.remoteUrl && job.rewrittenReferenceCount > 0)
      )
        return await fail("orphan", "safe", "skipped");
      if (
        !sameFingerprint(stable.value, await source.stat(path)) ||
        source.get(path) !== file ||
        !sameFingerprint(stable.value, plan.fingerprint)
      )
        return await fail("source-changed");
      if (await cancelled()) return;
      if (!job.remoteUrl) {
        stage = "upload";
        await store.transition(path, "uploading");
        uploadInFlight = true;
        const uploaded = await source.upload(file, client, signal);
        if (!uploaded.ok) {
          uploadInFlight = false;
          return await fail(
            uploaded.error.code,
            uploaded.error.retry,
            uploaded.error.state,
          );
        }
        if (!validRemoteUrl(uploaded.value))
          return await fail("invalid-result", "uncertain", "uncertain");
        // Persist the returned URL before any rewrite or cancellation exit.
        await store.transition(path, "rewriting", {
          remoteUrl: uploaded.value,
        });
        uploadInFlight = false;
      } else {
        if (!validRemoteUrl(job.remoteUrl))
          return await fail("invalid-saved-url", "non-retryable");
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
        return await fail(rewritten.error.code, rewritten.error.retry);
      if (await cancelled()) return;
      stage = "verify";
      await store.transition(path, "verifying");
      const refreshed = await references.waitForRefresh(
        progress.rewrittenNotePaths,
        signal,
      );
      if (await cancelled()) return;
      if (!refreshed.ok) return await fail(refreshed.error.code);
      const verified = await references.verifyNoLocalReferences(file);
      if (await cancelled()) return;
      if (!verified.ok) return await fail(verified.error.code);
      const fingerprint = await source.stat(path);
      if (await cancelled()) return;
      job = current()!;
      if (
        !canTrash({
          remoteUrl: job.remoteUrl,
          rewrittenReferenceCount: job.rewrittenReferenceCount,
          remainingReferences: 0,
          blockers: 0,
          stableFingerprint: job.fingerprint,
          currentFingerprint: fingerprint,
          active: !signal.aborted,
          exactSourceExists: source.get(path) === file,
        })
      )
        return await fail(
          signal.aborted ? "aborted" : "source-changed",
          "safe",
          signal.aborted ? "cancelled" : "failed",
        );
      stage = "trash";
      await source.trash(file, false);
      await store.transition(path, "trashed");
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
