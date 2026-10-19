import { afterEach, describe, expect, it, vi } from "vitest";
import { AutoUploaderController } from "../src/obsidian/controller";
import { fixture } from "./task5-fixture";
import type { JobSnapshot, JobStoreOptions } from "../src/job-store";
import type { JobRecord, JobState } from "../src/domain";

afterEach(() => vi.useRealTimers());
function setup(
  enabled = true,
  initial?: JobSnapshot,
  storeOptions?: JobStoreOptions,
) {
  const f = fixture(initial, storeOptions);
  f.settings.enabled = enabled;
  const controller = new AutoUploaderController({
    settings: f.settings,
    store: f.store,
    queue: f.queue,
    lifecycle: f.lifecycle,
  });
  return { ...f, controller };
}
describe("controller lifecycle", () => {
  it("starts automatic scan only at layout ready and exposes immutable aggregates", async () => {
    const f = setup();
    f.controller.start();
    await f.queue.drain();
    expect(f.uploads()).toBe(0);
    f.ready();
    await f.controller.scanNow();
    await f.queue.drain();
    expect(f.uploads()).toBe(1);
    const view = f.controller.snapshot();
    expect(view.counts.trashed).toBe(1);
    expect(view.lastScan?.eligible).toBe(1);
    expect(Object.isFrozen(view.jobs)).toBe(true);
    expect(JSON.stringify(view)).not.toContain("private-secret");
    await f.controller.stop();
  });
  it("debounces duplicate create/modify paths until their quiet period expires", async () => {
    vi.useFakeTimers();
    const f = setup();
    f.files.splice(f.files.indexOf(f.source), 1);
    f.controller.start();
    f.ready();
    await f.controller.scanNow();
    f.files.push(f.source);
    f.event();
    await vi.advanceTimersByTimeAsync(7);
    f.event();
    await vi.advanceTimersByTimeAsync(9);
    expect(f.uploads()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await f.queue.drain();
    expect(f.uploads()).toBe(1);
    await f.controller.stop();
  });
  it("reconciliation reevaluates orphan jobs but leaves unchanged safe failures alone", async () => {
    vi.useFakeTimers();
    const f = setup();
    f.files.splice(f.files.indexOf(f.note), 1);
    f.controller.start();
    f.ready();
    await f.controller.scanNow();
    await f.queue.drain();
    expect(f.job().failure?.code).toBe("orphan");
    f.files.push(f.note);
    await vi.advanceTimersByTimeAsync(100);
    await f.queue.drain();
    expect(f.job().state).toBe("trashed");
    await f.controller.stop();
  });
  it("bounds repeated orphan retry logs during ordinary reconciliation", async () => {
    vi.useFakeTimers();
    const f = setup(true, undefined, {
      historyMaxEntries: 2,
      historyMaxAgeDays: 30,
    });
    f.files.splice(f.files.indexOf(f.note), 1);
    f.controller.start();
    f.ready();
    await f.controller.scanNow();
    await f.queue.drain();
    for (let index = 0; index < 5; index++) {
      await vi.advanceTimersByTimeAsync(100);
      await f.queue.drain();
    }
    expect(f.store.snapshot().logs.length).toBeLessThanOrEqual(2);
    expect(f.job().state).toBe("skipped");
    await f.controller.stop();
  });
  it("advances age retention during an idle reconciliation scan", async () => {
    const initial: JobSnapshot = {
      jobs: [
        {
          vaultPath: "old.png",
          state: "trashed",
          createdAt: 0,
          updatedAt: 0,
          rewrittenNotePaths: [],
          rewrittenReferenceCount: 0,
        },
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
    const f = setup(true, initial, { historyMaxAgeDays: 1 });
    f.files.length = 0;
    await f.store.hydrate();
    f.controller.start();
    await f.controller.scanNow();
    expect(f.store.snapshot()).toEqual({ jobs: [], logs: [] });
    await f.controller.stop();
  });
  it("safe failure event retry requires a different persisted fingerprint", async () => {
    vi.useFakeTimers();
    const f = setup();
    f.setResponse({ ok: false, error: { kind: "refused", dispatched: false } });
    f.controller.start();
    f.ready();
    await f.controller.scanNow();
    await f.queue.drain();
    f.event();
    await vi.advanceTimersByTimeAsync(10);
    await f.controller.scanNow();
    await f.queue.drain();
    expect(f.uploads()).toBe(1);
    f.source.stat.mtime++;
    f.event();
    await vi.advanceTimersByTimeAsync(10);
    await f.queue.drain();
    expect(f.uploads()).toBe(2);
    await f.controller.stop();
  });
  it("processes a restored trashed path as a new generation even with the same fingerprint", async () => {
    vi.useFakeTimers();
    const f = setup();
    f.controller.start();
    f.ready();
    await f.controller.scanNow();
    await f.queue.drain();
    const restored = f.add("attachments/image.png");
    f.add("new.md", "![[attachments/image.png]]");
    f.event(restored);
    await vi.advanceTimersByTimeAsync(10);
    await f.queue.drain();
    expect(f.uploads()).toBe(2);
    expect(f.text.get(f.files.find((file) => file.path === "new.md")!)).toBe(
      "![](<https://cdn.test/image.png>)",
    );
    expect(f.trash).toEqual(["attachments/image.png", "attachments/image.png"]);
    await f.controller.stop();
  });
  it("deduplicates concurrent scan and event discovery of changed restored bytes", async () => {
    vi.useFakeTimers();
    const f = setup();
    f.controller.start();
    f.ready();
    await f.controller.scanNow();
    await f.queue.drain();
    const restored = f.add("attachments/image.png", "new bytes");
    f.add("new.md", "![[attachments/image.png]]");
    f.event(restored);
    const scan = f.controller.scanNow();
    await vi.advanceTimersByTimeAsync(10);
    await scan;
    await f.queue.drain();
    expect(f.uploads()).toBe(2);
    expect(f.trash).toEqual(["attachments/image.png", "attachments/image.png"]);
    await f.controller.stop();
  });
  it("disabled automation permits manual scan and acknowledged uncertain retry", async () => {
    const f = setup(false);
    f.setResponse({ ok: false, error: { kind: "timeout", dispatched: true } });
    f.controller.start();
    f.ready();
    f.event();
    await f.queue.drain();
    expect(f.uploads()).toBe(0);
    await f.controller.scanNow();
    await f.queue.drain();
    expect(f.job().state).toBe("uncertain");
    await f.controller.retrySafeFailures();
    await f.controller.retry(f.source.path);
    expect(f.uploads()).toBe(1);
    await f.controller.retry(f.source.path, { acknowledgeUncertain: true });
    await f.queue.drain();
    expect(f.uploads()).toBe(2);
    await f.controller.stop();
  });
  it("stop clears readiness, events and timers and waits for aborted processing", async () => {
    vi.useFakeTimers();
    const f = setup();
    let observedAbort = false;
    f.lifecycle.stat = async () =>
      new Promise((resolve) => {
        setTimeout(() => resolve(null), 100);
      });
    f.controller.start();
    f.ready();
    await f.controller.scanNow();
    await f.queue.drain();
    f.event();
    const unsubscribe = f.controller.subscribe((snapshot) => {
      if (snapshot.state === "stopped") observedAbort = true;
    });
    await f.controller.stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.readyListeners.size).toBe(0);
    expect(f.eventListeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(observedAbort).toBe(true);
    expect(f.controller.snapshot().state).toBe("stopped");
    unsubscribe();
  });
  it("stop aborts a dispatched upload and drains its uncertain terminal state", async () => {
    const f = setup(false);
    f.blockUpload();
    f.controller.start();
    await f.controller.scanNow();
    await vi.waitFor(() => expect(f.uploads()).toBe(1));
    await f.controller.stop();
    expect(f.uploadAborted()).toBe(true);
    expect(f.job().state).toBe("uncertain");
    expect(f.trash).toEqual([]);
  });
  it("layout-ready callbacks cannot register automatic work twice", async () => {
    vi.useFakeTimers();
    const f = setup();
    f.controller.start();
    f.ready();
    f.ready();
    await f.controller.scanNow();
    await f.queue.drain();
    await f.controller.stop();
    expect(f.eventListeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("snapshots redact quoted secrets without corrupting stored diagnostics", async () => {
    const f = setup(false);
    f.settings.picgoSecret = 'private"secret';
    f.controller.start();
    await f.store.appendLog({
      timestamp: Date.now(),
      level: "error",
      stage: "upload",
      code: "test",
      message: 'private"secret at C:\\private\\vault\\image.png',
    });
    const snapshot = f.controller.snapshot();
    expect(snapshot.logs[0]?.message).not.toContain('private"secret');
    expect(snapshot.logs[0]?.message).not.toContain("C:");
    await f.controller.stop();
  });
  it("a credential containing only a quote cannot break snapshot serialization", async () => {
    const f = setup(false);
    f.settings.picgoSecret = '"';
    f.controller.start();
    expect(() => f.controller.snapshot()).not.toThrow();
    await f.controller.stop();
  });
  it("changing enabled to false prevents subsequent automatic scans", async () => {
    vi.useFakeTimers();
    const f = setup();
    f.files.splice(f.files.indexOf(f.source), 1);
    f.controller.start();
    f.ready();
    await f.controller.scanNow();
    f.settings.enabled = false;
    f.files.push(f.source);
    await vi.advanceTimersByTimeAsync(100);
    await f.queue.drain();
    expect(f.uploads()).toBe(0);
    await f.controller.scanNow();
    await f.queue.drain();
    expect(f.uploads()).toBe(1);
    await f.controller.stop();
  });
  it("disabling automation also suppresses a previously debounced event", async () => {
    vi.useFakeTimers();
    const f = setup();
    f.files.splice(f.files.indexOf(f.source), 1);
    f.controller.start();
    f.ready();
    await f.controller.scanNow();
    f.files.push(f.source);
    f.event();
    f.settings.enabled = false;
    await vi.advanceTimersByTimeAsync(10);
    await f.queue.drain();
    expect(f.uploads()).toBe(0);
    await f.controller.stop();
  });
  it("cancelPending suppresses an event awaiting a changed fingerprint", async () => {
    vi.useFakeTimers();
    const f = setup();
    f.setResponse({ ok: false, error: { kind: "refused", dispatched: false } });
    f.controller.start();
    f.ready();
    await f.controller.scanNow();
    await f.queue.drain();
    let resolveStat!: (value: { size: number; mtime: number }) => void;
    f.lifecycle.stat = () =>
      new Promise((resolve) => {
        resolveStat = resolve;
      });
    f.event();
    await vi.advanceTimersByTimeAsync(10);
    await f.controller.cancelPending();
    resolveStat({ size: 0, mtime: 3 });
    await vi.advanceTimersByTimeAsync(0);
    await f.queue.drain();
    expect(f.uploads()).toBe(1);
    await f.controller.stop();
  });
  it("uncertain jobs are never retried by a changed source event or reconciliation", async () => {
    vi.useFakeTimers();
    const f = setup();
    f.setResponse({ ok: false, error: { kind: "timeout", dispatched: true } });
    f.controller.start();
    f.ready();
    await f.controller.scanNow();
    await f.queue.drain();
    f.source.stat.mtime++;
    f.event();
    await vi.advanceTimersByTimeAsync(100);
    await f.queue.drain();
    expect(f.uploads()).toBe(1);
    expect(f.job().state).toBe("uncertain");
    await f.controller.stop();
  });
  it("manual retrySafeFailures works when automation is disabled", async () => {
    const f = setup(false);
    f.setResponse({ ok: false, error: { kind: "refused", dispatched: false } });
    f.controller.start();
    await f.controller.scanNow();
    await f.queue.drain();
    f.setResponse({
      ok: true,
      value: {
        statusCode: 200,
        body: JSON.stringify({
          success: true,
          result: ["https://cdn.test/image.png"],
        }),
      },
    });
    await f.controller.retrySafeFailures();
    await f.queue.drain();
    expect(f.job().state).toBe("trashed");
    expect(f.uploads()).toBe(2);
    await f.controller.stop();
  });
});

describe("restart recovery and resilient shutdown", () => {
  const interrupted = (
    state: JobState,
    patch: Partial<JobRecord> = {},
  ): JobSnapshot => ({
    jobs: [
      {
        vaultPath: "attachments/image.png",
        state,
        createdAt: 1,
        updatedAt: 2,
        fingerprint: { size: 0, mtime: 2 },
        rewrittenNotePaths: [],
        rewrittenReferenceCount: 0,
        ...patch,
      },
    ],
    logs: [],
  });

  it("hydrates and resumes rewriting while retaining exact prior progress and never reuploading", async () => {
    const f = setup(
      true,
      interrupted("rewriting", {
        remoteUrl: "https://cdn.test/image.png",
        rewrittenNotePaths: ["earlier.md"],
        rewrittenReferenceCount: 1,
      }),
    );
    const earlier = f.add("earlier.md");
    f.text.set(earlier, "![](<https://cdn.test/image.png>)");
    await f.store.hydrate();
    f.controller.start();
    f.ready();
    await f.controller.scanNow();
    await f.queue.drain();
    expect(f.job()).toMatchObject({
      state: "trashed",
      fingerprint: { size: 0, mtime: 2 },
      remoteUrl: "https://cdn.test/image.png",
      rewrittenNotePaths: ["earlier.md", "note.md"],
      rewrittenReferenceCount: 2,
    });
    expect(f.uploads()).toBe(0);
    expect(f.writes).toEqual(["note.md"]);
    expect(f.trash).toEqual(["attachments/image.png"]);
    await f.controller.stop();
  });
  it("resumes persisted verification with no remaining local references", async () => {
    const f = setup(
      true,
      interrupted("verifying", {
        remoteUrl: "https://cdn.test/image.png",
        rewrittenNotePaths: ["note.md"],
        rewrittenReferenceCount: 1,
      }),
    );
    f.text.set(f.note, "![](<https://cdn.test/image.png>)");
    f.caches.set(f.note, {});
    await f.store.hydrate();
    f.controller.start();
    f.ready();
    await f.controller.scanNow();
    await f.queue.drain();
    expect(f.job()).toMatchObject({
      state: "trashed",
      rewrittenReferenceCount: 1,
    });
    expect(f.uploads()).toBe(0);
    expect(f.writes).toEqual([]);
    await f.controller.stop();
  });
  it.each(["waiting-stable", "discovering-references"] as const)(
    "safely restarts persisted %s through a new stability check",
    async (state) => {
      const f = setup(true, interrupted(state));
      await f.store.hydrate();
      f.source.stat.mtime = 5;
      f.controller.start();
      f.ready();
      await f.controller.scanNow();
      await f.queue.drain();
      expect(f.job()).toMatchObject({
        state: "trashed",
        fingerprint: { size: 0, mtime: 5 },
      });
      expect(f.statReads()).toBeGreaterThanOrEqual(4);
      expect(f.uploads()).toBe(1);
      await f.controller.stop();
    },
  );
  it.each([true, false])(
    "classifies a persisted upload as uncertain even when source exists=%s",
    async (exists) => {
      const f = setup(true, interrupted("uploading"));
      await f.store.hydrate();
      if (!exists) f.files.splice(f.files.indexOf(f.source), 1);
      f.controller.start();
      f.ready();
      await f.controller.scanNow();
      await f.queue.drain();
      expect(f.job()).toMatchObject({
        state: "uncertain",
        failure: { retry: "uncertain", stage: "upload" },
      });
      await f.controller.scanNow();
      await f.controller.retrySafeFailures();
      await f.queue.drain();
      expect(f.uploads()).toBe(0);
      expect(f.trash).toEqual([]);
      await f.controller.stop();
    },
  );
  it("keeps an expired uncertain tombstone through restart reconciliation until acknowledged", async () => {
    const uncertain = interrupted("uncertain", {
      updatedAt: 0,
      failure: {
        code: "timeout",
        stage: "upload",
        message: "Safe message.",
        retry: "uncertain",
      },
    });
    const f = setup(true, uncertain);
    await f.store.hydrate();
    await f.store.prune();
    f.controller.start();
    f.ready();
    await f.controller.scanNow();
    await f.queue.drain();
    expect(f.job()).toMatchObject({
      state: "uncertain",
      failure: { retry: "uncertain" },
    });
    expect(f.uploads()).toBe(0);
    await f.controller.retry(f.source.path, { acknowledgeUncertain: true });
    await f.queue.drain();
    expect(f.uploads()).toBe(1);
    await f.controller.stop();
  });
  it("does not reset an actively owned upload during reconciliation", async () => {
    const f = setup();
    f.blockUpload();
    f.controller.start();
    f.ready();
    await f.controller.scanNow();
    await vi.waitFor(() => expect(f.uploads()).toBe(1));
    await f.controller.scanNow();
    expect(f.job().state).toBe("uploading");
    expect(f.uploads()).toBe(1);
    await f.controller.stop();
  });
  it("classifies an interrupted upload even after its folder is removed from automatic policy", async () => {
    const f = setup(true, interrupted("uploading"));
    await f.store.hydrate();
    f.settings.attachmentFolders = ["other"];
    f.controller.start();
    f.ready();
    await f.controller.scanNow();
    await f.queue.drain();
    expect(f.job().state).toBe("uncertain");
    expect(f.uploads()).toBe(0);
    await f.controller.stop();
  });
  it("reconciliation retries a failed durable recovery without another upload", async () => {
    vi.useFakeTimers();
    const f = setup(
      true,
      interrupted("rewriting", { remoteUrl: "https://cdn.test/image.png" }),
    );
    await f.store.hydrate();
    f.failSave("queued");
    f.controller.start();
    f.ready();
    await f.controller.scanNow();
    await f.queue.drain();
    expect(f.job().state).toBe("rewriting");
    expect(f.controller.snapshot().lastScan?.failed).toBe(1);
    expect(f.uploads()).toBe(0);
    await vi.advanceTimersByTimeAsync(100);
    await f.queue.drain();
    expect(f.job().state).toBe("trashed");
    expect(f.uploads()).toBe(0);
    await f.controller.stop();
  });
  it("drains active work after cancellation persistence rejects and resolves stop normally", async () => {
    const f = setup(false);
    f.add("attachments/second.png");
    f.blockUpload();
    f.holdUploadAbort();
    f.controller.start();
    await f.controller.scanNow();
    await vi.waitFor(() => expect(f.uploads()).toBe(1));
    f.failSave("uploading");
    let outcome = "pending";
    const stop = f.controller.stop().then(
      () => {
        outcome = "resolved";
      },
      () => {
        outcome = "rejected";
      },
    );
    try {
      await vi.waitFor(() => expect(f.saveFailures()).toBe(1));
      expect(f.uploadAborted()).toBe(true);
      expect(outcome).toBe("pending");
    } finally {
      f.releaseUploadAbort();
      await stop;
      await f.queue.drain();
    }
    expect(outcome).toBe("resolved");
    expect(f.controller.snapshot().state).toBe("stopped");
    expect(f.store.snapshot().jobs.map((job) => job.state)).toEqual([
      "uncertain",
      "cancelled",
    ]);
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
});
