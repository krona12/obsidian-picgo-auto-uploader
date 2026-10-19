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
  snapshotMaintenance?: Parameters<typeof fixture>[2],
) {
  const f = fixture(initial, storeOptions, snapshotMaintenance);
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
  it("discovers and converts a referenced image stored at the Vault root", async () => {
    const f = setup();
    f.source.path = "root-image.png";
    f.source.name = "root-image.png";
    f.source.basename = "root-image";
    const embed = "![[root-image.png]]";
    f.text.set(f.note, embed);
    f.caches.set(f.note, {
      embeds: [
        {
          link: "root-image.png",
          original: embed,
          position: {
            start: { line: 0, col: 0, offset: 0 },
            end: { line: 0, col: embed.length, offset: embed.length },
          },
        },
      ],
    });
    f.controller.start();
    f.ready();
    await f.controller.scanNow();
    await f.queue.drain();
    expect(f.uploads()).toBe(1);
    expect(f.text.get(f.note)).toBe("![](<https://cdn.test/image.png>)");
    expect(f.trash).toEqual(["root-image.png"]);
    await f.controller.stop();
  });

  it("retains an unreferenced image discovered outside configured folders", async () => {
    const f = setup();
    f.source.path = "loose.png";
    f.source.name = "loose.png";
    f.source.basename = "loose";
    f.files.splice(f.files.indexOf(f.note), 1);
    f.controller.start();
    f.ready();
    await f.controller.scanNow();
    await f.queue.drain();
    expect(f.uploads()).toBe(0);
    expect(f.trash).toEqual([]);
    expect(f.job()).toMatchObject({
      vaultPath: "loose.png",
      state: "skipped",
      failure: { code: "orphan", stage: "reference" },
    });
    await f.controller.stop();
  });

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
    f.event(f.note);
    await vi.advanceTimersByTimeAsync(100);
    await f.queue.drain();
    expect(f.job().state).toBe("trashed");
    await f.controller.stop();
  });
  it("does not retry or relog an unchanged orphan during ordinary reconciliation", async () => {
    vi.useFakeTimers();
    const f = setup();
    f.files.splice(f.files.indexOf(f.note), 1);
    f.controller.start();
    f.ready();
    await f.controller.scanNow();
    await f.queue.drain();
    const logCount = f.store.snapshot().logs.length;
    const updatedAt = f.job().updatedAt;
    for (let index = 0; index < 5; index++) {
      await vi.advanceTimersByTimeAsync(100);
      await f.queue.drain();
    }
    expect(f.store.snapshot().logs.length).toBe(logCount);
    expect(f.job().updatedAt).toBe(updatedAt);
    expect(f.job().state).toBe("skipped");
    await f.controller.stop();
  });
  it("rechecks an orphan once after a reference-bearing file changes", async () => {
    vi.useFakeTimers();
    const f = setup();
    f.files.splice(f.files.indexOf(f.note), 1);
    f.controller.start();
    f.ready();
    await f.controller.scanNow();
    await f.queue.drain();
    const firstLogCount = f.store.snapshot().logs.length;
    const unrelated = f.add("unrelated.md");

    f.event(unrelated);
    await vi.advanceTimersByTimeAsync(10);
    await f.queue.drain();
    expect(f.job().state).toBe("skipped");
    expect(f.store.snapshot().logs.length).toBe(firstLogCount + 1);

    await vi.advanceTimersByTimeAsync(500);
    await f.queue.drain();
    expect(f.store.snapshot().logs.length).toBe(firstLogCount + 1);
    await f.controller.stop();
  });
  it.each(["rename", "delete"] as const)(
    "treats a reference-bearing %s event as a new discovery revision",
    async (event) => {
      vi.useFakeTimers();
      const f = setup();
      f.files.splice(f.files.indexOf(f.note), 1);
      const unrelated = f.add(
        event === "rename" ? "unrelated.txt" : "unrelated.md",
      );
      f.controller.start();
      f.ready();
      await f.controller.scanNow();
      await f.queue.drain();
      const firstLogCount = f.store.snapshot().logs.length;

      f.vaultEvent(event, unrelated, event === "rename" ? "old.md" : undefined);
      await vi.advanceTimersByTimeAsync(10);
      await f.queue.drain();
      expect(f.store.snapshot().logs.length).toBe(firstLogCount + 1);
      await f.controller.stop();
    },
  );
  it("rechecks an orphan when a note changes before its active worker releases", async () => {
    vi.useFakeTimers();
    const f = setup();
    f.settings.reconciliationIntervalMs = 100_000;
    f.files.splice(f.files.indexOf(f.note), 1);
    f.holdWorkerAfterProcess();
    f.controller.start();
    f.ready();
    await f.controller.scanNow();
    await f.workerAfterProcess();
    expect(f.job().state).toBe("skipped");

    f.files.push(f.note);
    f.event(f.note);
    await vi.advanceTimersByTimeAsync(10);
    await f.controller.scanNow();
    f.event(f.note);
    await vi.advanceTimersByTimeAsync(10);
    f.releaseWorkerAfterProcess();
    await f.queue.drain();
    await vi.waitFor(() => expect(f.job().state).toBe("trashed"));
    expect(f.uploads()).toBe(1);
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
  it("reruns a path changed while its upload worker is active", async () => {
    vi.useFakeTimers();
    const f = setup();
    f.blockUpload();
    f.controller.start();
    f.ready();
    await f.controller.scanNow();
    await vi.waitFor(() => expect(f.uploads()).toBe(1));

    f.setSourceBytes([2]);
    f.event();
    await vi.advanceTimersByTimeAsync(10);
    f.releaseUpload();

    await f.queue.drain();
    await vi.waitFor(() => expect(f.uploads()).toBe(2));
    await f.queue.drain();
    expect(f.uploadedBytes).toEqual([[1], [2]]);
    expect(f.job().state).toBe("trashed");
    await f.controller.stop();
  });
  it("retains the dirty event after a worker persists failure but still owns the path", async () => {
    vi.useFakeTimers();
    const f = setup();
    f.setResponse({ ok: false, error: { kind: "refused", dispatched: false } });
    f.holdWorkerAfterProcess();
    f.controller.start();
    f.ready();
    await f.controller.scanNow();
    await f.workerAfterProcess();
    expect(f.job().state).toBe("failed");

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
    f.setSourceBytes([2]);
    f.event();
    await vi.advanceTimersByTimeAsync(10);
    f.releaseWorkerAfterProcess();

    await f.queue.drain();
    await vi.waitFor(() => expect(f.uploads()).toBe(2));
    await f.queue.drain();
    expect(f.uploadedBytes).toEqual([[1], [2]]);
    expect(f.job().state).toBe("trashed");
    await f.controller.stop();
  });
  it("does not automatically rerun an uncertain upload after a concurrent file event", async () => {
    vi.useFakeTimers();
    const f = setup();
    f.setResponse({ ok: false, error: { kind: "timeout", dispatched: true } });
    f.blockUpload();
    f.controller.start();
    f.ready();
    await f.controller.scanNow();
    await vi.waitFor(() => expect(f.uploads()).toBe(1));

    f.setSourceBytes([2]);
    f.event();
    await vi.advanceTimersByTimeAsync(10);
    f.releaseUpload();

    await f.queue.drain();
    await Promise.resolve();
    expect(f.uploads()).toBe(1);
    expect(f.job().state).toBe("uncertain");
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
        fingerprint: {
          size: 1,
          mtime: 2,
          sha256:
            "4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a",
        },
        rewrittenNotePaths: [],
        rewrittenReferenceCount: 0,
        ...patch,
      },
    ],
    logs: [],
  });

  it("rechecks a persisted orphan once at startup without periodic relogging", async () => {
    vi.useFakeTimers();
    const f = setup(
      true,
      interrupted("skipped", {
        failure: {
          code: "orphan",
          stage: "reference",
          message: "No supported local image reference was found.",
          retry: "safe",
        },
      }),
    );
    f.files.splice(f.files.indexOf(f.note), 1);
    await f.store.hydrate();
    f.controller.start();
    f.ready();
    await f.controller.scanNow();
    await f.queue.drain();
    expect(f.job().state).toBe("skipped");
    expect(f.store.snapshot().logs).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(500);
    await f.queue.drain();
    expect(f.store.snapshot().logs).toHaveLength(1);
    await f.controller.stop();
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
      fingerprint: {
        size: 1,
        mtime: 2,
        sha256:
          "4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a",
      },
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
        fingerprint: { size: 1, mtime: 5 },
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
  it("reconciles an exact persisted source-change failure into a new hashed generation", async () => {
    const f = setup(
      true,
      interrupted("failed", {
        remoteUrl: "https://cdn.test/old-generation.png",
        failure: {
          code: "source-changed",
          stage: "upload",
          message: "The source changed during processing.",
          retry: "safe",
        },
      }),
    );
    await f.store.hydrate();
    // Metadata is deliberately unchanged; only the strong hash identifies the
    // replacement and permits the processor to discard the old saved URL.
    f.setSourceBytes([2]);
    f.controller.start();
    f.ready();
    await f.controller.scanNow();
    await f.queue.drain();

    expect(f.uploadedBytes).toEqual([[2]]);
    expect(f.job()).toMatchObject({
      state: "trashed",
      remoteUrl: "https://cdn.test/image.png",
    });
    expect(f.text.get(f.note)).toBe("![](<https://cdn.test/image.png>)");
    await f.controller.stop();
  });
  it("retries a persisted reference-state race without uploading again", async () => {
    const f = setup(
      true,
      interrupted("failed", {
        remoteUrl: "https://cdn.test/image.png",
        failure: {
          code: "reference-state-changed",
          stage: "verify",
          message: "The reference state changed during verification.",
          retry: "safe",
        },
      }),
    );
    await f.store.hydrate();
    f.controller.start();
    f.ready();
    await f.controller.scanNow();
    await f.queue.drain();

    expect(f.uploads()).toBe(0);
    expect(f.job().state).toBe("trashed");
    expect(f.text.get(f.note)).toBe("![](<https://cdn.test/image.png>)");
    await f.controller.stop();
  });
  it("migrates a legacy discovery-blocked safe failure through the current scanner", async () => {
    const f = setup(
      true,
      interrupted("failed", {
        failure: {
          code: "discovery-blocked",
          stage: "reference",
          message: "Legacy scanner could not classify the reference.",
          retry: "safe",
        },
      }),
    );
    await f.store.hydrate();
    f.controller.start();
    f.ready();
    await f.controller.scanNow();
    await f.queue.drain();

    expect(f.uploads()).toBe(1);
    expect(f.job().state).toBe("trashed");
    expect(f.text.get(f.note)).toBe("![](<https://cdn.test/image.png>)");
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
    f.settings.scanEntireVault = false;
    f.settings.attachmentFolders = ["other"];
    f.controller.start();
    f.ready();
    await f.controller.scanNow();
    await f.queue.drain();
    expect(f.job().state).toBe("uncertain");
    expect(f.uploads()).toBe(0);
    await f.controller.stop();
  });
  it("recovers a durable deletion intent after its folder is removed from automatic policy", async () => {
    const f = setup(
      true,
      interrupted("deleting", {
        remoteUrl: "https://cdn.test/image.png",
        rewrittenNotePaths: ["note.md"],
        rewrittenReferenceCount: 1,
      }),
    );
    await f.store.hydrate();
    f.text.set(f.note, "![](<https://cdn.test/image.png>)");
    f.caches.set(f.note, {});
    f.settings.scanEntireVault = false;
    f.settings.attachmentFolders = ["other"];

    f.controller.start();
    f.ready();
    await f.controller.scanNow();
    await f.queue.drain();

    expect(f.job().state).toBe("trashed");
    expect(f.trash).toEqual(["attachments/image.png"]);
    expect(f.uploads()).toBe(0);
    await f.controller.stop();
  });
  it("automatically resumes a safe persisted snapshot-cleanup failure", async () => {
    const f = setup(
      true,
      interrupted("failed", {
        remoteUrl: "https://cdn.test/image.png",
        pendingSnapshotId:
          "obsidian-picgo-2147483647-00000000-0000-4000-8000-000000000000",
        failure: {
          code: "snapshot-cleanup-failed",
          stage: "upload",
          message: "Cleanup is pending.",
          retry: "safe",
        },
      }),
    );
    await f.store.hydrate();
    f.controller.start();
    f.ready();
    await f.controller.scanNow();
    await f.queue.drain();

    expect(f.job().state).toBe("trashed");
    expect(f.job().pendingSnapshotId).toBeUndefined();
    expect(f.uploads()).toBe(0);
    await f.controller.stop();
  });
  it("cleans an uncertain upload snapshot without retrying or changing uncertainty", async () => {
    const snapshotId =
      "obsidian-picgo-2147483647-00000000-0000-4000-8000-000000000001";
    const f = setup(
      true,
      interrupted("uncertain", {
        pendingSnapshotId: snapshotId,
        failure: {
          code: "snapshot-upload-failed",
          stage: "upload",
          message: "Upload completion is uncertain.",
          retry: "uncertain",
        },
      }),
    );
    await f.store.hydrate();
    f.settings.scanEntireVault = false;
    f.settings.attachmentFolders = ["other"];
    f.controller.start();
    f.ready();
    await f.controller.scanNow();
    await f.queue.drain();

    expect(f.job()).toMatchObject({
      state: "uncertain",
      failure: { retry: "uncertain" },
    });
    expect(f.job().pendingSnapshotId).toBeUndefined();
    expect(await f.controller.retry(f.source.path)).toMatchObject({
      ok: false,
      error: { code: "not-retryable" },
    });
    expect(f.uploads()).toBe(0);
    expect(f.writes).toEqual([]);
    expect(f.trash).toEqual([]);
    await f.controller.stop();
  });
  it("retains and retries only cleanup when an uncertain snapshot cannot be removed", async () => {
    const snapshotId =
      "obsidian-picgo-2147483647-00000000-0000-4000-8000-000000000002";
    let cleanupAttempts = 0;
    const f = setup(
      true,
      interrupted("uncertain", {
        pendingSnapshotId: snapshotId,
        failure: {
          code: "snapshot-upload-failed",
          stage: "upload",
          message: "Upload completion is uncertain.",
          retry: "uncertain",
        },
      }),
      undefined,
      {
        initialize: async () => {},
        remove: async () => {
          cleanupAttempts++;
          throw new Error("cleanup failed");
        },
      },
    );
    await f.store.hydrate();
    f.controller.start();
    f.ready();
    await f.controller.scanNow();
    await f.queue.drain();

    expect(f.job()).toMatchObject({
      state: "uncertain",
      pendingSnapshotId: snapshotId,
      failure: { retry: "uncertain" },
    });
    expect(cleanupAttempts).toBe(1);
    await f.controller.scanNow();
    await f.queue.drain();
    expect(cleanupAttempts).toBe(2);
    expect(f.uploads()).toBe(0);
    expect(f.writes).toEqual([]);
    expect(f.trash).toEqual([]);
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
