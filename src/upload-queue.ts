import type { JobRecord, Result } from "./domain";
import { isTerminalState, JobStore } from "./job-store";
import { normalizeVaultPath } from "./path-policy";

export interface QueueFailure {
  code: "invalid-path" | "queue-full" | "not-retryable" | "persistence-failure";
}
export type EnqueueResult = Result<"enqueued" | "duplicate", QueueFailure>;
export type UploadWorker = (
  job: JobRecord,
  signal: AbortSignal,
) => Promise<void>;

interface Entry {
  path: string;
  controller: AbortController;
  cleanupOnly: boolean;
  ready: Promise<boolean>;
  done: Promise<void>;
  finish: () => void;
}

/** A reservation is synchronous; even concurrent enqueue calls share a single identity. */
export class UploadQueue {
  private readonly entries = new Map<string, Entry>();
  private running = false;
  private active: Entry | undefined;
  private readonly maxPending: number;
  private readonly now: () => number;

  constructor(
    private readonly store: JobStore,
    private readonly worker: UploadWorker,
    options: { maxPending?: number; now?: () => number } = {},
  ) {
    this.maxPending = options.maxPending ?? 1000;
    this.now = options.now ?? Date.now;
    if (
      !Number.isSafeInteger(this.maxPending) ||
      this.maxPending < 1 ||
      this.maxPending > 1000
    )
      throw new Error("Invalid queue capacity.");
  }

  enqueue(path: string): Promise<EnqueueResult> {
    return this.reserve(path);
  }

  /** A caller that has observed a file at a previously trashed path starts a fresh job. */
  enqueueNewGeneration(path: string): Promise<EnqueueResult> {
    return this.reserve(path, undefined, false, true);
  }

  /** Reserve identity before recovery so a scan cannot reset an active worker. */
  recover(path: string): Promise<EnqueueResult> {
    return this.reserve(path, undefined, true);
  }

  retry(
    path: string,
    options: { acknowledgeUncertain?: boolean } = {},
  ): Promise<EnqueueResult> {
    return this.reserve(path, options);
  }

  /** Remove a retained private snapshot for an uncertain upload without
   * acknowledging, retrying, or otherwise advancing that upload. */
  cleanupUncertainSnapshot(path: string): Promise<EnqueueResult> {
    return this.reserve(path, undefined, false, false, true);
  }

  async retrySafeFailures(): Promise<EnqueueResult[]> {
    const safe = this.store
      .snapshot()
      .jobs.filter(
        (job) =>
          isTerminalState(job.state) &&
          job.state !== "uncertain" &&
          job.failure?.retry === "safe",
      );
    return Promise.all(safe.map((job) => this.retry(job.vaultPath)));
  }

  async cancelPending(): Promise<void> {
    const entries = [...this.entries.values()];
    for (const entry of entries) entry.controller.abort();
    await Promise.all(
      entries
        .filter((entry) => entry !== this.active)
        .map(async (entry) => {
          if (await entry.ready) await this.settle(entry, false);
        }),
    );
    await Promise.all(entries.map((entry) => entry.done));
  }

  /** Snapshot semantics: later enqueues do not extend an existing drain. */
  async drain(): Promise<void> {
    await Promise.all([...this.entries.values()].map((entry) => entry.done));
  }

  /** Wait only for the reservation currently owning this path. A later event
   * can then re-evaluate durable state without extending the wait globally. */
  async waitForPath(path: string): Promise<void> {
    const normalized = normalizeVaultPath(path);
    if (!normalized) return;
    await this.entries.get(normalized)?.done;
  }

  /** True while this path is reserved, including the brief interval after the
   * worker has persisted a terminal result but before the reservation settles. */
  hasReservation(path: string): boolean {
    const normalized = normalizeVaultPath(path);
    return normalized ? this.entries.has(normalized) : false;
  }

