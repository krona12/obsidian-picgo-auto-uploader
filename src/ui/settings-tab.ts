import {
  Notice,
  PluginSettingTab,
  Setting,
  type App,
  type Plugin,
} from "obsidian";
import { DEFAULT_SETTINGS, validateSettings } from "../defaults";
import type { PluginSettings, Result } from "../domain";
import type { PicGoClient } from "../picgo-client";
import { resolveLocale, t, type SupportedLocale } from "../i18n";

export interface SettingsTabActions {
  getSettings(): PluginSettings;
  applySettings(settings: PluginSettings): Promise<void>;
  testConnection(
    settings: PluginSettings,
    signal: AbortSignal,
  ): ReturnType<PicGoClient["heartbeat"]>;
  openStatus(): void;
}

export interface SettingsFormValues {
  enabled: boolean;
  picgoOrigin: string;
  picgoSecret: string;
  allowInsecureHttp: boolean;
  scanEntireVault: boolean;
  attachmentFolders: string;
  allowedExtensions: string;
  maxFileSizeMb: string;
  quietPeriodSeconds: string;
  stabilitySampleIntervalSeconds: string;
  stabilitySamples: string;
  stabilityTimeoutSeconds: string;
  reconciliationMinutes: string;
  requestTimeoutSeconds: string;
  historyMaxEntries: string;
  historyMaxAgeDays: string;
}

export type SettingsDraftErrors = Partial<Record<keyof PluginSettings, string>>;
export type SettingsDraftResult = Result<PluginSettings, SettingsDraftErrors>;

function formFromSettings(settings: PluginSettings): SettingsFormValues {
  return {
    enabled: settings.enabled,
    picgoOrigin: settings.picgoOrigin,
    picgoSecret: settings.picgoSecret,
    allowInsecureHttp: settings.allowInsecureHttp,
    scanEntireVault: settings.scanEntireVault,
    attachmentFolders: settings.attachmentFolders.join("\n"),
    allowedExtensions: settings.allowedExtensions.join(", "),
    maxFileSizeMb: String(settings.maxFileSizeBytes / (1024 * 1024)),
    quietPeriodSeconds: String(settings.quietPeriodMs / 1000),
    stabilitySampleIntervalSeconds: String(
      settings.stabilitySampleIntervalMs / 1000,
    ),
    stabilitySamples: String(settings.stabilitySamples),
    stabilityTimeoutSeconds: String(settings.stabilityTimeoutMs / 1000),
    reconciliationMinutes: String(settings.reconciliationIntervalMs / 60000),
    requestTimeoutSeconds: String(settings.requestTimeoutMs / 1000),
    historyMaxEntries: String(settings.historyMaxEntries),
    historyMaxAgeDays: String(settings.historyMaxAgeDays),
  };
}

function scaledInteger(value: string, scale: number): number | undefined {
  if (!/^(?:0|[1-9]\d*)$/.test(value.trim())) return undefined;
  const parsed = Number(value);
  const scaled = parsed * scale;
  return Number.isSafeInteger(scaled) ? scaled : undefined;
}

export function parseSettingsDraft(
  base: PluginSettings,
  changes: Partial<SettingsFormValues>,
): SettingsDraftResult {
  const values = { ...formFromSettings(base), ...changes };
  const errors: SettingsDraftErrors = {};
  const numeric = <K extends keyof PluginSettings>(
    field: K,
    value: string,
    scale: number,
  ): number => {
    const parsed = scaledInteger(value, scale);
    if (parsed === undefined) errors[field] = "invalid-value";
    return parsed ?? 0;
  };
  const candidate: PluginSettings = {
    enabled: values.enabled,
    picgoOrigin: values.picgoOrigin.trim(),
    picgoSecret: values.picgoSecret,
    allowInsecureHttp: values.allowInsecureHttp,
    scanEntireVault: values.scanEntireVault,
    attachmentFolders: values.attachmentFolders
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean),
    allowedExtensions: values.allowedExtensions
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    maxFileSizeBytes: numeric(
      "maxFileSizeBytes",
      values.maxFileSizeMb,
      1024 * 1024,
    ),
    quietPeriodMs: numeric("quietPeriodMs", values.quietPeriodSeconds, 1000),
    stabilitySampleIntervalMs: numeric(
      "stabilitySampleIntervalMs",
      values.stabilitySampleIntervalSeconds,
      1000,
    ),
    stabilitySamples: numeric("stabilitySamples", values.stabilitySamples, 1),
    stabilityTimeoutMs: numeric(
      "stabilityTimeoutMs",
      values.stabilityTimeoutSeconds,
      1000,
    ),
    reconciliationIntervalMs: numeric(
      "reconciliationIntervalMs",
      values.reconciliationMinutes,
      60000,
    ),
    requestTimeoutMs: numeric(
      "requestTimeoutMs",
      values.requestTimeoutSeconds,
      1000,
    ),
    historyMaxEntries: numeric(
      "historyMaxEntries",
      values.historyMaxEntries,
      1,
    ),
    historyMaxAgeDays: numeric(
      "historyMaxAgeDays",
      values.historyMaxAgeDays,
      1,
    ),
  };
  const validation = validateSettings(candidate);
  if (!validation.ok)
    for (const error of validation.error) {
      if (error.field !== "settings") errors[error.field] = error.code;
    }
  return Object.keys(errors).length
    ? { ok: false, error: errors }
    : { ok: true, value: validation.ok ? validation.value : candidate };
}

