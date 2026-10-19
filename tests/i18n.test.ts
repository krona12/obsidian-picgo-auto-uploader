import { describe, expect, it } from "vitest";
import {
  resolveLocale,
  t,
  translations,
  type TranslationKey,
} from "../src/i18n";

describe("localization", () => {
  it.each([
    ["zh", "zh-CN"],
    ["zh-cn", "zh-CN"],
    ["zh-SG", "zh-CN"],
    ["zh-hans", "zh-CN"],
    ["zh-tw", "en"],
    ["fr", "en"],
    [undefined, "en"],
  ] as const)("resolves %s to %s", (input, expected) => {
    expect(resolveLocale(input)).toBe(expected);
  });

  it("keeps the English and Chinese dictionaries in parity", () => {
    expect(Object.keys(translations["zh-CN"]).sort()).toEqual(
      Object.keys(translations.en).sort(),
    );
  });

  it("interpolates text without treating HTML as markup", () => {
    const value = t("en", "status.queueDepth", { count: "<img src=x>" });
    expect(value).toBe("Pending: &lt;img src=x&gt;");
  });

  it("falls back to generic English copy for an unknown runtime key", () => {
    expect(t("en", "not.real" as TranslationKey)).toBe("Something went wrong.");
  });
});
