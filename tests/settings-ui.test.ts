// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import {
  PicGoAutoUploaderSettingTab,
  parseSettingsDraft,
  type SettingsTabActions,
} from "../src/ui/settings-tab";

function actions(
  overrides: Partial<SettingsTabActions> = {},
): SettingsTabActions {
  return {
    getSettings: () => ({
      ...DEFAULT_SETTINGS,
      picgoSecret: "private-secret",
      attachmentFolders: ["attachments"],
      allowedExtensions: ["png"],
    }),
    applySettings: vi.fn(async () => {}),
    testConnection: vi.fn(async () => ({
      ok: true as const,
      value: undefined,
    })),
    openStatus: vi.fn(),
    ...overrides,
  };
}

describe("settings UI", () => {
  beforeEach(() => document.body.replaceChildren());

  it("strictly converts display units and reports field errors", () => {
    const parsed = parseSettingsDraft(DEFAULT_SETTINGS, {
      maxFileSizeMb: "1.5",
      quietPeriodSeconds: "3",
      reconciliationMinutes: "5",
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.maxFileSizeBytes).toBeDefined();
  });

  it("masks the secret and applies a fully validated draft", async () => {
    const api = actions();
    const tab = new PicGoAutoUploaderSettingTab(
      {} as never,
      {} as never,
      api,
      "en",
    );
    tab.display();
    const secret = tab.containerEl.querySelector<HTMLInputElement>(
      'input[data-field="picgoSecret"]',
    )!;
    expect(secret.type).toBe("password");
    expect(tab.containerEl.textContent).not.toContain("private-secret");
    tab.containerEl
      .querySelector<HTMLButtonElement>('button[data-action="apply"]')!
      .click();
    await Promise.resolve();
    expect(api.applySettings).toHaveBeenCalledOnce();
  });

  it("requires a fresh acknowledgement after changing an insecure origin", async () => {
    const applySettings = vi.fn(async () => {});
    const tab = new PicGoAutoUploaderSettingTab(
      {} as never,
      {} as never,
      actions({ applySettings }),
      "en",
    );
    tab.display();
    document.body.append(tab.containerEl);
    const origin = tab.containerEl.querySelector<HTMLInputElement>(
      'input[data-field="picgoOrigin"]',
    )!;
    origin.value = "http://192.168.1.20:36677";
    origin.dispatchEvent(new Event("input"));
    expect(
      tab.containerEl.querySelector('[data-warning="insecure-http"]'),
    ).not.toBeNull();
    tab.containerEl
      .querySelector<HTMLButtonElement>('button[data-action="apply"]')!
      .click();
    await Promise.resolve();
    expect(applySettings).not.toHaveBeenCalled();
    const acknowledgement = tab.containerEl.querySelector<HTMLInputElement>(
      'input[data-field="allowInsecureHttp"]',
    )!;
    acknowledgement.checked = true;
    acknowledgement.dispatchEvent(new Event("change"));
    tab.containerEl
      .querySelector<HTMLButtonElement>('button[data-action="apply"]')!
      .click();
    await Promise.resolve();
    expect(applySettings).toHaveBeenCalledOnce();
  });

  it("keeps the endpoint input mounted and focused during sequential typing", () => {
    const tab = new PicGoAutoUploaderSettingTab(
      {} as never,
      {} as never,
      actions(),
      "en",
    );
    tab.display();
    document.body.append(tab.containerEl);
    const origin = tab.containerEl.querySelector<HTMLInputElement>(
      'input[data-field="picgoOrigin"]',
    )!;
    origin.focus();
    for (const value of [
      "http://1",
      "http://192.168",
      "http://192.168.1.20:36677",
    ]) {
      origin.value = value;
      origin.dispatchEvent(new Event("input"));
      expect(
        tab.containerEl.querySelector('input[data-field="picgoOrigin"]'),
      ).toBe(origin);
      expect(document.activeElement).toBe(origin);
    }
    expect(
      tab.containerEl.querySelector('[data-warning="insecure-http"]'),
    ).not.toBeNull();
  });

  it("updates the warning region in place and clears acknowledgement on every endpoint edit", () => {
    const tab = new PicGoAutoUploaderSettingTab(
      {} as never,
      {} as never,
      actions(),
      "en",
    );
    tab.display();
    const region = tab.containerEl.querySelector<HTMLElement>(
      '[data-region="insecure-http"]',
    )!;
    const origin = tab.containerEl.querySelector<HTMLInputElement>(
      'input[data-field="picgoOrigin"]',
    )!;
    origin.value = "http://192.168.1.20:36677";
    origin.dispatchEvent(new Event("input"));
    const acknowledgement = region.querySelector<HTMLInputElement>(
      'input[data-field="allowInsecureHttp"]',
    )!;
    acknowledgement.checked = true;
    acknowledgement.dispatchEvent(new Event("change"));
    origin.value = "http://192.168.1.20:36678";
    origin.dispatchEvent(new Event("input"));
    expect(tab.containerEl.querySelector('[data-region="insecure-http"]')).toBe(
      region,
    );
    expect(
      region.querySelector<HTMLInputElement>(
        'input[data-field="allowInsecureHttp"]',
      )!.checked,
    ).toBe(false);
    origin.value = "http://127.0.0.1:36677";
    origin.dispatchEvent(new Event("input"));
    expect(region.childElementCount).toBe(0);
  });

  it("aborts an in-flight connection check and clears DOM when hidden", () => {
    let signal: AbortSignal | undefined;
    const tab = new PicGoAutoUploaderSettingTab(
      {} as never,
      {} as never,
      actions({
        testConnection: vi.fn((_settings, next: AbortSignal) => {
          signal = next;
          return new Promise<never>(() => {});
        }),
      }),
      "en",
    );
    tab.display();
    tab.containerEl
      .querySelector<HTMLButtonElement>('button[data-action="test"]')!
      .click();
    tab.hide();
    expect(signal?.aborted).toBe(true);
    expect(tab.containerEl.childElementCount).toBe(0);
  });

  it("does not repopulate a hidden settings tab when saving settles later", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const tab = new PicGoAutoUploaderSettingTab(
      {} as never,
      {} as never,
      actions({ applySettings: vi.fn(() => pending) }),
      "en",
    );
    tab.display();
    tab.containerEl
      .querySelector<HTMLButtonElement>('button[data-action="apply"]')!
      .click();
    tab.hide();
    finish();
    await pending;
    await Promise.resolve();
    expect(tab.containerEl.childElementCount).toBe(0);
  });
});