function insecureHttp(origin: string): boolean {
  try {
    const url = new URL(origin);
    const loopback =
      url.hostname === "localhost" ||
      url.hostname === "[::1]" ||
      /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
    return url.protocol === "http:" && !loopback;
  } catch {
    return false;
  }
}

export class PicGoAutoUploaderSettingTab extends PluginSettingTab {
  private readonly locale: SupportedLocale;
  private values: SettingsFormValues | undefined;
  private errors: SettingsDraftErrors = {};
  private connection: AbortController | undefined;
  private visible = false;
  private warningRegion: HTMLElement | undefined;

  constructor(
    app: App,
    plugin: Plugin,
    private readonly actions: SettingsTabActions,
    locale?: string,
  ) {
    super(app, plugin);
    this.locale = resolveLocale(locale);
  }

  display(): void {
    this.visible = true;
    this.connection?.abort();
    this.connection = undefined;
    this.values ??= formFromSettings(this.actions.getSettings());
    const values = this.values;
    this.containerEl.replaceChildren();
    this.containerEl.classList.add("picgo-auto-uploader-settings");
    const heading = document.createElement("h2");
    heading.textContent = t(this.locale, "settings.title");
    this.containerEl.append(heading);

    this.toggle("enabled", "settings.enabled", "settings.enabledDesc");
    this.text("picgoOrigin", "settings.origin", "settings.originDesc");
    this.text("picgoSecret", "settings.secret", "settings.secretDesc", true);
    this.button("test", "settings.test", () => this.testConnection());
    this.toggle(
      "scanEntireVault",
      "settings.scanEntireVault",
      "settings.scanEntireVaultDesc",
    );
    this.textarea(
      "attachmentFolders",
      "settings.folders",
      "settings.foldersDesc",
    );
    this.text(
      "allowedExtensions",
      "settings.extensions",
      "settings.extensionsDesc",
    );
    this.text("maxFileSizeMb", "settings.maxSize");
    this.text("quietPeriodSeconds", "settings.quiet");
    this.text("stabilitySampleIntervalSeconds", "settings.sampleInterval");
    this.text("stabilitySamples", "settings.sampleCount");
    this.text("stabilityTimeoutSeconds", "settings.stabilityTimeout");
    this.text("reconciliationMinutes", "settings.reconciliation");
    this.text("requestTimeoutSeconds", "settings.requestTimeout");
    this.text("historyMaxEntries", "settings.historyEntries");
    this.text("historyMaxAgeDays", "settings.historyDays");

    this.warningRegion = document.createElement("div");
    this.warningRegion.dataset.region = "insecure-http";
    this.containerEl.append(this.warningRegion);
    this.renderInsecureWarning();

    const actions = document.createElement("div");
    actions.className = "picgo-auto-uploader-actions";
    this.nativeButton(actions, "apply", t(this.locale, "common.apply"), () =>
      this.apply(),
    );
    this.nativeButton(actions, "reset", t(this.locale, "common.reset"), () => {
      const secret = values.picgoSecret;
      this.values = formFromSettings({
        ...DEFAULT_SETTINGS,
        picgoSecret: secret,
      });
      this.errors = {};
      this.display();
    });
    this.nativeButton(
      actions,
      "status",
      t(this.locale, "common.openStatus"),
      () => this.actions.openStatus(),
    );
    this.containerEl.append(actions);
  }

  hide(): void {
    this.visible = false;
    this.connection?.abort();
    this.connection = undefined;
    this.containerEl.replaceChildren();
  }

  private text(
    field: keyof SettingsFormValues,
    label: Parameters<typeof t>[1],
    description?: Parameters<typeof t>[1],
    password = false,
  ): void {
    const setting = new Setting(this.containerEl).setName(
      t(this.locale, label),
    );
    if (description) setting.setDesc(t(this.locale, description));
    setting.addText((component) => {
      component.setValue(String(this.values![field])).onChange((value) => {
        if (field === "picgoOrigin") {
          this.values!.allowInsecureHttp = false;
          this.values![field] = value as never;
          this.renderInsecureWarning();
          return;
        }
        this.values![field] = value as never;
      });
      component.inputEl.dataset.field = field;
      if (password) component.inputEl.type = "password";
      this.decorateError(
        setting.settingEl,
        component.inputEl,
        this.settingField(field),
      );
    });
  }

