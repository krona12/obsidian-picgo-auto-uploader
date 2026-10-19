import { DEFAULT_SETTINGS } from "./defaults";
import type {
  JobRecord,
  JobState,
  LogEntry,
  SourceFingerprint,
} from "./domain";
import { normalizeVaultPath } from "./path-policy";

export interface JobSnapshot {
  jobs: JobRecord[];
  logs: LogEntry[];
}

export interface JobPersistence {
  load(): Promise<unknown>;
  save(snapshot: JobSnapshot): Promise<void>;
}

export interface JobStoreOptions {
  now?: () => number;
  historyMaxEntries?: number;
  historyMaxAgeDays?: number;
}

export type JobPatch = Partial<
  Pick<
    JobRecord,
    | "fingerprint"
    | "remoteUrl"
    | "pendingSnapshotId"
    | "rewrittenNotePaths"
    | "rewrittenReferenceCount"
    | "failure"
  >
>;

const forward: Partial<Record<JobState, JobState>> = {
  queued: "waiting-stable",
  "waiting-stable": "discovering-references",
  "discovering-references": "uploading",
  uploading: "rewriting",
  rewriting: "verifying",
  verifying: "deleting",
  deleting: "trashed",
};
const exits: JobState[] = ["skipped", "failed", "uncertain", "cancelled"];
const states: JobState[] = [
  ...(Object.keys(forward) as JobState[]),
  "trashed",
  ...exits,
];
const stages = [
  "path",
  "stability",
  "reference",
  "upload",
  "rewrite",
  "verify",
  "trash",
  "lifecycle",
];

