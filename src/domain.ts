export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export interface PluginSettings {
  enabled: boolean;
  picgoOrigin: string;
  picgoSecret: string;
  allowInsecureHttp: boolean;
  attachmentFolders: string[];
  allowedExtensions: string[];
  quietPeriodMs: number;
  stabilitySampleIntervalMs: number;
  stabilitySamples: number;
  stabilityTimeoutMs: number;
  maxFileSizeBytes: number;
  reconciliationIntervalMs: number;
  requestTimeoutMs: number;
  historyMaxEntries: number;
  historyMaxAgeDays: number;
}

export type JobState =
  | "queued"
  | "waiting-stable"
  | "discovering-references"
  | "uploading"
  | "rewriting"
  | "verifying"
  | "trashed"
  | "skipped"
  | "failed"
  | "uncertain"
  | "cancelled";

export type RetryClassification = "safe" | "uncertain" | "non-retryable";
export type ErrorStage =
  | "path"
  | "stability"
  | "reference"
  | "upload"
  | "rewrite"
  | "verify"
  | "trash"
  | "lifecycle";

export interface SourceFingerprint {
  size: number;
  mtime: number;
}

/** Messages must be redacted before they enter persistence or UI snapshots. */
export interface JobFailure {
  code: string;
  stage: ErrorStage;
  message: string;
  retry: RetryClassification;
}

/** All timestamps are Unix milliseconds; vaultPath is the normalized identity. */
export interface JobRecord {
  vaultPath: string;
  state: JobState;
  createdAt: number;
  updatedAt: number;
  fingerprint?: SourceFingerprint;
  remoteUrl?: string;
  rewrittenNotePaths: string[];
  rewrittenReferenceCount: number;
  failure?: JobFailure;
}

export interface LogEntry {
  timestamp: number;
  level: "info" | "warn" | "error";
  stage: ErrorStage;
  code: string;
  message: string;
  vaultPath?: string;
}

export interface SettingsValidationError {
  field: keyof PluginSettings | "settings";
  code: "invalid-settings" | "invalid-value" | "insecure-http";
}