  private reserve(
    path: string,
    retry?: { acknowledgeUncertain?: boolean },
    recover = false,
    newGeneration = false,
    cleanupOnly = false,
  ): Promise<EnqueueResult> {
    const normalized = normalizeVaultPath(path);
    if (!normalized)
      return Promise.resolve({ ok: false, error: { code: "invalid-path" } });
    if (this.entries.has(normalized))
      return Promise.resolve({ ok: true, value: "duplicate" });
    const previous = this.get(normalized);
    if (
      cleanupOnly &&
      (!previous ||
        previous.state !== "uncertain" ||
        previous.pendingSnapshotId === undefined)
    )
      return Promise.resolve({ ok: false, error: { code: "not-retryable" } });
    if (
      !cleanupOnly &&
      !retry &&
      previous &&
      isTerminalState(previous.state) &&
      !(newGeneration && previous.state === "trashed")
    )
      return Promise.resolve({ ok: true, value: "duplicate" });
    if (
      retry &&
      (!previous ||
        !isTerminalState(previous.state) ||
        previous.failure?.retry === "non-retryable" ||
        (previous.state === "uncertain"
          ? !retry.acknowledgeUncertain
          : previous.failure?.retry !== "safe"))
    )
      return Promise.resolve({ ok: false, error: { code: "not-retryable" } });
    if (this.entries.size >= this.maxPending)
      return Promise.resolve({ ok: false, error: { code: "queue-full" } });
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const entry: Entry = {
      path: normalized,
      controller: new AbortController(),
      cleanupOnly,
      ready: Promise.resolve(false),
      done,
      finish,
    };
    this.entries.set(normalized, entry);
    const initialize = async (): Promise<EnqueueResult> => {
      try {
        if (cleanupOnly) return { ok: true, value: "enqueued" };
        if (newGeneration && previous?.state === "trashed")
          await this.store.resetTrashedGeneration(normalized, this.now());
        else if (recover && previous && previous.state !== "queued") {
          const recovered = await this.store.recoverInterrupted(normalized);
          if (isTerminalState(recovered.state))
            return { ok: true, value: "duplicate" };
        } else if (retry)
          await this.store.transition(normalized, "queued", {}, retry);
        else if (!previous) {
          const now = this.now();
          await this.store.upsert({
            vaultPath: normalized,
            state: "queued",
            createdAt: now,
            updatedAt: now,
            rewrittenNotePaths: [],
            rewrittenReferenceCount: 0,
          });
        } else if (previous.state !== "queued")
          return { ok: false, error: { code: "not-retryable" } };
        return { ok: true, value: "enqueued" };
      } catch {
        return { ok: false, error: { code: "persistence-failure" } };
      }
    };
    const result = initialize();
    entry.ready = result.then((value) => value.ok);
    this.start();
    return result;
  }

  private get(path: string): JobRecord | undefined {
    return this.store.snapshot().jobs.find((job) => job.vaultPath === path);
  }

  private start(): void {
    if (this.running) return;
    this.running = true;
    // All failures are handled within run; the final guard also covers persistence failures.
    void this.run()
      .finally(() => {
        this.running = false;
        if (this.entries.size) this.start();
      })
      .catch(() => {});
  }

  private async run(): Promise<void> {
    while (this.entries.size) {
      const entry = this.entries.values().next().value!;
      this.active = entry;
      try {
        if (!(await entry.ready)) continue;
        if (isTerminalState(this.get(entry.path)!.state) && !entry.cleanupOnly)
          continue;
        if (!entry.controller.signal.aborted) {
          if (!entry.cleanupOnly && this.get(entry.path)!.state !== "deleting")
            await this.store.transition(entry.path, "waiting-stable");
          if (!entry.controller.signal.aborted)
            await this.worker(this.get(entry.path)!, entry.controller.signal);
        }
        const job = this.get(entry.path);
        if (
          !entry.cleanupOnly &&
          job &&
          !isTerminalState(job.state) &&
          job.state !== "deleting"
        )
          await this.settle(entry, false);
      } catch {
        if (!entry.cleanupOnly && this.get(entry.path)?.state !== "deleting")
          await this.settle(entry, true).catch(() => {});
      } finally {
        this.entries.delete(entry.path);
        this.active = undefined;
        entry.finish();
      }
    }
  }

  private async settle(entry: Entry, threw: boolean): Promise<void> {
    const job = this.get(entry.path);
    if (!job || isTerminalState(job.state) || job.state === "deleting") return;
    const uncertain = job.state === "uploading";
    const cancelled = entry.controller.signal.aborted && !uncertain;
    await this.store
      .transition(
        entry.path,
        uncertain ? "uncertain" : cancelled ? "cancelled" : "failed",
        {
          failure: {
            code: uncertain
              ? "worker-uncertain"
              : cancelled
                ? "aborted"
                : threw
                  ? "worker-failed"
                  : "worker-incomplete",
            stage: uncertain ? "upload" : "lifecycle",
            message: uncertain
              ? "Upload completion could not be confirmed."
              : cancelled
                ? "Queued work was cancelled."
                : "The upload worker did not complete the job.",
            retry: uncertain
              ? "uncertain"
              : cancelled
                ? "non-retryable"
                : "safe",
          },
        },
      )
      .catch((error: unknown) => {
        // Concurrent cancellation may have already durably settled this same entry.
        const current = this.get(entry.path);
        if (!current || !isTerminalState(current.state)) throw error;
      });
  }
}
