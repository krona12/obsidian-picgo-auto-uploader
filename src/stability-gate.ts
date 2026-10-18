import { DEFAULT_SETTINGS } from "./defaults";
import type {
  JobFailure,
  PluginSettings,
  Result,
  SourceFingerprint,
} from "./domain";

export interface FileProbe {
  /** Null means removed; rejected probes (e.g. a locked file) are retried until the deadline. */
  stat(path: string): Promise<SourceFingerprint | null>;
}

export type StabilityOptions = Pick<
  PluginSettings,
  | "quietPeriodMs"
  | "stabilitySampleIntervalMs"
  | "stabilitySamples"
  | "stabilityTimeoutMs"
  | "maxFileSizeBytes"
>;
export interface StabilityDependencies {
  now?: () => number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

function fail(
  code: string,
  retry: JobFailure["retry"] = "non-retryable",
): Result<never, JobFailure> {
  return {
    ok: false,
    error: {
      code,
      stage: "stability",
      message:
        {
          aborted: "File stability check was cancelled.",
          "file-missing": "The source file no longer exists.",
          "file-too-large": "The source file exceeds the size limit.",
          "invalid-stat": "The source file metadata is invalid.",
          "invalid-options": "File stability settings are invalid.",
          "stability-timeout":
            "The source file did not stabilize before the deadline.",
        }[code] ?? "The source file could not be checked.",
      retry,
    },
  };
}

/** Bounded, abortable stability observation; no file content or native errors escape. */
export class StabilityGate {
  private readonly now: () => number;
  private readonly sleep: NonNullable<StabilityDependencies["sleep"]>;
  constructor(
    private readonly probe: FileProbe,
    dependencies: StabilityDependencies = {},
  ) {
    this.now = dependencies.now ?? Date.now;
    this.sleep = dependencies.sleep ?? sleep;
  }

  async wait(
    path: string,
    options: Partial<StabilityOptions> = {},
    signal?: AbortSignal,
  ): Promise<Result<SourceFingerprint, JobFailure>> {
    const settings: StabilityOptions = { ...DEFAULT_SETTINGS, ...options };
    if (
      ![
        settings.quietPeriodMs,
        settings.stabilitySampleIntervalMs,
        settings.stabilitySamples,
        settings.stabilityTimeoutMs,
        settings.maxFileSizeBytes,
      ].every(Number.isSafeInteger) ||
      settings.quietPeriodMs < 0 ||
      settings.stabilitySampleIntervalMs < 1 ||
      settings.stabilitySamples < 2 ||
      settings.stabilityTimeoutMs < 1 ||
      settings.maxFileSizeBytes < 1
    )
      return fail("invalid-options");
    if (signal?.aborted) return fail("aborted");
    const started = this.now();
    const controller = new AbortController();
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: Result<SourceFingerprint, JobFailure>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        controller.abort();
        resolve(result);
      };
      const abort = () => finish(fail("aborted"));
      const timeout = () => finish(fail("stability-timeout", "safe"));
      const timer = setTimeout(timeout, settings.stabilityTimeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) return abort();
      const observe = async () => {
        let delay = settings.quietPeriodMs;
        let previous: SourceFingerprint | undefined;
        let matches = 0;
        while (!settled) {
          const remaining =
            settings.stabilityTimeoutMs - (this.now() - started);
          if (remaining <= 0) return timeout();
          await this.sleep(Math.min(delay, remaining), controller.signal);
          if (settled) return;
          if (this.now() - started >= settings.stabilityTimeoutMs)
            return timeout();
          let sample: SourceFingerprint | null;
          try {
            sample = await this.probe.stat(path);
          } catch {
            previous = undefined;
            matches = 0;
            delay = settings.stabilitySampleIntervalMs;
            continue;
          }
          if (settled) return;
          if (this.now() - started >= settings.stabilityTimeoutMs)
            return timeout();
          if (!sample) return finish(fail("file-missing"));
          if (
            !Number.isSafeInteger(sample.size) ||
            sample.size < 0 ||
            !Number.isFinite(sample.mtime) ||
            sample.mtime < 0
          )
            return finish(fail("invalid-stat"));
          if (sample.size > settings.maxFileSizeBytes)
            return finish(fail("file-too-large"));
          const same =
            previous?.size === sample.size && previous.mtime === sample.mtime;
          matches = same ? matches + 1 : 1;
          delay =
            previous && !same
              ? Math.max(
                  settings.quietPeriodMs,
                  settings.stabilitySampleIntervalMs,
                )
              : settings.stabilitySampleIntervalMs;
          previous = { size: sample.size, mtime: sample.mtime };
          if (matches >= settings.stabilitySamples)
            return finish({ ok: true, value: previous });
        }
      };
      void observe().catch(() => {
        if (!settled) finish(fail("stability-timeout", "safe"));
      });
    });
  }
}
