import { Notice, Plugin, apiVersion, moment, type TFile } from "obsidian";
import { AttachmentProcessor } from "./attachment-processor";
import { sanitizeSettings, validateSettings } from "./defaults";
import type { PluginSettings } from "./domain";
import { JobStore, type JobPersistence, type JobSnapshot } from "./job-store";
import { resolveLocale, t, type SupportedLocale } from "./i18n";
import {
  AutoUploaderController,
  type ControllerLifecycle,
  type ControllerSnapshot,
} from "./obsidian/controller";
import { ObsidianReferenceService } from "./obsidian/reference-service";
import { ObsidianVaultAdapter } from "./obsidian/vault-adapter";
import { PicGoClient } from "./picgo-client";
import { createDiagnosticExport } from "./redaction";
import { StabilityGate } from "./stability-gate";
import { UploadQueue } from "./upload-queue";
import {
  PicGoAutoUploaderSettingTab,
  type SettingsTabActions,
} from "./ui/settings-tab";
import { StatusBarPresenter, type StatusBarActions } from "./ui/status-bar";
import { StatusModal, type StatusModalActions } from "./ui/status-modal";

interface PluginDataEnvelope extends JobSnapshot {
  schemaVersion: 1;
  settings: PluginSettings;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One durable queue owns the complete data.json envelope. */
export class PluginDataRepository implements JobPersistence {
  private initialized = false;
  private initialization: Promise<void> | undefined;
  private committed: PluginDataEnvelope = {
    schemaVersion: 1,
    settings: sanitizeSettings(undefined),
    jobs: [],
    logs: [],
  };
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly read: () => Promise<unknown>,
    private readonly write: (value: PluginDataEnvelope) => Promise<void>,
  ) {}

  initialize(): Promise<void> {
    if (this.initialized) return Promise.resolve();
    if (this.initialization) return this.initialization;
    this.initialization = this.read()
      .then((value) => {
        const source = object(value) ? value : {};
        this.committed = {
          schemaVersion: 1,
          settings: sanitizeSettings(source.settings),
          jobs: Array.isArray(source.jobs) ? clone(source.jobs) : [],
          logs: Array.isArray(source.logs) ? clone(source.logs) : [],
        };
        this.initialized = true;
      })
      .finally(() => {
        this.initialization = undefined;
      });
    return this.initialization;
  }

  async load(): Promise<JobSnapshot> {
    await this.initialize();
    return clone({ jobs: this.committed.jobs, logs: this.committed.logs });
  }

  loadJobs(): Promise<JobSnapshot> {
    return this.load();
  }

  settings(): PluginSettings {
    return clone(this.committed.settings);
  }

  save(snapshot: JobSnapshot): Promise<void> {
    const captured = clone(snapshot);
    return this.serialize(async () => {
      await this.initialize();
      await this.commit({ ...this.committed, ...captured });
    });
  }

  saveSettings(settings: PluginSettings): Promise<void> {
    const validation = validateSettings(settings);
    if (!validation.ok) return Promise.reject(new Error("Invalid settings."));
    const captured = clone(validation.value);
    return this.serialize(async () => {
      await this.initialize();
      await this.commit({ ...this.committed, settings: captured });
    });
  }

  private serialize(operation: () => Promise<void>): Promise<void> {
    const result = this.tail.then(operation);
    this.tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  private async commit(next: PluginDataEnvelope): Promise<void> {
    const captured = clone(next);
    await this.write(captured);
    this.committed = captured;
  }
}

interface Runtime {
  settings: PluginSettings;
  store: JobStore;
  client: PicGoClient;
  controller: AutoUploaderController;
}

export function createPluginDiagnosticExport(input: {
  pluginVersion: string;
  obsidianApiVersion: string;
  settings: PluginSettings;
  snapshot: ControllerSnapshot;
}): string {
  const diagnostic = createDiagnosticExport({
    pluginVersion: input.pluginVersion,
    obsidianApiVersion: input.obsidianApiVersion,
    picgoSecret: input.settings.picgoSecret,
    settings: input.settings,
    controller: input.snapshot,
  });
  return JSON.stringify(diagnostic, null, 2);
}

export default class PicGoAutoUploaderPlugin extends Plugin {
  private repository: PluginDataRepository | undefined;
  private runtime: Runtime | undefined;
  private statusPresenter: StatusBarPresenter | undefined;
  private statusModal: StatusModal | undefined;
  private settingsTab: PicGoAutoUploaderSettingTab | undefined;
  private locale: SupportedLocale = "en";
  private rebuildTail: Promise<void> = Promise.resolve();
  private shutdownPromise: Promise<void> | undefined;

  async onload(): Promise<void> {
    this.locale = resolveLocale(moment.locale());
    this.repository = new PluginDataRepository(
      () => this.loadData(),
      (value) => this.saveData(value),
    );
    await this.repository.initialize();
    this.runtime = await this.buildRuntime(this.repository.settings());

    const statusElement = this.addStatusBarItem();
    this.statusPresenter = new StatusBarPresenter(
      statusElement,
      this.statusBarActions(),
      this.locale,
    );
    this.settingsTab = new PicGoAutoUploaderSettingTab(
      this.app,
      this,
      this.settingsActions(),
      this.locale,
    );
    this.addSettingTab(this.settingsTab);
    this.addRibbonIcon("image-up", t(this.locale, "statusbar.open"), () =>
      this.openStatus(),
    );
    this.addCommand({
      id: "open-status",
      name: "Open PicGo Auto Uploader status",
      callback: () => this.openStatus(),
    });
    this.addCommand({
      id: "scan-now",
      name: "Scan attachment folders now",
      callback: () =>
        void this.safeAction(() => this.current().controller.scanNow()),
    });
    this.addCommand({
      id: "retry-failed",
      name: "Retry failed uploads",
      callback: () =>
        void this.safeAction(() =>
          this.current().controller.retrySafeFailures(),
        ),
    });
    this.runtime.controller.start();
  }

