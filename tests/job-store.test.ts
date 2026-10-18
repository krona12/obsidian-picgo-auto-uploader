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

  // Break: pruning old resumable/active jobs, or retaining more than the terminal count/age limit.
  it("prunes only terminal history using injected age and count limits", async () => {
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
      "newest.png",
    ]);
  });

  // Break: shared arrays/objects let a subscriber or adapter modify durable internal state.
  it("defensively clones writes, loads, subscribers, logs, and snapshots", async () => {
    const original = job();
    const persistence = memory();
    const store = new JobStore(persistence);
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
});
