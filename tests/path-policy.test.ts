import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import {
  isEligibleAttachment,
  isPathInsideFolder,
  normalizeVaultPath,
} from "../src/path-policy";

describe("Vault path policy", () => {
  // Breaks caught: unsafe absolute/traversal paths accepted, or valid separator normalization lost.
  it.each([
    ["attachments\\照片 1.png", "attachments/照片 1.png"],
    ["attachments//nested/./a.png", "attachments/nested/a.png"],
    [" attachments/a.png", " attachments/a.png"],
    ["", null],
    [".", null],
    ["/", null],
    ["/attachments/a.png", null],
    ["C:\\images\\a.png", null],
    ["C:images/a.png", null],
    ["\\\\server\\share\\a.png", null],
    ["../a.png", null],
    ["attachments/../a.png", null],
    ["attachments/.. /a.png", null],
    ["attachments/a.png\0", null],
    ["attachments/a.png:stream", null],
    ["attachments/a.png.", null],
    ["attachments/a.png ", null],
  ])("normalizes %j to %j", (input, expected) => {
    expect(normalizeVaultPath(input)).toBe(expected);
  });

  // Breaks caught: a startsWith check accidentally includes sibling folders.
  it.each([
    ["attachments/a.png", "attachments", true],
    ["attachments/nested/a.png", "attachments/", true],
    ["attachments-old/a.png", "attachments", false],
    ["attachments", "attachments", false],
    ["other/a.png", "attachments", false],
    ["attachments/a.png", "", false],
    ["attachments/../a.png", "attachments", false],
    ["附件/旅行 照片.png", "附件", true],
  ])("checks %j inside %j", (path, folder, expected) => {
    expect(isPathInsideFolder(path, folder)).toBe(expected);
  });

  // Breaks caught: trash/plugin data or unsupported extensions enter processing.
  it.each([
    ["root-image.png", true],
    ["journal/assets/root-image.png", true],
    ["attachments/a.png", true],
    ["attachments/a.JPG", true],
    ["attachments/照片 1.avif", true],
    ["attachments/a.png.exe", false],
    ["attachments/a", false],
    ["attachments/.trash/a.png", false],
    ["attachments/.obsidian/a.png", false],
    [".trash/a.png", false],
    ["attachments-old/a.png", true],
    ["attachments/../a.png", false],
  ])("eligibility of %j is %j", (path, expected) => {
    expect(isEligibleAttachment(path, DEFAULT_SETTINGS)).toBe(expected);
  });

  it("can restrict candidates to configured Unicode folders", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      scanEntireVault: false,
      attachmentFolders: ["附件"],
      allowedExtensions: ["svg"],
    };
    expect(isEligibleAttachment("附件/旅行 照片.svg", settings)).toBe(true);
    expect(isEligibleAttachment("附件/旅行 照片.png", settings)).toBe(false);
    expect(isEligibleAttachment("其他/旅行 照片.svg", settings)).toBe(false);
  });

  it.each([
    "attachments/CON.png",
    "attachments/NUL",
    "attachments/com1.jpg",
    "attachments/LPT9.png",
  ])("rejects Windows device paths %j", (path) => {
    expect(normalizeVaultPath(path)).toBe(null);
  });
});
