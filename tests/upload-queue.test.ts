import { describe, expect, it } from "vitest";
import type { JobRecord, JobState, RetryClassification } from "../src/domain";
import { JobStore } from "../src/job-store";
import { UploadQueue } from "../src/upload-queue";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const record = (
  vaultPath: string,
  state: JobState,
  retry: RetryClassification,
): JobRecord => ({
  vaultPath,
  state,
  createdAt: 0,
  updatedAt: 0,
  remoteUrl: "https://cdn.test/a.png",
  fingerprint: { size: 4, mtime: 2 },
  rewrittenNotePaths: ["note.md"],
  rewrittenReferenceCount: 1,
  failure: { code: "failure", stage: "upload", message: "Failed", retry },
});
function store(jobs: JobRecord[] = []) {
  return new JobStore({
    async load() {
      return { jobs, logs: [] };
    },
    async save() {},
  });
}

describe("sequential upload queue", () => {
  // Break: paths are compared before normalization or two workers run concurrently.
  it("deduplicates normalized active paths and processes jobs strictly in order", async () => {
    const jobs = store();
    const started = deferred();
    const release = deferred();
    const order: string[] = [];
    const queue = new UploadQueue(jobs, async (job) => {
      order.push(job.vaultPath);
      expect(job.state).toBe("waiting-stable");
      if (job.vaultPath === "attachments/a.png") {
        started.resolve();
        await release.promise;
      }
      await jobs.transition(job.vaultPath, "skipped");
    });
    await queue.enqueue("attachments\\a.png");
    await started.promise;
    expect(await queue.enqueue("attachments/./a.png")).toEqual({
      ok: true,
      value: "duplicate",
    });
    await queue.enqueue("attachments/b.png");
    expect(order).toEqual(["attachments/a.png"]);
    release.resolve();
    await queue.drain();
    expect(order).toEqual(["attachments/a.png", "attachments/b.png"]);
  });

  // Break: checking capacity asynchronously lets simultaneous events exceed the 1,000 path cap.
  it("explicitly rejects overflow at the default bound, including reservations", async () => {
    const jobs = store();
    const release = deferred();
    const queue = new UploadQueue(jobs, async () => {
      await release.promise;
    });
    const accepted = Array.from({ length: 1000 }, (_, index) =>
      queue.enqueue(`a${index}.png`),
    );
    expect(await queue.enqueue("overflow.png")).toMatchObject({
      ok: false,
      error: { code: "queue-full" },
    });
    expect(await queue.enqueue("a0.png")).toEqual({
      ok: true,
      value: "duplicate",
    });
    await Promise.all(accepted);
    release.resolve();
    await queue.cancelPending();
    await queue.drain();
  }, 15000);

  // Break: cancellation starts waiting jobs or overwrites post-dispatch uncertainty.
  it("cancels pending jobs and lets active upload uncertainty take precedence", async () => {
    const jobs = store();
    const started = deferred();
    const ran: string[] = [];
    const queue = new UploadQueue(jobs, async (job, signal) => {
      ran.push(job.vaultPath);
      await jobs.transition(job.vaultPath, "discovering-references");
      await jobs.transition(job.vaultPath, "uploading");
      started.resolve();
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      await jobs.transition(job.vaultPath, "uncertain", {
        failure: {
          code: "aborted",
          stage: "upload",
          message: "Dispatched",
          retry: "uncertain",
        },
      });
    });
    await queue.enqueue("a.png");
    await started.promise;
    await queue.enqueue("b.png");
    await queue.cancelPending();
    await queue.drain();
    expect(ran).toEqual(["a.png"]);
    expect(jobs.snapshot().jobs.map((job) => job.state)).toEqual([
      "uncertain",
      "cancelled",
    ]);
  });

  it("cancels work still awaiting its first persistence write", async () => {
    const saving = deferred();
    const release = deferred();
    let first = true;
    const jobs = new JobStore({
      async load() {
        return undefined;
      },
      async save() {
        if (first) {
          first = false;
          saving.resolve();
          await release.promise;
        }
      },
    });
    let ran = false;
    const queue = new UploadQueue(jobs, async () => {
      ran = true;
    });
    const enqueue = queue.enqueue("a.png");
    await saving.promise;
    const cancelled = queue.cancelPending();
    release.resolve();
    await enqueue;
    await cancelled;
    expect(ran).toBe(false);
    expect(jobs.snapshot().jobs[0]!.state).toBe("cancelled");
  });

  // Break: bulk retry reuploads uncertain/non-retryable work or clears saved rewrite progress.
  it("bulk retries only safe failures and requires acknowledgement for uncertainty", async () => {
    const jobs = store([
      record("safe.png", "failed", "safe"),
      record("uncertain.png", "uncertain", "uncertain"),
      record("never.png", "failed", "non-retryable"),
    ]);
    await jobs.hydrate();
    const seen: JobRecord[] = [];
    const queue = new UploadQueue(jobs, async (job) => {
      seen.push(job);
      await jobs.transition(job.vaultPath, "skipped");
    });
    await queue.retrySafeFailures();
    await queue.drain();
    expect(seen.map((job) => job.vaultPath)).toEqual(["safe.png"]);
    expect(seen[0]).toMatchObject({
      remoteUrl: "https://cdn.test/a.png",
      fingerprint: { size: 4, mtime: 2 },
      rewrittenNotePaths: ["note.md"],
      rewrittenReferenceCount: 1,
    });
    expect(seen[0]!.failure).toBeUndefined();
    expect(await queue.retry("uncertain.png")).toMatchObject({ ok: false });
    expect(
      await queue.retry("never.png", { acknowledgeUncertain: true }),
    ).toMatchObject({ ok: false });
    expect(
      await queue.retry("uncertain.png", { acknowledgeUncertain: true }),
    ).toEqual({ ok: true, value: "enqueued" });
    await queue.drain();
    expect(seen.map((job) => job.vaultPath)).toEqual([
      "safe.png",
      "uncertain.png",
    ]);
  });

  // Break: a rejected worker kills the runner, leaves drain hanging, or classifies a dispatched error as safe.
  it("settles throwing workers conservatively and continues the next job", async () => {
    const jobs = store();
    const queue = new UploadQueue(jobs, async (job) => {
      if (job.vaultPath === "a.png") {
        await jobs.transition(job.vaultPath, "discovering-references");
        await jobs.transition(job.vaultPath, "uploading");
        throw new Error("secret must not be stored");
      }
      await jobs.transition(job.vaultPath, "skipped");
    });
    await queue.enqueue("a.png");
    await queue.enqueue("b.png");
    await queue.drain();
    expect(jobs.snapshot().jobs).toMatchObject([
      { state: "uncertain", failure: { retry: "uncertain" } },
      { state: "skipped" },
    ]);
    expect(JSON.stringify(jobs.snapshot())).not.toContain("secret");
  });

  it("drains only the work known at invocation time", async () => {
    const jobs = store();
    const releaseA = deferred();
    const startedB = deferred();
    const releaseB = deferred();
    const queue = new UploadQueue(jobs, async (job) => {
      if (job.vaultPath === "a.png") await releaseA.promise;
      else {
        startedB.resolve();
        await releaseB.promise;
      }
      await jobs.transition(job.vaultPath, "skipped");
    });
    await queue.enqueue("a.png");
    const drained = queue.drain();
    await queue.enqueue("b.png");
    releaseA.resolve();
    await drained;
    await startedB.promise;
    expect(jobs.snapshot().jobs[1]!.state).toBe("waiting-stable");
    releaseB.resolve();
    await queue.drain();
  });

  it("rejects unsafe paths and does not rerun terminal jobs on duplicate events", async () => {
    const jobs = store([record("done.png", "trashed", "non-retryable")]);
    await jobs.hydrate();
    let ran = false;
    const queue = new UploadQueue(jobs, async () => {
      ran = true;
    });
    expect(await queue.enqueue("../escape.png")).toMatchObject({
      ok: false,
      error: { code: "invalid-path" },
    });
    expect(await queue.enqueue("done.png")).toEqual({
      ok: true,
      value: "duplicate",
    });
    await queue.drain();
    expect(ran).toBe(false);
  });

  // Break: plugin unload allows a newly enqueued event to sneak into worker dispatch after cancellation.
  it("aborts an active pre-upload worker without changing it to uncertain", async () => {
    const jobs = store();
    const started = deferred();
    const queue = new UploadQueue(jobs, async (_job, signal) => {
      started.resolve();
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      throw new Error("aborted");
    });
    await queue.enqueue("a.png");
    await started.promise;
    await queue.cancelPending();
    expect(jobs.snapshot().jobs[0]).toMatchObject({
      state: "cancelled",
      failure: { retry: "non-retryable" },
    });
  });

  // Break: failed durable reservations still dispatch, or their rejection kills the next job.
  it("never dispatches a job whose initial save fails", async () => {
    let first = true;
    const jobs = new JobStore({
      async load() {
        return undefined;
      },
      async save() {
        if (first) {
          first = false;
          throw new Error("disk");
        }
      },
    });
    const ran: string[] = [];
    const queue = new UploadQueue(jobs, async (job) => {
      ran.push(job.vaultPath);
      await jobs.transition(job.vaultPath, "skipped");
    });
    expect(await queue.enqueue("a.png")).toMatchObject({
      ok: false,
      error: { code: "persistence-failure" },
    });
    await queue.enqueue("b.png");
    await queue.drain();
    expect(ran).toEqual(["b.png"]);
  });

  // Break: queue timestamps depend on the wall clock rather than the injected clock.
  it("uses injected time when creating durable jobs", async () => {
    const jobs = store();
    const queue = new UploadQueue(
      jobs,
      async (job) => {
        await jobs.transition(job.vaultPath, "skipped");
      },
      { now: () => 123 },
    );
    await queue.enqueue("a.png");
    await queue.drain();
    expect(jobs.snapshot().jobs[0]!.createdAt).toBe(123);
  });

  // Break: cancelled pending history waits for a slow active worker before recording cancellation.
  it("durably cancels pending entries while an aborted active worker is still settling", async () => {
    const jobs = store();
    const started = deferred();
    const release = deferred();
    const pendingCancelled = deferred();
    jobs.subscribe((snapshot) => {
      if (
        snapshot.jobs.some(
          (job) => job.vaultPath === "b.png" && job.state === "cancelled",
        )
      )
        pendingCancelled.resolve();
    });
    const queue = new UploadQueue(jobs, async () => {
      started.resolve();
      await release.promise;
    });
    await queue.enqueue("a.png");
    await started.promise;
    await queue.enqueue("b.png");
    const cancellation = queue.cancelPending();
    await pendingCancelled.promise;
    expect(jobs.snapshot().jobs[1]!.state).toBe("cancelled");
    release.resolve();
    await cancellation;
  });

  // Break: concurrent lifecycle cancellation races produce an illegal duplicate terminal transition.
  it("makes simultaneous cancellation requests idempotent", async () => {
    const jobs = store();
    const started = deferred();
    const release = deferred();
    const queue = new UploadQueue(jobs, async () => {
      started.resolve();
      await release.promise;
    });
    await queue.enqueue("a.png");
    await started.promise;
    await queue.enqueue("b.png");
    const cancelled = Promise.all([
      queue.cancelPending(),
      queue.cancelPending(),
    ]);
    release.resolve();
    await expect(cancelled).resolves.toEqual([undefined, undefined]);
    expect(jobs.snapshot().jobs.map((job) => job.state)).toEqual([
      "cancelled",
      "cancelled",
    ]);
  });
});
