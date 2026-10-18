import { describe, expect, it } from "vitest";
import { StabilityGate, type FileProbe } from "../src/stability-gate";

function fixture(samples: (Awaited<ReturnType<FileProbe["stat"]>> | Error)[]) {
  let time = 0;
  const observations: number[] = [];
  const gate = new StabilityGate(
    {
      async stat() {
        observations.push(time);
        const value = samples.length > 1 ? samples.shift()! : samples[0]!;
        if (value instanceof Error) throw value;
        return value;
      },
    },
    {
      now: () => time,
      sleep: async (ms) => {
        time += ms;
      },
    },
  );
  return { gate, observations, time: () => time };
}

describe("file stability gate", () => {
  // Break: accepting one sample, skipping quiet time, or using only size instead of mtime.
  it("waits the default quiet period and two matching samples", async () => {
    const { gate, observations } = fixture([{ size: 42, mtime: 10 }]);
    expect(await gate.wait("attachments/a.png")).toEqual({
      ok: true,
      value: { size: 42, mtime: 10 },
    });
    expect(observations).toEqual([3000, 5000]);
  });

  it("resets both quiet time and sample count after intermittent writes", async () => {
    const { gate, observations } = fixture([
      { size: 42, mtime: 10 },
      { size: 42, mtime: 11 },
      { size: 43, mtime: 12 },
      { size: 43, mtime: 12 },
    ]);
    expect(await gate.wait("attachments/a.png")).toEqual({
      ok: true,
      value: { size: 43, mtime: 12 },
    });
    expect(observations).toEqual([3000, 5000, 8000, 11000]);
  });

  // Break: missing/locked files retry forever or oversized files reach the upload stage.
  it("reports a removed file without accepting it", async () => {
    const { gate } = fixture([null]);
    expect(await gate.wait("a.png")).toMatchObject({
      ok: false,
      error: { code: "file-missing", retry: "non-retryable" },
    });
  });

  it("retries locked probes until a stable observation is available", async () => {
    const { gate, time } = fixture([
      new Error("locked"),
      { size: 10, mtime: 1 },
    ]);
    expect(await gate.wait("a.png")).toEqual({
      ok: true,
      value: { size: 10, mtime: 1 },
    });
    expect(time()).toBe(7000);
  });

  it("times out locked files at the exact total deadline", async () => {
    const { gate, time } = fixture([new Error("locked")]);
    expect(await gate.wait("a.png")).toMatchObject({
      ok: false,
      error: { code: "stability-timeout", retry: "safe" },
    });
    expect(time()).toBe(60000);
  });

  it("rejects files above 50 MiB and permits the exact boundary", async () => {
    expect(
      await fixture([{ size: 52428801, mtime: 1 }]).gate.wait("a.png"),
    ).toMatchObject({
      ok: false,
      error: { code: "file-too-large", retry: "non-retryable" },
    });
    expect(
      await fixture([{ size: 52428800, mtime: 1 }]).gate.wait("a.png"),
    ).toMatchObject({ ok: true });
  });

  // Break: an unloading plugin waits on a probe/sleep or accepts stale success after abort.
  it("aborts a pending probe even when the probe ignores the signal", async () => {
    const controller = new AbortController();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new StabilityGate(
      {
        stat: () => {
          entered();
          return new Promise(() => {});
        },
      },
      { sleep: async () => {} },
    );
    const result = gate.wait("a.png", {}, controller.signal);
    await started;
    controller.abort();
    expect(await result).toMatchObject({
      ok: false,
      error: { code: "aborted", retry: "non-retryable" },
    });
  });

  it("bounds a hung probe using the deadline", async () => {
    // Fake timer advances the real default timer implementation, never wall-clock waits.
    const { vi } = await import("vitest");
    vi.useFakeTimers();
    try {
      const gate = new StabilityGate({ stat: () => new Promise(() => {}) });
      const result = gate.wait("a.png");
      await vi.advanceTimersByTimeAsync(60000);
      expect(await result).toMatchObject({
        ok: false,
        error: { code: "stability-timeout" },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects invalid fingerprints and options", async () => {
    expect(
      await fixture([{ size: -1, mtime: 1 }]).gate.wait("a.png"),
    ).toMatchObject({ ok: false, error: { code: "invalid-stat" } });
    expect(
      await fixture([{ size: 1, mtime: 1 }]).gate.wait("a.png", {
        stabilitySamples: 1,
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid-options" } });
  });
});
