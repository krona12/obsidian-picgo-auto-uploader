import { afterEach, describe, expect, it, vi } from "vitest";
import { AutoUploaderController } from "../src/obsidian/controller";
import { fixture } from "./task5-fixture";

afterEach(() => vi.useRealTimers());
function setup(enabled = true) {
  const f = fixture();
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