export function isTerminalState(state: JobState): boolean {
  return state === "trashed" || exits.includes(state);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function number(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validJob(value: unknown): value is JobRecord {
  if (!object(value)) return false;
  return (
    typeof value.vaultPath === "string" &&
    normalizeVaultPath(value.vaultPath) !== null &&
    states.includes(value.state as JobState) &&
    number(value.createdAt) &&
    number(value.updatedAt) &&
    Array.isArray(value.rewrittenNotePaths) &&
    value.rewrittenNotePaths.every((path) => typeof path === "string") &&
    Number.isSafeInteger(value.rewrittenReferenceCount) &&
    (value.rewrittenReferenceCount as number) >= 0 &&
    (value.remoteUrl === undefined ||
      (typeof value.remoteUrl === "string" && value.remoteUrl.length > 0)) &&
    (value.pendingSnapshotId === undefined ||
      (typeof value.pendingSnapshotId === "string" &&
        /^obsidian-picgo-\d+-[0-9a-f-]+$/i.test(value.pendingSnapshotId))) &&
    (value.fingerprint === undefined ||
      (object(value.fingerprint) &&
        number(value.fingerprint.size) &&
        Number.isSafeInteger(value.fingerprint.size) &&
        number(value.fingerprint.mtime) &&
        (value.fingerprint.sha256 === undefined ||
          (typeof value.fingerprint.sha256 === "string" &&
            /^[a-f0-9]{64}$/.test(value.fingerprint.sha256))))) &&
    (value.failure === undefined ||
      (object(value.failure) &&
        typeof value.failure.code === "string" &&
        typeof value.failure.message === "string" &&
        (value.failure.notePath === undefined ||
          (typeof value.failure.notePath === "string" &&
            normalizeVaultPath(value.failure.notePath) !== null)) &&
        stages.includes(value.failure.stage as string) &&
        ["safe", "uncertain", "non-retryable"].includes(
          value.failure.retry as string,
        )))
  );
}

function validLog(value: unknown): value is LogEntry {
  return (
    object(value) &&
    number(value.timestamp) &&
    ["info", "warn", "error"].includes(value.level as string) &&
    stages.includes(value.stage as string) &&
    typeof value.code === "string" &&
    typeof value.message === "string" &&
    (value.vaultPath === undefined ||
      (typeof value.vaultPath === "string" &&
        normalizeVaultPath(value.vaultPath) !== null)) &&
    (value.notePath === undefined ||
      (typeof value.notePath === "string" &&
        normalizeVaultPath(value.notePath) !== null))
  );
}

function retainedSnapshot(
  snapshot: JobSnapshot,
  maxEntries: number,
  maxAgeDays: number,
  now: number,
): JobSnapshot {
  const cutoff = now - maxAgeDays * 86400000;
  const retainedCompletions = new Set(
    snapshot.jobs
      .map((job, index) => ({ job, index }))
      .filter(({ job }) => job.state === "trashed" && job.updatedAt >= cutoff)
      .sort(
        (left, right) =>
          right.job.updatedAt - left.job.updatedAt || right.index - left.index,
      )
      .slice(0, maxEntries)
      .map(({ job }) => job.vaultPath),
  );
  return {
    jobs: snapshot.jobs.filter(
      (job) =>
        job.state !== "trashed" || retainedCompletions.has(job.vaultPath),
    ),
    logs: snapshot.logs
      .filter((entry) => entry.timestamp >= cutoff)
      .sort((left, right) => left.timestamp - right.timestamp)
      .slice(-maxEntries),
  };
}

/** Commit mutations in order; failed saves never publish partially durable state. */
export class JobStore {
  private data: JobSnapshot = { jobs: [], logs: [] };
  private tail: Promise<void> = Promise.resolve();
  private readonly subscribers = new Set<(snapshot: JobSnapshot) => void>();
  private readonly now: () => number;
  private readonly maxEntries: number;
  private readonly maxAgeDays: number;

  constructor(
    private readonly persistence: JobPersistence,
    options: JobStoreOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.maxEntries =
      options.historyMaxEntries ?? DEFAULT_SETTINGS.historyMaxEntries;
    this.maxAgeDays =
      options.historyMaxAgeDays ?? DEFAULT_SETTINGS.historyMaxAgeDays;
    if (
      !Number.isSafeInteger(this.maxEntries) ||
      this.maxEntries < 1 ||
      this.maxEntries > 500 ||
      !Number.isSafeInteger(this.maxAgeDays) ||
      this.maxAgeDays < 1 ||
      this.maxAgeDays > 30
    )
      throw new Error("Invalid history retention options.");
  }

  snapshot(): JobSnapshot {
    return clone(this.data);
  }

  subscribe(subscriber: (snapshot: JobSnapshot) => void): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  hydrate(): Promise<void> {
    return this.serialize(async () => {
      const loaded = await this.persistence.load();
      if (loaded === undefined || loaded === null) return;
      if (
        !object(loaded) ||
        !Array.isArray(loaded.jobs) ||
        !loaded.jobs.every(validJob) ||
        !Array.isArray(loaded.logs) ||
        !loaded.logs.every(validLog)
      )
        throw new Error("Invalid persisted job data.");
      const jobs = loaded.jobs.map((job) => ({
        ...clone(job),
        vaultPath: this.path(job.vaultPath),
      }));
      if (new Set(jobs.map((job) => job.vaultPath)).size !== jobs.length)
        throw new Error("Duplicate persisted job identity.");
      this.data = { jobs, logs: clone(loaded.logs) };
      this.notify();
    });
  }

  upsert(input: JobRecord): Promise<JobRecord> {
    // Capture before entering the asynchronous mutation queue.
    const record = clone(input);
    return this.mutate((draft) => {
      if (!validJob(record)) throw new Error("Invalid job record.");
      record.vaultPath = this.path(record.vaultPath);
      const index = draft.jobs.findIndex(
        (job) => job.vaultPath === record.vaultPath,
      );
      const previous = draft.jobs[index];
      if (previous && previous.state !== record.state)
        throw new Error("Use transition to change job state.");
      if (!previous && record.state !== "queued")
        throw new Error("New jobs must start queued.");
      if (previous) {
        this.preserveUrl(previous, record);
        record.createdAt = previous.createdAt;
        record.updatedAt = this.now();
        draft.jobs[index] = record;
      } else draft.jobs.push(record);
      return record;
    });
  }

  transition(
    path: string,
    state: JobState,
    patch: JobPatch = {},
    options: { acknowledgeUncertain?: boolean } = {},
  ): Promise<JobRecord> {
    const captured = clone(
      Object.fromEntries(
        [
          "fingerprint",
          "remoteUrl",
          "pendingSnapshotId",
          "rewrittenNotePaths",
          "rewrittenReferenceCount",
          "failure",
        ]
          .filter((key) => key in patch)
          .map((key) => [key, patch[key as keyof JobPatch]]),
      ),
    ) as JobPatch;
    const acknowledgeUncertain = options.acknowledgeUncertain === true;
    return this.mutate((draft) => {
      const job = draft.jobs.find((job) => job.vaultPath === this.path(path));
      if (!job) throw new Error("Job does not exist.");
      const retry =
        state === "queued" &&
        isTerminalState(job.state) &&
        job.failure?.retry !== "non-retryable" &&
        (job.state === "uncertain"
          ? acknowledgeUncertain
          : job.failure?.retry === "safe");
      const resume =
        job.state === "discovering-references" &&
        state === "rewriting" &&
        Boolean(job.remoteUrl);
      if (!(
        retry ||
        resume ||
        (!isTerminalState(job.state) &&
          (forward[job.state] === state || exits.includes(state)))
      ))
        throw new Error(`Illegal job transition: ${job.state} to ${state}.`);
      const next: JobRecord = {
        ...job,
        ...(retry ? {} : captured),
        state,
        updatedAt: this.now(),
      };
      this.preserveUrl(job, next);
      if (retry) delete next.failure;
      if (!validJob(next)) throw new Error("Invalid job update.");
      Object.assign(job, next);
      if (retry) delete job.failure;
      this.logFailure(draft, job);
      return job;
    });
  }

  appendLog(entry: LogEntry): Promise<void> {
    const captured = clone(entry);
    return this.mutate((draft) => {
      if (!validLog(captured)) throw new Error("Invalid log entry.");
      if (captured.vaultPath)
        captured.vaultPath = this.path(captured.vaultPath);
      draft.logs.push(captured);
    });
  }

  completeSnapshotCleanup(
    path: string,
    snapshotId: string,
  ): Promise<JobRecord> {
    return this.mutate((draft) => {
      const job = draft.jobs.find(
        (candidate) => candidate.vaultPath === this.path(path),
      );
      if (!job || job.pendingSnapshotId !== snapshotId)
        throw new Error("Snapshot cleanup checkpoint changed.");
      delete job.pendingSnapshotId;
      job.updatedAt = this.now();
      if (!validJob(job)) throw new Error("Invalid snapshot cleanup update.");
      return job;
    });
  }

  /** Begin a new content generation only after a strong hash proves that a
   * saved URL belongs to different bytes at the same Vault path. */
  resetChangedSourceGeneration(
    path: string,
    expectedPreviousSha256: string,
    fingerprint: SourceFingerprint,
  ): Promise<JobRecord> {
    const captured = clone(fingerprint);
    return this.mutate((draft) => {
      const index = draft.jobs.findIndex(
        (candidate) => candidate.vaultPath === this.path(path),
      );
      const previous = draft.jobs[index];
      if (
        !previous ||
        previous.state !== "discovering-references" ||
        !previous.remoteUrl ||
        previous.pendingSnapshotId ||
        previous.fingerprint?.sha256 !== expectedPreviousSha256 ||
        !captured?.sha256 ||
        captured.sha256 === expectedPreviousSha256
      )
        throw new Error("Source generation cannot be reset safely.");
      const timestamp = this.now();
      const next: JobRecord = {
        vaultPath: previous.vaultPath,
        state: "discovering-references",
        createdAt: timestamp,
        updatedAt: timestamp,
        fingerprint: captured,
        rewrittenNotePaths: [],
        rewrittenReferenceCount: 0,
      };
      if (!validJob(next)) throw new Error("Invalid replacement generation.");
      draft.jobs[index] = next;
      return next;
    });
  }

  /** Only a queue reservation with no existing worker may recover interrupted work.
   * Recovery preserves every upload/rewrite checkpoint and never bypasses terminal retry policy.
   */
  recoverInterrupted(path: string): Promise<JobRecord> {
    return this.mutate((draft) => {
      const job = draft.jobs.find(
        (candidate) => candidate.vaultPath === this.path(path),
      );
      if (
        !job ||
        ![
          "waiting-stable",
          "discovering-references",
          "uploading",
          "rewriting",
          "verifying",
          "deleting",
        ].includes(job.state)
      )
        throw new Error("Only interrupted in-flight jobs can be recovered.");
      if (job.state === "deleting") return job;
      const uncertain =
        job.state === "uploading" ||
        (!job.remoteUrl &&
          (job.state === "rewriting" ||
            job.state === "verifying" ||
            job.rewrittenReferenceCount > 0 ||
            job.rewrittenNotePaths.length > 0));
      job.state = uncertain ? "uncertain" : "queued";
      job.updatedAt = this.now();
      if (uncertain)
        job.failure = {
          code: "interrupted-upload",
          stage: "upload",
          message:
            "An interrupted upload requires acknowledgement before retrying.",
          retry: "uncertain",
        };
      else delete job.failure;
      this.logFailure(draft, job);
      return job;
    });
  }

  /** Replace a proven removed completion only when the same Vault path exists again. */
  resetTrashedGeneration(
    path: string,
    timestamp = this.now(),
  ): Promise<JobRecord> {
    if (!number(timestamp))
      return Promise.reject(new Error("Invalid timestamp."));
    return this.mutate((draft) => {
      const normalized = this.path(path);
      const index = draft.jobs.findIndex(
        (candidate) => candidate.vaultPath === normalized,
      );
      if (index < 0 || draft.jobs[index]!.state !== "trashed")
        throw new Error(
          "Only a trashed completion can start a new generation.",
        );
      const fresh: JobRecord = {
        vaultPath: normalized,
        state: "queued",
        createdAt: timestamp,
        updatedAt: timestamp,
        rewrittenNotePaths: [],
        rewrittenReferenceCount: 0,
      };
      draft.jobs[index] = fresh;
      return fresh;
    });
  }

  private logFailure(draft: JobSnapshot, job: JobRecord): void {
    if (!job.failure || !exits.includes(job.state)) return;
    draft.logs.push({
      timestamp: job.updatedAt,
      level:
        job.state === "skipped"
          ? "info"
          : job.state === "cancelled"
            ? "warn"
            : "error",
      stage: job.failure.stage,
      code: job.failure.code,
      message: job.failure.message,
      vaultPath: job.vaultPath,
      ...(job.failure.notePath === undefined
        ? {}
        : { notePath: job.failure.notePath }),
    });
  }

  prune(): Promise<void> {
    return this.mutate(() => {});
  }

  /** Clear only proven completions. Every record that may still map to a source remains. */
  clearTerminalHistory(): Promise<void> {
    return this.mutate((draft) => {
      const completed = new Set(
        draft.jobs
          .filter((job) => job.state === "trashed")
          .map((job) => job.vaultPath),
      );
      draft.jobs = draft.jobs.filter((job) => job.state !== "trashed");
      draft.logs = draft.logs.filter(
        (entry) => !entry.vaultPath || !completed.has(entry.vaultPath),
      );
    });
  }

  private path(path: string): string {
    const normalized = normalizeVaultPath(path);
    if (!normalized) throw new Error("Invalid Vault path.");
    return normalized;
  }

  private preserveUrl(previous: JobRecord, next: JobRecord): void {
    if (
      previous.remoteUrl &&
      next.remoteUrl &&
      previous.remoteUrl !== next.remoteUrl
    )
      throw new Error("A saved remote URL cannot be replaced.");
    if (previous.remoteUrl) next.remoteUrl = previous.remoteUrl;
    if (
      previous.pendingSnapshotId &&
      next.pendingSnapshotId &&
      previous.pendingSnapshotId !== next.pendingSnapshotId
    )
      throw new Error("A pending snapshot checkpoint cannot be replaced.");
    if (previous.pendingSnapshotId)
      next.pendingSnapshotId = previous.pendingSnapshotId;
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  private mutate<T>(operation: (draft: JobSnapshot) => T): Promise<T> {
    return this.serialize(async () => {
      const draft = this.snapshot();
      const result = operation(draft);
      const retained = retainedSnapshot(
        draft,
        this.maxEntries,
        this.maxAgeDays,
        this.now(),
      );
      await this.persistence.save(clone(retained));
      this.data = clone(retained);
      this.notify();
      return result === undefined ? result : clone(result);
    });
  }

  private notify(): void {
    for (const subscriber of this.subscribers) {
      try {
        // A void callback may still be async; observe its result without awaiting a view.
        void Promise.resolve(subscriber(this.snapshot())).catch(() => {});
      } catch {
        /* A view cannot invalidate a durable commit. */
      }
    }
  }
}