  private textarea(
    field: "attachmentFolders",
    label: Parameters<typeof t>[1],
    description: Parameters<typeof t>[1],
  ): void {
    const setting = new Setting(this.containerEl)
      .setName(t(this.locale, label))
      .setDesc(t(this.locale, description));
    setting.addTextArea((component) => {
      component.setValue(this.values![field]).onChange((value) => {
        this.values![field] = value;
      });
      component.inputEl.dataset.field = field;
      this.decorateError(setting.settingEl, component.inputEl, field);
    });
  }

  private toggle(
    field: "enabled" | "scanEntireVault",
    label: Parameters<typeof t>[1],
    description: Parameters<typeof t>[1],
  ): void {
    const setting = new Setting(this.containerEl)
      .setName(t(this.locale, label))
      .setDesc(t(this.locale, description));
    setting.addToggle((component) => {
      component.setValue(this.values![field]).onChange((value) => {
        this.values![field] = value;
      });
      component.toggleEl.dataset.field = field;
    });
  }

  private button(
    action: string,
    label: Parameters<typeof t>[1],
    callback: () => void | Promise<void>,
  ): void {
    new Setting(this.containerEl).addButton((component) => {
      component.setButtonText(t(this.locale, label)).onClick(callback);
      component.buttonEl.dataset.action = action;
    });
  }

  private nativeButton(
    parent: HTMLElement,
    action: string,
    label: string,
    callback: () => void | Promise<void>,
  ): void {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.action = action;
    button.textContent = label;
    button.addEventListener("click", () => void callback());
    parent.append(button);
  }

  private settingField(field: keyof SettingsFormValues): keyof PluginSettings {
    const map: Partial<Record<keyof SettingsFormValues, keyof PluginSettings>> =
      {
        maxFileSizeMb: "maxFileSizeBytes",
        quietPeriodSeconds: "quietPeriodMs",
        stabilitySampleIntervalSeconds: "stabilitySampleIntervalMs",
        stabilityTimeoutSeconds: "stabilityTimeoutMs",
        reconciliationMinutes: "reconciliationIntervalMs",
        requestTimeoutSeconds: "requestTimeoutMs",
      };
    return map[field] ?? (field as keyof PluginSettings);
  }

  private decorateError(
    parent: HTMLElement,
    input: HTMLElement,
    field: keyof PluginSettings,
  ): void {
    if (!this.errors[field]) return;
    input.setAttribute("aria-invalid", "true");
    const error = document.createElement("div");
    error.className = "picgo-auto-uploader-field-error";
    error.textContent = t(this.locale, "settings.validation");
    parent.append(error);
  }

  private renderInsecureWarning(): void {
    const region = this.warningRegion;
    if (!region || !this.values) return;
    region.replaceChildren();
    if (!insecureHttp(this.values.picgoOrigin)) return;
    const warning = document.createElement("section");
    warning.className = "picgo-auto-uploader-http-warning";
    warning.dataset.warning = "insecure-http";
    warning.setAttribute("role", "alert");
    const text = document.createElement("p");
    text.textContent = t(this.locale, "settings.insecureWarning");
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.dataset.field = "allowInsecureHttp";
    checkbox.checked = this.values.allowInsecureHttp;
    checkbox.addEventListener("change", () => {
      this.values!.allowInsecureHttp = checkbox.checked;
    });
    label.append(
      checkbox,
      document.createTextNode(t(this.locale, "settings.insecureAck")),
    );
    warning.append(text, label);
    region.append(warning);
  }

  private async apply(): Promise<void> {
    const parsed = parseSettingsDraft(this.actions.getSettings(), this.values!);
    if (!parsed.ok) {
      this.errors = parsed.error;
      this.display();
      return;
    }
    try {
      await this.actions.applySettings(parsed.value);
      this.values = formFromSettings(parsed.value);
      this.errors = {};
      new Notice(t(this.locale, "settings.saved"));
      if (this.visible) this.display();
    } catch {
      new Notice(t(this.locale, "settings.saveFailed"));
    }
  }

  private async testConnection(): Promise<void> {
    const parsed = parseSettingsDraft(this.actions.getSettings(), this.values!);
    if (!parsed.ok) {
      this.errors = parsed.error;
      new Notice(t(this.locale, "settings.connectionInvalid"));
      this.display();
      return;
    }
    this.connection?.abort();
    const controller = new AbortController();
    this.connection = controller;
    try {
      const result = await this.actions.testConnection(
        parsed.value,
        controller.signal,
      );
      if (!controller.signal.aborted)
        new Notice(
          t(
            this.locale,
            result.ok ? "settings.testSuccess" : "settings.testFailure",
          ),
        );
    } catch {
      if (!controller.signal.aborted)
        new Notice(t(this.locale, "settings.testFailure"));
    } finally {
      if (this.connection === controller) this.connection = undefined;
    }
  }
}
