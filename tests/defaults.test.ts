import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  sanitizeSettings,
  validateSettings,
} from "../src/defaults";

describe("settings policy", () => {
  // Breaks caught: absent persisted settings activate an unsafe endpoint or incorrect timing/retention policy.
  it("supplies the specified operational defaults when no settings were saved", () => {
    expect(sanitizeSettings(undefined)).toEqual({
      enabled: true,
      picgoOrigin: "http://127.0.0.1:36677",
      picgoSecret: "",
      allowInsecureHttp: false,
      scanEntireVault: true,
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
      maxFileSizeBytes: 52428800,
      reconciliationIntervalMs: 300000,
      requestTimeoutMs: 30000,
      historyMaxEntries: 500,
      historyMaxAgeDays: 30,
    });
  });

  // Breaks caught: URL ambiguity or credential-bearing URLs accepted as a PicGo origin.
  it.each([
    "ftp://localhost",
    "http://user:password@localhost",
    "http://localhost/upload",
    "http://localhost?token=secret",
    "http://localhost#fragment",
    "not a URL",
    "http://example.com",
    "http://127.0.0.1.example.com",
  ])("rejects unsafe endpoint %j", (picgoOrigin) => {
    expect(validateSettings({ ...DEFAULT_SETTINGS, picgoOrigin }).ok).toBe(
      false,
    );
  });

  it.each([
    "http://localhost:36677",
    "http://127.0.0.1:36677",
    "http://[::1]:36677",
    "https://example.com",
  ])("accepts safe origin %j", (picgoOrigin) => {
    expect(validateSettings({ ...DEFAULT_SETTINGS, picgoOrigin }).ok).toBe(
      true,
    );
  });

  it("requires explicit acknowledgement for non-loopback plain HTTP", () => {
    expect(
      validateSettings({
        ...DEFAULT_SETTINGS,
        picgoOrigin: "http://example.com",
        allowInsecureHttp: true,
      }).ok,
    ).toBe(true);
  });

  it("rejects a non-origin URL even when URL parsing would collapse its path", () => {
    expect(
      validateSettings({
        ...DEFAULT_SETTINGS,
        picgoOrigin: "http://localhost/upload/..",
      }).ok,
    ).toBe(false);
  });

  it("restores the local endpoint when persisted HTTP risk was not acknowledged", () => {
    expect(
      sanitizeSettings({ picgoOrigin: "http://example.com" }).picgoOrigin,
    ).toBe("http://127.0.0.1:36677");
  });

  it("migrates existing settings to Vault-wide discovery and preserves an explicit folder-only choice", () => {
    expect(
      sanitizeSettings({ attachmentFolders: ["attachments"] }),
    ).toMatchObject({ scanEntireVault: true });
    expect(sanitizeSettings({ scanEntireVault: false })).toMatchObject({
      scanEntireVault: false,
    });
  });

  // Breaks caught: invalid folder configuration broadens scanning to the Vault root or reserved data.
  it.each([
    { attachmentFolders: [] },
    { attachmentFolders: [""] },
    { attachmentFolders: ["/"] },
    { attachmentFolders: ["../images"] },
    { attachmentFolders: ["C:\\images"] },
    { attachmentFolders: [".trash"] },
    { attachmentFolders: ["attachments/.obsidian"] },
  ])("rejects unsafe folders $attachmentFolders", ({ attachmentFolders }) => {
    expect(
      validateSettings({ ...DEFAULT_SETTINGS, attachmentFolders }).ok,
    ).toBe(false);
  });

  it("normalizes valid folders and extension input", () => {
    const result = validateSettings({
      ...DEFAULT_SETTINGS,
      attachmentFolders: ["附件\\图片/", "附件/图片"],
      allowedExtensions: [".PNG", "jpg", "png"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.attachmentFolders).toEqual(["附件/图片"]);
      expect(result.value.allowedExtensions).toEqual(["png", "jpg"]);
    }
  });

  // Breaks caught: malformed persisted scalars bypass validation or erase unrelated valid settings.
  it.each([
    ["quietPeriodMs", -1],
    ["stabilitySamples", 1],
    ["stabilityTimeoutMs", 0],
    ["maxFileSizeBytes", Infinity],
    ["requestTimeoutMs", "30000"],
    ["historyMaxEntries", 1.5],
    ["enabled", "yes"],
    ["allowedExtensions", ["exe"]],
    ["historyMaxEntries", 501],
    ["historyMaxAgeDays", 31],
    ["picgoSecret", "secret\r\nAuthorization: injected"],
  ])("rejects malformed field %s", (field, value) => {
    expect(validateSettings({ ...DEFAULT_SETTINGS, [field]: value }).ok).toBe(
      false,
    );
  });

  it("recovers invalid saved fields independently and excludes unknown keys", () => {
    const recovered = sanitizeSettings({
      quietPeriodMs: -1,
      attachmentFolders: ["附件"],
      unknown: "discard",
    });
    expect(recovered.quietPeriodMs).toBe(3000);
    expect(recovered.attachmentFolders).toEqual(["附件"]);
    expect(recovered).not.toHaveProperty("unknown");
  });

  it("does not let a caller mutate future defaults through returned arrays", () => {
    sanitizeSettings(null).attachmentFolders.push("other");
    expect(sanitizeSettings(null).attachmentFolders).toEqual(["attachments"]);
  });

  it.each([
    { input: null },
    { input: [] },
    { input: "settings" },
    { input: 42 },
  ])("rejects a non-object settings payload $input", ({ input }) => {
    expect(validateSettings(input).ok).toBe(false);
  });
});
