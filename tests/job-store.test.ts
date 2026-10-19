import { describe, expect, it } from "vitest";
import type { JobRecord, JobState } from "../src/domain";
import {
  JobStore,
  type JobPersistence,
  type JobSnapshot,
} from "../src/job-store";

const job = (
  path = "attachments/a.png",
  state: JobState = "queued",
): JobRecord => ({
  vaultPath: path,
  state,
  createdAt: 0,
  updatedAt: 0,
  rewrittenNotePaths: [],
  rewrittenReferenceCount: 0,
});
function memory(
  initial?: JobSnapshot,
): JobPersistence & { saved?: JobSnapshot } {
  return {
    async load() {
      return initial;
    },
    async save(value) {
      this.saved = structuredClone(value);
    },
  };
}

describe("durable job store", () => {
  // Break: allowing skipped phases or letting upsert bypass the transition validator.
  it("normalizes identity and enforces every forward phase", async () => {
    const store = new JobStore(memory());
    await store.upsert(job("attachments\\a.png"));
    await expect(
      store.transition("attachments/a.png", "uploading"),
    ).rejects.toThrow();
    await expect(
      store.upsert(job("attachments/a.png", "trashed")),
    ).rejects.toThrow();
    for (const state of [
      "waiting-stable",
      "discovering-references",
      "uploading",
      "rewriting",
      "verifying",
      "trashed",
    ] as const)
      await store.transition("attachments/a.png", state);
    expect(store.snapshot().jobs).toMatchObject([
      { vaultPath: "attachments/a.png", state: "trashed" },
    ]);
    await expect(
      store.transition("attachments/a.png", "uploading"),
    ).rejects.toThrow();
  });

  // Break: jumping over upload without a durable URL, or losing resumable metadata on retry/restart.
  it("permits resume only with a saved URL and preserves progress through safe retry", async () => {
    const persistence = memory();
    const store = new JobStore(persistence, { now: () => 123 });
    await store.upsert(job());
    await store.transition("attachments/a.png", "waiting-stable");
    await store.transition("attachments/a.png", "discovering-references");
    await expect(
      store.transition("attachments/a.png", "rewriting"),
    ).rejects.toThrow();
    await store.upsert({
      ...store.snapshot().jobs[0]!,
      remoteUrl: "https://cdn.test/a.png",
      fingerprint: { size: 10, mtime: 20 },
      rewrittenNotePaths: ["note.md"],
      rewrittenReferenceCount: 2,
    });
    await store.transition("attachments/a.png", "rewriting");
    await store.transition("attachments/a.png", "failed", {
      failure: {
        code: "write",
        stage: "rewrite",
        message: "Write failed",
        retry: "safe",
      },
    });
    await store.transition("attachments/a.png", "queued", {
      fingerprint: { size: 0, mtime: 0 },
      rewrittenNotePaths: [],
      rewrittenReferenceCount: 0,
    });
    const restarted = new JobStore(memory(persistence.saved));
    await restarted.hydrate();
    expect(restarted.snapshot().jobs[0]).toEqual({
      ...job(),
      updatedAt: 123,
      remoteUrl: "https://cdn.test/a.png",
      fingerprint: { size: 10, mtime: 20 },
      rewrittenNotePaths: ["note.md"],
      rewrittenReferenceCount: 2,
    });
  });

  // Break: pruning source tombstones, or retaining more than the completion count/age limit.
  it("prunes only completed history using injected age and count limits", async () => {
    const day = 86400000;
    const initial = {
      jobs: [
        { ...job("active.png"), updatedAt: 0 },
        { ...job("resume.png", "failed"), remoteUrl: "https://cdn.test/a.png" },
        job("old.png", "failed"),
        { ...job("recent.png", "trashed"), updatedAt: 39 * day },
        { ...job("newest.png", "skipped"), updatedAt: 40 * day },
      ],
      logs: [],
    };
    const store = new JobStore(memory(initial), {
      now: () => 40 * day,
      historyMaxEntries: 1,
      historyMaxAgeDays: 30,
    });
    await store.hydrate();
    await store.prune();
    expect(store.snapshot().jobs.map((item) => item.vaultPath)).toEqual([
      "active.png",
      "resume.png",
      "old.png",
      "recent.png",
      "newest.png",
    ]);
  });

  it("applies retention only to trashed completions and never expires source tombstones", async () => {
    const day = 86400000;
    const failure = (retry: "safe" | "uncertain" | "non-retryable") => ({
      code: "retained",
      stage: "upload" as const,
      message: "Safe message.",
      retry,
    });
    const tombstones: JobRecord[] = [
      { ...job("failed.png", "failed"), failure: failure("safe") },
      { ...job("skipped.png", "skipped"), failure: failure("non-retryable") },
      { ...job("uncertain.png", "uncertain"), failure: failure("uncertain") },
      { ...job("cancelled.png", "cancelled"), failure: failure("safe") },
    ];
    const completions = [
      {
        ...job("old-complete.png", "trashed"),
        updatedAt: 1,
        remoteUrl: "https://cdn.test/old.png",
      },
      {
        ...job("recent-complete.png", "trashed"),
        updatedAt: 40 * day,
        remoteUrl: "https://cdn.test/recent.png",
      },
    ];
    const store = new JobStore(
      memory({ jobs: [...tombstones, ...completions], logs: [] }),
      {
        now: () => 40 * day,
        historyMaxEntries: 1,
        historyMaxAgeDays: 30,
      },
    );
    await store.hydrate();
    await store.prune();
    expect(store.snapshot().jobs.map((item) => item.vaultPath)).toEqual([
      "failed.png",
      "skipped.png",
      "uncertain.png",
      "cancelled.png",
      "recent-complete.png",
    ]);
  });

  it("enforces age and count retention during ordinary mutations", async () => {
    const day = 86400000;
    const tombstones = [
      job("failed.png", "failed"),
      job("uncertain.png", "uncertain"),
      job("skipped.png", "skipped"),
      job("cancelled.png", "cancelled"),
    ];
    const persistence = memory({
      jobs: [
        ...tombstones,
        { ...job("old-complete.png", "trashed"), updatedAt: 0 },
        { ...job("recent-complete.png", "trashed"), updatedAt: 40 * day },
      ],
      logs: [
        {
          timestamp: 0,
          level: "info",
          stage: "trash",
          code: "old",
          message: "Old.",
        },
        {
          timestamp: 40 * day,
          level: "warn",
          stage: "lifecycle",
          code: "recent",
          message: "Recent.",
        },
      ],
    });
    const store = new JobStore(persistence, {
      now: () => 40 * day,
      historyMaxEntries: 1,
      historyMaxAgeDays: 30,
    });
    await store.hydrate();
    await store.appendLog({
      timestamp: 40 * day + 1,
      level: "info",
      stage: "lifecycle",
      code: "new",
      message: "New.",
    });
    expect(store.snapshot().jobs).toEqual([
      ...tombstones,
      expect.objectContaining({ vaultPath: "recent-complete.png" }),
    ]);
    expect(store.snapshot().logs).toEqual([
      expect.objectContaining({ code: "new" }),
    ]);
  });

  it("does not publish retention pruning when the enclosing save fails", async () => {
    const initial: JobSnapshot = {
      jobs: [
        job("failed.png", "failed"),
        { ...job("old-complete.png", "trashed"), updatedAt: 0 },
      ],
      logs: [
        {
          timestamp: 0,
          level: "info",
          stage: "trash",
          code: "old",
          message: "Old.",
        },
      ],
    };
    const store = new JobStore(
      {
        async load() {
          return initial;
        },
        async save() {
          throw new Error("disk");
        },
      },
      { now: () => 40 * 86400000, historyMaxEntries: 1 },
    );
    await store.hydrate();
    await expect(
      store.appendLog({
        timestamp: 40 * 86400000,
        level: "info",
        stage: "lifecycle",
        code: "new",
        message: "New.",
      }),
    ).rejects.toThrow("disk");
    expect(store.snapshot()).toEqual(initial);
  });

  // Break: shared arrays/objects let a subscriber or adapter modify durable internal state.
  it("defensively clones writes, loads, subscribers, logs, and snapshots", async () => {
    const original = job();
    const persistence = memory();
    const store = new JobStore(persistence, { now: () => 0 });
    store.subscribe((snapshot) => {
      snapshot.jobs[0]?.rewrittenNotePaths.push("attacker.md");
    });
    await store.upsert(original);
    original.rewrittenNotePaths.push("caller.md");
    persistence.saved!.jobs[0]!.rewrittenNotePaths.push("adapter.md");
    store.snapshot().jobs[0]!.rewrittenNotePaths.push("reader.md");
    const log = {
      timestamp: 0,
      level: "warn" as const,
      stage: "stability" as const,
      code: "locked",
      message: "Locked",
    };
    await store.appendLog(log);
    log.message = "changed";
    expect(store.snapshot().jobs[0]!.rewrittenNotePaths).toEqual([]);
    expect(store.snapshot().logs[0]!.message).toBe("Locked");
    const loaded = { jobs: [job("loaded.png")], logs: [] };
    const restarted = new JobStore(memory(loaded));
    await restarted.hydrate();
    loaded.jobs[0]!.rewrittenNotePaths.push("outside.md");
    expect(restarted.snapshot().jobs[0]!.rewrittenNotePaths).toEqual([]);
  });

  // Break: concurrent saves finish out of order, or a failed save poisons subsequent writes.
  it("serializes saves and publishes only committed snapshots", async () => {
    let release!: () => void;
    let saves = 0;
    let durable: JobSnapshot | undefined;
    const store = new JobStore({
      async load() {
        return undefined;
      },
      async save(snapshot) {
        saves++;
        if (saves === 1)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        durable = snapshot;
      },
    });
    const first = store.upsert(job("first.png"));
    const second = store.upsert(job("second.png"));
    await Promise.resolve();
    expect(saves).toBe(1);
    expect(store.snapshot().jobs).toEqual([]);
    release();
    await Promise.all([first, second]);
    expect(durable!.jobs.map((item) => item.vaultPath)).toEqual([
      "first.png",
      "second.png",
    ]);
  });

  it("rolls back a failed save and continues accepting later mutations", async () => {
    let fail = true;
    const store = new JobStore({
      async load() {
        return undefined;
      },
      async save() {
        if (fail) throw new Error("disk");
      },
    });
    await expect(store.upsert(job("lost.png"))).rejects.toThrow("disk");
    expect(store.snapshot().jobs).toEqual([]);
    fail = false;
    await store.upsert(job("saved.png"));
    expect(store.snapshot().jobs.map((item) => item.vaultPath)).toEqual([
      "saved.png",
    ]);
  });

  // Break: metadata writes clear an established URL or subscriber exceptions reject committed writes.
  it("retains established URLs and isolates subscriber exceptions", async () => {
    const store = new JobStore(memory());
    store.subscribe(() => {
      throw new Error("view");
    });
    await store.upsert({ ...job(), remoteUrl: "https://cdn.test/a.png" });
    await store.upsert(job());
    expect(store.snapshot().jobs[0]!.remoteUrl).toBe("https://cdn.test/a.png");
    await expect(
      store.upsert({ ...job(), remoteUrl: "https://cdn.test/b.png" }),
    ).rejects.toThrow();
  });

  // Break: a rejected async observer escapes notification delivery as an unhandled rejection.
  it("consumes async subscriber rejections without failing durable mutations", async () => {
    const persistence = memory();
    const store = new JobStore(persistence);
    const observed: JobState[] = [];
    store.subscribe(async () => {
      await Promise.resolve();
      throw new Error("async view failed");
    });
    store.subscribe((snapshot) => {
      observed.push(snapshot.jobs[0]!.state);
    });

    await expect(store.upsert(job())).resolves.toMatchObject({
      state: "queued",
    });
    await expect(
      store.transition("attachments/a.png", "waiting-stable"),
    ).resolves.toMatchObject({ state: "waiting-stable" });
    // Cross the rejection-reporting turn: Vitest fails this test run if any observer rejection escapes.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(persistence.saved!.jobs[0]!.state).toBe("waiting-stable");
    expect(store.snapshot().jobs[0]!.state).toBe("waiting-stable");
    expect(observed).toEqual(["queued", "waiting-stable"]);
  });

  it("rejects malformed persisted records and invalid Vault identities", async () => {
    const store = new JobStore(memory());
    await expect(store.upsert(job("../escape.png"))).rejects.toThrow();
    const bad = new JobStore({
      async load() {
        return { jobs: [{ ...job(), state: "invented" }], logs: [] };
      },
      async save() {},
    });
    await expect(bad.hydrate()).rejects.toThrow();
    expect(bad.snapshot().jobs).toEqual([]);
  });

  // Break: a runtime patch can overwrite identity/state or inject a URL to bypass the durable resume guard.
  it("accepts only metadata fields from a transition patch", async () => {
    const store = new JobStore(memory());
    await store.upsert(job());
    await store.transition("attachments/a.png", "waiting-stable", {
      vaultPath: "changed.png",
      createdAt: 999,
      state: "trashed",
      remoteUrl: "https://cdn.test/a.png",
    } as Parameters<JobStore["transition"]>[2]);
    expect(store.snapshot().jobs[0]).toMatchObject({
      vaultPath: "attachments/a.png",
      createdAt: 0,
      state: "waiting-stable",
      remoteUrl: "https://cdn.test/a.png",
    });
  });

  // Break: terminal retries bypass acknowledgement/classification at the store boundary.
  it("validates retry classification and explicit uncertainty acknowledgement itself", async () => {
    const source = {
      ...job("a.png", "uncertain"),
      failure: {
        code: "timeout",
        stage: "upload" as const,
        message: "Timeout",
        retry: "uncertain" as const,
      },
    };
    const store = new JobStore(
      memory({
        jobs: [
          source,
          {
            ...job("b.png", "failed"),
            failure: { ...source.failure, retry: "non-retryable" },
          },
        ],
        logs: [],
      }),
    );
    await store.hydrate();
    await expect(store.transition("a.png", "queued")).rejects.toThrow();
    await expect(
      store.transition("b.png", "queued", {}, { acknowledgeUncertain: true }),
    ).rejects.toThrow();
    await store.transition(
      "a.png",
      "queued",
      {},
      { acknowledgeUncertain: true },
    );
    expect(store.snapshot().jobs[0]).toMatchObject({ state: "queued" });
    expect(store.snapshot().jobs[0]!.failure).toBeUndefined();
  });

  it("retains exactly 500 recent terminal entries by default", async () => {
    const jobs = Array.from({ length: 501 }, (_, index) => ({
      ...job(`a${index}.png`, "trashed"),
      updatedAt: index,
    }));
    const store = new JobStore(memory({ jobs, logs: [] }), { now: () => 501 });
    await store.hydrate();
    await store.prune();
    expect(store.snapshot().jobs).toHaveLength(500);
    expect(store.snapshot().jobs[0]!.vaultPath).toBe("a1.png");
  });

  it.each([
    "waiting-stable",
    "discovering-references",
    "rewriting",
    "verifying",
  ] as const)(
    "explicitly recovers interrupted %s without altering durable checkpoints",
    async (state) => {
      const original = {
        ...job("attachments/a.png", state),
        remoteUrl: "https://cdn.test/a.png",
        fingerprint: { size: 10, mtime: 20 },
        rewrittenNotePaths: ["one.md", "two.md"],
        rewrittenReferenceCount: 3,
      };
      const persistence = memory({ jobs: [original], logs: [] });
      const store = new JobStore(persistence, { now: () => 100 });
      await store.hydrate();
      await expect(
        store.transition(original.vaultPath, "queued"),
      ).rejects.toThrow();
      await store.recoverInterrupted(original.vaultPath);
      expect(persistence.saved?.jobs[0]).toEqual({
        ...original,
        state: "queued",
        updatedAt: 100,
      });
    },
  );
  it.each(["uploading", "rewriting", "verifying"] as const)(
    "makes interrupted %s without a URL uncertain rather than risking duplicate upload",
    async (state) => {
      const persistence = memory({
        jobs: [job("attachments/a.png", state)],
        logs: [],
      });
      const store = new JobStore(persistence);
      await store.hydrate();
      await store.recoverInterrupted("attachments/a.png");
      expect(store.snapshot().jobs[0]).toMatchObject({
        state: "uncertain",
        failure: { stage: "upload", retry: "uncertain" },
      });
      await expect(
        store.transition("attachments/a.png", "queued"),
      ).rejects.toThrow();
    },
  );
  it.each([
    "queued",
    "failed",
    "uncertain",
    "skipped",
    "cancelled",
    "trashed",
  ] as const)(
    "cannot use interrupted recovery to bypass retry policy for %s",
    async (state) => {
      const persistence = memory({
        jobs: [job("attachments/a.png", state)],
        logs: [],
      });
      const store = new JobStore(persistence);
      await store.hydrate();
      await expect(
        store.recoverInterrupted("attachments/a.png"),
      ).rejects.toThrow();
      expect(store.snapshot().jobs[0]?.state).toBe(state);
    },
  );
  it("failed recovery saves do not publish a queued state or lose checkpoints", async () => {
    const original = {
      ...job("attachments/a.png", "rewriting"),
      remoteUrl: "https://cdn.test/a.png",
      fingerprint: { size: 2, mtime: 3 },
      rewrittenNotePaths: ["note.md"],
      rewrittenReferenceCount: 1,
    };
    const store = new JobStore({
      async load() {
        return { jobs: [original], logs: [] };
      },
      async save() {
        throw new Error("disk");
      },
    });
    await store.hydrate();
    await expect(store.recoverInterrupted(original.vaultPath)).rejects.toThrow(
      "disk",
    );
    expect(store.snapshot().jobs[0]).toEqual(original);
  });
  it("resets only a proven trashed path as a fresh attachment generation", async () => {
    const completed = {
      ...job("attachments/a.png", "trashed"),
      createdAt: 1,
      updatedAt: 2,
      fingerprint: { size: 4, mtime: 9 },
      remoteUrl: "https://cdn.test/old.png",
      rewrittenNotePaths: ["old.md"],
      rewrittenReferenceCount: 3,
      failure: {
        code: "old",
        stage: "trash" as const,
        message: "Old generation.",
        retry: "safe" as const,
      },
    };
    const persistence = memory({ jobs: [completed], logs: [] });
    const store = new JobStore(persistence);
    await store.hydrate();
    await store.resetTrashedGeneration(completed.vaultPath, 100);
    expect(store.snapshot().jobs).toEqual([
      {
        vaultPath: completed.vaultPath,
        state: "queued",
        createdAt: 100,
        updatedAt: 100,
        rewrittenNotePaths: [],
        rewrittenReferenceCount: 0,
      },
    ]);
    expect(persistence.saved).toEqual(store.snapshot());
  });
  it.each(["failed", "uncertain", "skipped", "cancelled", "queued"] as const)(
    "never resets a %s tombstone or active job as a new generation",
    async (state) => {
      const original = job("attachments/a.png", state);
      const store = new JobStore(memory({ jobs: [original], logs: [] }));
      await store.hydrate();
      await expect(
        store.resetTrashedGeneration(original.vaultPath, 100),
      ).rejects.toThrow();
      expect(store.snapshot().jobs).toEqual([original]);
    },
  );
  it("rolls back a new-generation reset when persistence fails", async () => {
    const original = {
      ...job("attachments/a.png", "trashed"),
      remoteUrl: "https://cdn.test/old.png",
    };
    const store = new JobStore({
      async load() {
        return { jobs: [original], logs: [] };
      },
      async save() {
        throw new Error("disk");
      },
    });
    await store.hydrate();
    await expect(
      store.resetTrashedGeneration(original.vaultPath, 100),
    ).rejects.toThrow("disk");
    expect(store.snapshot().jobs).toEqual([original]);
  });
  it.each([
    ["skipped", "info"],
    ["failed", "error"],
    ["uncertain", "error"],
    ["cancelled", "warn"],
  ] as const)(
    "atomically logs each %s transition exactly once at %s level",
    async (state, level) => {
      const persistence = memory();
      const store = new JobStore(persistence, { now: () => 200 });
      await store.upsert(job());
      const failure = {
        code: "safe-code",
        stage: "upload" as const,
        message: "Safe failure message.",
        retry:
          state === "uncertain" ? ("uncertain" as const) : ("safe" as const),
      };
      await store.transition("attachments/a.png", state, { failure });
      expect(persistence.saved).toMatchObject({
        jobs: [{ state, failure }],
        logs: [
          {
            timestamp: 200,
            level,
            stage: "upload",
            code: "safe-code",
            message: "Safe failure message.",
            vaultPath: "attachments/a.png",
          },
        ],
      });
      await expect(
        store.transition("attachments/a.png", state, { failure }),
      ).rejects.toThrow();
      expect(store.snapshot().logs).toHaveLength(1);
    },
  );
  it("atomically logs recovery uncertainty without uploading or duplicating on repeated recovery", async () => {
    const store = new JobStore(
      memory({ jobs: [job("attachments/a.png", "uploading")], logs: [] }),
    );
    await store.hydrate();
    await store.recoverInterrupted("attachments/a.png");
    expect(store.snapshot().logs).toMatchObject([
      {
        level: "error",
        stage: "upload",
        code: "interrupted-upload",
        vaultPath: "attachments/a.png",
      },
    ]);
    await expect(
      store.recoverInterrupted("attachments/a.png"),
    ).rejects.toThrow();
    expect(store.snapshot().logs).toHaveLength(1);
  });
  it("an interrupted uploading state stays uncertain even if a URL was already present", async () => {
    const original = {
      ...job("attachments/a.png", "uploading"),
      remoteUrl: "https://cdn.test/a.png",
      fingerprint: { size: 1, mtime: 2 },
      rewrittenNotePaths: ["note.md"],
      rewrittenReferenceCount: 1,
    };
    const store = new JobStore(memory({ jobs: [original], logs: [] }));
    await store.hydrate();
    await store.recoverInterrupted(original.vaultPath);
    expect(store.snapshot().jobs[0]).toMatchObject({
      ...original,
      state: "uncertain",
      updatedAt: expect.any(Number),
      failure: { retry: "uncertain" },
    });
  });
  it("pre-upload state with rewrite evidence but no saved URL is uncertain", async () => {
    const store = new JobStore(
      memory({
        jobs: [
          {
            ...job("attachments/a.png", "discovering-references"),
            rewrittenReferenceCount: 1,
            rewrittenNotePaths: ["note.md"],
          },
        ],
        logs: [],
      }),
    );
    await store.hydrate();
    await store.recoverInterrupted("attachments/a.png");
    expect(store.snapshot().jobs[0]).toMatchObject({
      state: "uncertain",
      failure: { retry: "uncertain" },
    });
  });
  it("does not publish either a terminal state or its failure log when the atomic save fails", async () => {
    const original = job("attachments/a.png", "uploading");
    const store = new JobStore({
      async load() {
        return { jobs: [original], logs: [] };
      },
      async save() {
        throw new Error("disk");
      },
    });
    await store.hydrate();
    await expect(
      store.transition(original.vaultPath, "uncertain", {
        failure: {
          code: "timeout",
          stage: "upload",
          message: "Upload was interrupted.",
          retry: "uncertain",
        },
      }),
    ).rejects.toThrow("disk");
    expect(store.snapshot()).toEqual({ jobs: [original], logs: [] });
  });
  it("clears only trashed completion history and retains every source safety tombstone", async () => {
    const completed = job("attachments/completed.png", "trashed");
    const failed = {
      ...job("attachments/failed.png", "failed"),
      failure: {
        code: "write-failed",
        stage: "rewrite" as const,
        message: "Safe message.",
        retry: "safe" as const,
      },
    };
    const uncertain = {
      ...job("attachments/uncertain.png", "uncertain"),
      failure: {
        code: "timeout",
        stage: "upload" as const,
        message: "Safe message.",
        retry: "uncertain" as const,
      },
    };
    const resumable = {
      ...job("attachments/resumable.png", "rewriting"),
      remoteUrl: "https://cdn.test/resumable.png",
    };
    const persistence = memory({
      jobs: [completed, failed, uncertain, resumable],
      logs: [
        {
          timestamp: 1,
          level: "info",
          stage: "trash",
          code: "done",
          message: "Done.",
          vaultPath: completed.vaultPath,
        },
        {
          timestamp: 2,
          level: "error",
          stage: "rewrite",
          code: "write-failed",
          message: "Safe message.",
          vaultPath: failed.vaultPath,
        },
      ],
    });
    const store = new JobStore(persistence, { now: () => 2 });
    await store.hydrate();
    await store.clearTerminalHistory();
    expect(store.snapshot()).toEqual({
      jobs: [failed, uncertain, resumable],
      logs: [expect.objectContaining({ vaultPath: failed.vaultPath })],
    });
    expect(persistence.saved).toEqual(store.snapshot());
  });
});
