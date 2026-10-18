import type { PluginSettings, Result, SettingsValidationError } from "./domain";
import { normalizeVaultPath } from "./path-policy";

export const DEFAULT_SETTINGS: Readonly<PluginSettings> = Object.freeze({
  enabled: true,
  picgoOrigin: "http://127.0.0.1:36677",
  picgoSecret: "",
  allowInsecureHttp: false,
  attachmentFolders: ["attachments"],
  allowedExtensions: [
    "png",
    "jpg",
    "jpeg",
    "gif",
    "webp",
    "bmp",
    "svg",
    "avif",
  ],
  quietPeriodMs: 3000,
  stabilitySampleIntervalMs: 2000,
  stabilitySamples: 2,
  stabilityTimeoutMs: 60000,
  maxFileSizeBytes: 50 * 1024 * 1024,
  reconciliationIntervalMs: 300000,
  requestTimeoutMs: 30000,
  historyMaxEntries: 500,
  historyMaxAgeDays: 30,
});
Object.freeze(DEFAULT_SETTINGS.attachmentFolders);
Object.freeze(DEFAULT_SETTINGS.allowedExtensions);

type Rules = {
  [K in keyof PluginSettings]: (
    input: unknown,
  ) => PluginSettings[K] | undefined;
};

const integer =
  (minimum: number, maximum = Number.MAX_SAFE_INTEGER) =>
  (input: unknown): number | undefined =>
    typeof input === "number" &&
    Number.isSafeInteger(input) &&
    input >= minimum &&
    input <= maximum
      ? input
      : undefined;
const boolean = (input: unknown): boolean | undefined =>
  typeof input === "boolean" ? input : undefined;

function origin(input: unknown): string | undefined {
  if (
    typeof input !== "string" ||
    !/^https?:\/\/[^/?#]+\/?$/.test(input) ||
    /[\\?#\s]/.test(input)
  )
    return undefined;
  try {
    const url = new URL(input);
    if (url.username || url.password || url.pathname !== "/") return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

function folders(input: unknown): string[] | undefined {
  if (!Array.isArray(input) || !input.length) return undefined;
  const normalized: string[] = [];
  for (const folder of input) {
    if (typeof folder !== "string") return undefined;
    const path = normalizeVaultPath(folder);
    if (!path || path.split("/").some((part) => part.startsWith(".")))
      return undefined;
    normalized.push(path);
  }
  return [...new Set(normalized)];
}

function extensions(input: unknown): string[] | undefined {
  if (!Array.isArray(input) || !input.length) return undefined;
  const normalized: string[] = [];
  for (const extension of input) {
    if (typeof extension !== "string") return undefined;
    const value = extension.replace(/^\./, "").toLowerCase();
    if (!DEFAULT_SETTINGS.allowedExtensions.includes(value)) return undefined;
    normalized.push(value);
  }
  return [...new Set(normalized)];
}

const rules: Rules = {
  enabled: boolean,
  picgoOrigin: origin,
  picgoSecret: (input) =>
    // eslint-disable-next-line no-control-regex -- Prevent HTTP header control-character injection.
    typeof input === "string" && !/[\u0000-\u001f\u007f]/.test(input)
      ? input
      : undefined,
  allowInsecureHttp: boolean,
  attachmentFolders: folders,
  allowedExtensions: extensions,
  quietPeriodMs: integer(0),
  stabilitySampleIntervalMs: integer(1),
  stabilitySamples: integer(2),
  stabilityTimeoutMs: integer(1),
  maxFileSizeBytes: integer(1),
  reconciliationIntervalMs: integer(1),
  requestTimeoutMs: integer(1),
  historyMaxEntries: integer(1, 500),
  historyMaxAgeDays: integer(1, 30),
};

function record(input: unknown): Record<string, unknown> | undefined {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : undefined;
}

function insecureHttp(settings: PluginSettings): boolean {
  const url = new URL(settings.picgoOrigin);
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
  return url.protocol === "http:" && !loopback && !settings.allowInsecureHttp;
}

/** Validate a complete settings draft before activating or saving it. */
export function validateSettings(
  input: unknown,
): Result<PluginSettings, SettingsValidationError[]> {
  const source = record(input);
  if (!source)
    return {
      ok: false,
      error: [{ field: "settings", code: "invalid-settings" }],
    };
  const settings = sanitizeSettings(undefined);
  const errors: SettingsValidationError[] = [];
  for (const key of Object.keys(rules) as (keyof PluginSettings)[]) {
    const value = rules[key](source[key]);
    if (value === undefined) errors.push({ field: key, code: "invalid-value" });
    else Object.assign(settings, { [key]: value });
  }
  if (
    !errors.some((error) => error.field === "picgoOrigin") &&
    insecureHttp(settings)
  ) {
    errors.push({ field: "picgoOrigin", code: "insecure-http" });
  }
  return errors.length
    ? { ok: false, error: errors }
    : { ok: true, value: settings };
}

/** Recover persisted settings field by field without retaining unknown values. */
export function sanitizeSettings(input: unknown): PluginSettings {
  const settings: PluginSettings = {
    ...DEFAULT_SETTINGS,
    attachmentFolders: [...DEFAULT_SETTINGS.attachmentFolders],
    allowedExtensions: [...DEFAULT_SETTINGS.allowedExtensions],
  };
  const source = record(input);
  if (!source) return settings;
  for (const key of Object.keys(rules) as (keyof PluginSettings)[]) {
    const value = rules[key](source[key]);
    if (value !== undefined) Object.assign(settings, { [key]: value });
  }
  if (insecureHttp(settings))
    settings.picgoOrigin = DEFAULT_SETTINGS.picgoOrigin;
  return settings;
}
