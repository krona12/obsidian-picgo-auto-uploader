import type {
  JobRecord,
  JobState,
  LogEntry,
  PluginSettings,
  SourceFingerprint,
} from "../domain";
import { sameMetadata } from "../attachment-processor";
import { isTerminalState, JobStore } from "../job-store";
import { isEligibleAttachment, normalizeVaultPath } from "../path-policy";
import { redactText } from "../redaction";
import { UploadQueue, type EnqueueResult } from "../upload-queue";

export interface ControllerLifecycle {
  onLayoutReady(callback: () => void): () => void;
  onFileEvent(callback: (path: string) => void): () => void;
  listPaths(): string[];
  stat(path: string): Promise<SourceFingerprint | null>;
}
export interface ScanResult {
  eligible: number;
  enqueued: number;
  failed: number;
}
type DeepReadonly<T> = T extends object
  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T;
export type ControllerSnapshot = DeepReadonly<{
  state: "running" | "stopped";
  counts: Partial<Record<JobState, number>>;
  lastScanTime: number | null;
  lastScan: ScanResult | null;
  jobs: JobRecord[];
  logs: LogEntry[];
}>;
function freeze<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}
function redactSnapshot<T>(value: T, secret: string): T {
  if (typeof value === "string") return redactText(value, [secret]) as T;
  if (Array.isArray(value))
    return value.map((item) => redactSnapshot(item, secret)) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactSnapshot(item, secret),
      ]),
    ) as T;
  return value;
}
function canAffectReferences(path: string): boolean {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return ["md", "canvas", "base", "html"].includes(extension);
}
export class AutoUploaderController {
  private running = false;
  private generation = 0;
  private cancellation = 0;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private interval: ReturnType<typeof setInterval> | undefined;
  private discoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private discoveryRevision = 0;
  private readonly discoveryAttempts = new Map<string, number>();
  private readonly discoveryFollowups = new Set<string>();
  private releases: (() => void)[] = [];
  private lastScanTime: number | null = null;
  private lastScan: ScanResult | null = null;
  private scan: Promise<ScanResult> | undefined;
  private stopping: Promise<void> | undefined;
  private readonly listeners = new Set<
    (snapshot: ControllerSnapshot) => void
  >();
  constructor(
    private readonly dependencies: {
      settings: Readonly<PluginSettings>;
      store: JobStore;
      queue: UploadQueue;
      lifecycle: ControllerLifecycle;
    },
  ) {}
  start(): void {
    if (this.running || this.stopping) return;
    this.running = true;
    this.discoveryRevision++;
    const generation = ++this.generation;
    let ready = false;
    this.releases.push(this.dependencies.store.subscribe(() => this.publish()));
    this.releases.push(
      this.dependencies.lifecycle.onLayoutReady(() => {
        if (
          ready ||
          !this.running ||
          generation !== this.generation ||
          !this.dependencies.settings.enabled
        )
          return;
        ready = true;
        this.releases.push(
          this.dependencies.lifecycle.onFileEvent((path) => this.event(path)),
        );
        this.interval = setInterval(() => {
          if (this.dependencies.settings.enabled) void this.scanNow();
        }, this.dependencies.settings.reconciliationIntervalMs);
        void this.scanNow();
      }),
    );
    this.publish();
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.running = false;
    this.generation++;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    clearTimeout(this.discoveryTimer);
    this.discoveryTimer = undefined;
    this.discoveryAttempts.clear();
    this.discoveryFollowups.clear();
    clearInterval(this.interval);
    this.interval = undefined;
    for (const release of this.releases) release();
    this.releases = [];
    // Cancellation persistence may fail after signals were aborted. It must not
    // skip the scan or the active worker's drain, or leak a background rejection.
    this.stopping = (async () => {
      try {
        await this.dependencies.queue.cancelPending();
      } catch {
        /* Continue draining. */
      }
      try {
        await this.scan;
      } catch {
        /* The scan failure cannot skip queue drain. */
      }
      try {
        await this.dependencies.queue.drain();
      } catch {
        /* Stop still settles normally. */
      }
    })().finally(() => {
      this.stopping = undefined;
      this.publish();
    });
    return this.stopping;
  }
  scanNow(): Promise<ScanResult> {
    if (!this.running)
      return Promise.resolve({ eligible: 0, enqueued: 0, failed: 0 });
    if (this.scan) return this.scan;
    const generation = this.generation;
    const discoveryRevision = this.discoveryRevision;
    this.scan = this.scanPaths(
      generation,
      this.cancellation,
      discoveryRevision,
    ).finally(() => {
      this.scan = undefined;
      this.publish();
      if (
        this.running &&
        generation === this.generation &&
        discoveryRevision !== this.discoveryRevision
      )
        void this.scanNow();
    });
    return this.scan;
  }
  private async scanPaths(
    generation: number,
    cancellation: number,
    discoveryRevision: number,
  ): Promise<ScanResult> {
    const result: ScanResult = { eligible: 0, enqueued: 0, failed: 0 };
    try {
      await this.dependencies.store.prune();
    } catch {
      result.failed++;
    }
    try {
      const paths = [
        ...new Set([
          ...this.dependencies.lifecycle.listPaths(),
          ...this.dependencies.store
            .snapshot()
            .jobs.filter((job) => !isTerminalState(job.state))
            .map((job) => job.vaultPath),
          ...this.dependencies.store
            .snapshot()
            .jobs.filter((job) => job.pendingSnapshotId !== undefined)
            .map((job) => job.vaultPath),
        ]),
      ];
      for (const path of paths) {
        if (
          !this.running ||
          generation !== this.generation ||
          cancellation !== this.cancellation
        )
          break;
        const previous = this.job(path);
        const eligible = isEligibleAttachment(path, this.dependencies.settings);
        const uncertainSnapshotCleanup = Boolean(
          previous?.pendingSnapshotId && previous.state === "uncertain",
        );
        const resumableSnapshotCleanup = Boolean(
          previous?.pendingSnapshotId &&
          previous.state !== "uncertain" &&
          isTerminalState(previous.state) &&
          previous.failure?.retry === "safe",
        );
        const resumableSafeFailure = Boolean(
          previous?.state === "failed" &&
          previous.failure?.retry === "safe" &&
          ["source-changed", "reference-state-changed"].includes(
            previous.failure.code,
          ),
        );
        const discoveryTerminal = Boolean(
          (previous?.state === "skipped" &&
            previous.failure?.code === "orphan") ||
          (previous?.state === "failed" &&
            previous.failure?.retry === "safe" &&
            previous.failure.code === "discovery-blocked"),
        );
        const retryDiscovery =
          discoveryTerminal &&
          this.discoveryAttempts.get(path) !== discoveryRevision;
        // Interrupted uploads still need uncertainty classification, and a
        // durable deletion intent must finish even if current policy changed.
        // Neither recovery path can start another upload.
        if (
          !eligible &&
          previous?.state !== "uploading" &&
          previous?.state !== "deleting" &&
          !uncertainSnapshotCleanup &&
          !resumableSnapshotCleanup
        )
          continue;
        if (eligible) result.eligible++;
        const enqueued = resumableSnapshotCleanup
          ? await this.dependencies.queue.retry(path)
          : uncertainSnapshotCleanup
            ? await this.dependencies.queue.cleanupUncertainSnapshot(path)
            : resumableSafeFailure
              ? await this.dependencies.queue.retry(path)
              : retryDiscovery
                ? await this.dependencies.queue.retry(path)
                : previous?.state === "trashed"
                  ? await this.dependencies.queue.enqueueNewGeneration(path)
                  : await this.dependencies.queue.recover(path);
        if (!enqueued.ok) result.failed++;
        else if (enqueued.value === "enqueued") {
          result.enqueued++;
          if (eligible) this.discoveryAttempts.set(path, discoveryRevision);
        } else if (
          eligible &&
          this.discoveryAttempts.get(path) !== discoveryRevision &&
          this.dependencies.queue.hasReservation(path)
        )
          this.followDiscoveryAfterActivePath(path, generation, cancellation);
      }
    } catch {
      result.failed++;
    }
    this.lastScanTime = Date.now();
    this.lastScan = result;
    return { ...result };
  }
  async retry(
    path: string,
    options: { acknowledgeUncertain?: boolean } = {},
  ): Promise<EnqueueResult> {
    if (!this.running) return { ok: false, error: { code: "not-retryable" } };
    const revision = this.discoveryRevision;
    const result = await this.dependencies.queue.retry(path, options);
    if (result.ok && result.value === "enqueued")
      this.discoveryAttempts.set(path, revision);
    return result;
  }
  async retrySafeFailures(): Promise<EnqueueResult[]> {
    if (!this.running) return [];
    const revision = this.discoveryRevision;
    const paths = this.dependencies.store
      .snapshot()
      .jobs.filter(
        (job) =>
          isTerminalState(job.state) &&
          job.state !== "uncertain" &&
          job.failure?.retry === "safe",
      )
      .map((job) => job.vaultPath);
    const results = await Promise.all(
      paths.map((path) => this.dependencies.queue.retry(path)),
    );
    results.forEach((result, index) => {
      if (result?.ok && result.value === "enqueued")
        this.discoveryAttempts.set(paths[index]!, revision);
    });
    return results;
  }
  cancelPending(): Promise<void> {
    this.cancellation++;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    return this.dependencies.queue.cancelPending();
  }
  subscribe(listener: (snapshot: ControllerSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  snapshot(): ControllerSnapshot {
    const data = this.dependencies.store.snapshot();
    // Redact stored diagnostic text as well as current errors; settings never enter views.
    const safe = redactSnapshot(data, this.dependencies.settings.picgoSecret);
    const counts: Partial<Record<JobState, number>> = {};
    for (const job of safe.jobs)
      counts[job.state] = (counts[job.state] ?? 0) + 1;
    return freeze({
      state: this.running ? "running" : "stopped",
      counts,
      lastScanTime: this.lastScanTime,
      lastScan: this.lastScan ? { ...this.lastScan } : null,
      ...safe,
    });
  }
  private publish(): void {
    for (const listener of this.listeners) {
      try {
        void Promise.resolve(listener(this.snapshot())).catch(() => {});
      } catch {
        /* Views do not own processing. */
      }
    }
  }
  private job(path: string): JobRecord | undefined {
    return this.dependencies.store
      .snapshot()
      .jobs.find((job) => job.vaultPath === path);
  }
  private event(input: string): void {
    const path = normalizeVaultPath(input);
    if (!this.running || !this.dependencies.settings.enabled || !path) return;
    if (canAffectReferences(path)) {
      this.discoveryRevision++;
      clearTimeout(this.discoveryTimer);
      const generation = this.generation;
      const cancellation = this.cancellation;
      this.discoveryTimer = setTimeout(() => {
        this.discoveryTimer = undefined;
        if (
          this.running &&
          generation === this.generation &&
          cancellation === this.cancellation &&
          this.dependencies.settings.enabled
        )
          void this.scanNow();
      }, this.dependencies.settings.quietPeriodMs);
      return;
    }
    if (!isEligibleAttachment(path, this.dependencies.settings)) return;
    clearTimeout(this.timers.get(path));
    const generation = this.generation;
    const cancellation = this.cancellation;
    this.timers.set(
      path,
      setTimeout(() => {
        this.timers.delete(path);
        void this.enqueueEvent(path, generation, cancellation).catch(() => {});
      }, this.dependencies.settings.quietPeriodMs),
    );
  }
  private async enqueueEvent(
    path: string,
    generation: number,
    cancellation: number,
  ): Promise<void> {
    const active = () =>
      this.running &&
      generation === this.generation &&
      cancellation === this.cancellation &&
      this.dependencies.settings.enabled;
    let dirty = false;
    while (active()) {
      const job = this.job(path);
      const discoveryRevision = this.discoveryRevision;
      let enqueued: EnqueueResult;
      if (job && isTerminalState(job.state)) {
        if (job.state === "trashed") {
          const fingerprint = await this.dependencies.lifecycle.stat(path);
          if (!active() || !fingerprint) return;
          enqueued = await this.dependencies.queue.enqueueNewGeneration(path);
        } else {
          if (job.state === "uncertain" || job.failure?.retry !== "safe")
            return;
          const fingerprint = await this.dependencies.lifecycle.stat(path);
          if (!active() || !fingerprint) return;
          const cleanupPending = job.pendingSnapshotId !== undefined;
          const reserved = this.dependencies.queue.hasReservation(path);
          if (
            !dirty &&
            !reserved &&
            !cleanupPending &&
            (!job.fingerprint || sameMetadata(fingerprint, job.fingerprint))
          )
            return;
          enqueued = await this.dependencies.queue.retry(path);
        }
      } else if (job && job.state !== "queued")
        enqueued = await this.dependencies.queue.recover(path);
      else enqueued = await this.dependencies.queue.enqueue(path);
      if (!enqueued.ok) return;
      if (enqueued.value === "enqueued") {
        this.discoveryAttempts.set(path, discoveryRevision);
        return;
      }
      // The event arrived while this path already had an owner. Re-evaluate the
      // durable result after that exact worker settles, even if metadata stayed equal.
      dirty = true;
      await this.dependencies.queue.waitForPath(path);
    }
  }

  private followDiscoveryAfterActivePath(
    path: string,
    generation: number,
    cancellation: number,
  ): void {
    if (this.discoveryFollowups.has(path)) return;
    this.discoveryFollowups.add(path);
    void this.dependencies.queue
      .waitForPath(path)
      .then(() => {
        this.discoveryFollowups.delete(path);
        if (
          this.running &&
          generation === this.generation &&
          cancellation === this.cancellation &&
          this.dependencies.settings.enabled &&
          this.discoveryAttempts.get(path) !== this.discoveryRevision
        )
          void this.scanNow();
      })
      .catch(() => {
        this.discoveryFollowups.delete(path);
      });
  }
}