  onunload(): void {
    void this.shutdown();
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.statusModal?.close();
    this.statusModal = undefined;
    this.settingsTab?.hide();
    this.statusPresenter?.destroy();
    this.statusPresenter = undefined;
    const runtime = this.runtime;
    this.runtime = undefined;
    this.shutdownPromise = (
      runtime?.controller.stop() ?? Promise.resolve()
    ).finally(() => {
      this.shutdownPromise = undefined;
    });
    return this.shutdownPromise;
  }

  applySettings(settings: PluginSettings): Promise<void> {
    const operation = async () => {
      const validation = validateSettings(settings);
      if (!validation.ok || !this.repository)
        throw new Error("Invalid settings.");
      await this.repository.saveSettings(validation.value);
      const old = this.current();
      this.statusModal?.close();
      this.statusModal = undefined;
      await old.controller.stop();
      const replacement = await this.buildRuntime(validation.value);
      this.runtime = replacement;
      this.statusPresenter?.bind(this.statusBarActions());
      replacement.controller.start();
    };
    const result = this.rebuildTail.then(operation, operation);
    this.rebuildTail = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  /** Stable test seam that reveals replacement, never configuration or credentials. */
  runtimeIdentity(): object | undefined {
    return this.runtime?.controller;
  }

  private async buildRuntime(settings: PluginSettings): Promise<Runtime> {
    if (!this.repository) throw new Error("Repository unavailable.");
    const source = new ObsidianVaultAdapter(this.app.vault);
    const references = new ObsidianReferenceService(
      this.app.vault,
      this.app.metadataCache,
    );
    const store = new JobStore(this.repository, {
      historyMaxEntries: settings.historyMaxEntries,
      historyMaxAgeDays: settings.historyMaxAgeDays,
    });
    await store.hydrate();
    await store.prune();
    const stability = new StabilityGate(source);
    const client = new PicGoClient(settings);
    const processor = new AttachmentProcessor<TFile>({
      settings,
      store,
      source,
      stability,
      client,
      references,
    });
    const queue = new UploadQueue(store, (job, signal) =>
      processor.process(job.vaultPath, signal),
    );
    const lifecycle: ControllerLifecycle = {
      onLayoutReady: (callback) => {
        let active = true;
        this.app.workspace.onLayoutReady(() => {
          if (active) callback();
        });
        return () => {
          active = false;
        };
      },
      onFileEvent: (callback) => source.onFileEvent(callback),
      listPaths: () => source.listPaths(),
      stat: (path) => source.stat(path),
    };
    return {
      settings: clone(settings),
      store,
      client,
      controller: new AutoUploaderController({
        settings,
        store,
        queue,
        lifecycle,
      }),
    };
  }

  private settingsActions(): SettingsTabActions {
    return {
      getSettings: () => clone(this.current().settings),
      applySettings: (settings) => this.applySettings(settings),
      testConnection: (settings, signal) =>
        new PicGoClient(settings).heartbeat(signal),
      openStatus: () => this.openStatus(),
    };
  }

  private statusBarActions(): StatusBarActions {
    return {
      snapshot: () => this.current().controller.snapshot(),
      subscribe: (listener) => this.current().controller.subscribe(listener),
      isEnabled: () => this.current().settings.enabled,
      openStatus: () => this.openStatus(),
    };
  }

  private statusActions(): StatusModalActions {
    return {
      snapshot: () => this.current().controller.snapshot(),
      subscribe: (listener) => this.current().controller.subscribe(listener),
      isEnabled: () => this.current().settings.enabled,
      heartbeat: (signal) => this.current().client.heartbeat(signal),
      scanNow: () => this.current().controller.scanNow(),
      retrySafeFailures: () => this.current().controller.retrySafeFailures(),
      retry: (path, options) => this.current().controller.retry(path, options),
      cancelPending: () => this.current().controller.cancelPending(),
      clearTerminalHistory: () => this.current().store.clearTerminalHistory(),
      exportDiagnostics: () => this.diagnostics(),
      openSettings: () => this.openSettings(),
    };
  }

  private openStatus(): void {
    this.statusModal?.close();
    this.statusModal = new StatusModal(
      this.app,
      this.statusActions(),
      this.locale,
    );
    this.statusModal.open();
  }

  private openSettings(): void {
    const settings = (
      this.app as unknown as {
        setting?: { open?(): void; openTabById?(id: string): void };
      }
    ).setting;
    if (settings?.open && settings.openTabById) {
      settings.open();
      settings.openTabById(this.manifest.id);
      return;
    }
    new Notice(t(this.locale, "notice.openSettingsFailed"));
  }

  private diagnostics(): string {
    const runtime = this.current();
    return createPluginDiagnosticExport({
      pluginVersion: this.manifest.version,
      obsidianApiVersion: apiVersion,
      settings: runtime.settings,
      snapshot: runtime.controller.snapshot(),
    });
  }

  private current(): Runtime {
    if (!this.runtime) throw new Error("Plugin is not running.");
    return this.runtime;
  }

  private async safeAction(operation: () => Promise<unknown>): Promise<void> {
    try {
      await operation();
    } catch {
      new Notice(t(this.locale, "status.operationFailed"));
    }
  }
}
