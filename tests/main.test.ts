// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import type { PluginSettings } from "../src/domain";
import type { JobSnapshot } from "../src/job-store";
import PicGoAutoUploaderPlugin, {
  PluginDataRepository,
  createPluginDiagnosticExport,
} from "../src/main";

function pluginApp() {
  return {
    workspace: { onLayoutReady: vi.fn() },
    vault: {
      getFiles: () => [],
      getMarkdownFiles: () => [],
      trash: vi.fn(),
      offref: vi.fn(),
      on: vi.fn(() => ({})),
      adapter: { stat: vi.fn(), getFullPath: vi.fn() },
      read: vi.fn(),
      process: vi.fn(),
    },
    metadataCache: {
      getFileCache: vi.fn(),
      getFirstLinkpathDest: vi.fn(),
      on: vi.fn(() => ({})),
      offref: vi.fn(),
    },
  };
}

function pluginFor(app = pluginApp()) {
  return new PicGoAutoUploaderPlugin(
    app as never,
    { id: "picgo-auto-uploader", version: "0.1.0" } as never,
  );
}

describe("plugin persistence", () => {
  it("serializes racing settings and job saves without losing either update", async () => {
    let stored: unknown = {
      schemaVersion: 1,
      settings: DEFAULT_SETTINGS,
      jobs: [],
      logs: [],
    };
    const writes: unknown[] = [];
    const repository = new PluginDataRepository(
      async () => structuredClone(stored),
      async (next) => {
        await Promise.resolve();
        stored = structuredClone(next);
        writes.push(stored);
      },
    );
    await repository.load();
    const jobs: JobSnapshot = {
      jobs: [
        {
          vaultPath: "attachments/a.png",
          state: "queued",
          createdAt: 1,
          updatedAt: 1,
          rewrittenNotePaths: [],
          rewrittenReferenceCount: 0,
        },
      ],
      logs: [],
    };
    await Promise.all([
      repository.saveSettings({ ...DEFAULT_SETTINGS, enabled: false }),
      repository.save(jobs),
    ]);
    expect(repository.settings().enabled).toBe(false);
    expect((await repository.loadJobs()).jobs).toHaveLength(1);
    expect(writes).toHaveLength(2);
  });
});

describe("plugin diagnostics", () => {
  it("removes the secret, authorization values, and absolute paths from serialized exports", () => {
    const serialized = createPluginDiagnosticExport({
      pluginVersion: "0.1.0",
      obsidianApiVersion: "1.7.2",
      settings: { ...DEFAULT_SETTINGS, picgoSecret: "private-secret" },
      snapshot: {
        state: "running",
        counts: { failed: 1 },
        lastScanTime: null,
        lastScan: null,
        jobs: [],
        logs: [
          {
            timestamp: 1,
            level: "error",
            stage: "upload",
            code: "failed",
            message:
              "Authorization: Bearer private-secret C:\\Users\\person\\photo.png",
          },
        ],
      },
    });
    expect(serialized).not.toContain("private-secret");
    expect(serialized).not.toContain("C:\\Users\\person");
    expect(serialized).toContain("[REDACTED]");
    expect(JSON.parse(serialized)).toMatchObject({ pluginVersion: "0.1.0" });
  });
});

describe("plugin entry point", () => {
  it("loads data once and registers only the native surface contract", async () => {
    const ready: Array<() => void> = [];
    const app = {
      workspace: {
        onLayoutReady: (cb: () => void) => {
          ready.push(cb);
        },
      },
      vault: {
        getFiles: () => [],
        getMarkdownFiles: () => [],
        trash: vi.fn(),
        offref: vi.fn(),
        on: vi.fn(() => ({})),
        adapter: {
          stat: vi.fn(),
          getFullPath: (path: string) => `C:\\vault\\${path}`,
        },
        read: vi.fn(),
        process: vi.fn(),
      },
      metadataCache: {
        getFileCache: vi.fn(),
        getFirstLinkpathDest: vi.fn(),
        on: vi.fn(() => ({})),
        offref: vi.fn(),
      },
      setting: { open: vi.fn(), openTabById: vi.fn() },
    };
    const plugin = new PicGoAutoUploaderPlugin(
      app as never,
      { id: "picgo-auto-uploader", version: "0.1.0" } as never,
    );
    const load = vi.spyOn(plugin, "loadData").mockResolvedValue(null);
    await plugin.onload();
    expect(load).toHaveBeenCalledOnce();
    const registration = plugin as unknown as {
      commands: Array<{ id: string; name: string }>;
      ribbons: Array<{ icon: string }>;
      settingTabs: unknown[];
      statusItems: unknown[];
      registeredViews: unknown[];
    };
    expect(
      registration.commands.map((command) => [command.id, command.name]),
    ).toEqual([
      ["open-status", "Open PicGo Auto Uploader status"],
      ["scan-now", "Scan attachment folders now"],
      ["retry-failed", "Retry failed uploads"],
    ]);
    expect(registration.ribbons).toHaveLength(1);
    expect(registration.ribbons[0]!.icon).toBe("image-up");
    expect(registration.settingTabs).toHaveLength(1);
    expect(registration.statusItems).toHaveLength(1);
    expect(registration.registeredViews).toHaveLength(0);
    expect(ready).toHaveLength(1);
    await plugin.shutdown();
  });

  it("leaves the existing runtime active when saving replacement settings fails", async () => {
    const app = {
      workspace: { onLayoutReady: vi.fn() },
      vault: {
        getFiles: () => [],
        getMarkdownFiles: () => [],
        trash: vi.fn(),
        offref: vi.fn(),
        on: vi.fn(() => ({})),
        adapter: { stat: vi.fn(), getFullPath: vi.fn() },
        read: vi.fn(),
        process: vi.fn(),
      },
      metadataCache: {
        getFileCache: vi.fn(),
        getFirstLinkpathDest: vi.fn(),
        on: vi.fn(() => ({})),
        offref: vi.fn(),
      },
    };
    const plugin = new PicGoAutoUploaderPlugin(
      app as never,
      { id: "picgo-auto-uploader", version: "0.1.0" } as never,
    );
    await plugin.onload();
    const before = plugin.runtimeIdentity();
    vi.spyOn(plugin, "saveData").mockRejectedValueOnce(
      new Error("C:\\private\\secret"),
    );
    await expect(
      plugin.applySettings({
        ...DEFAULT_SETTINGS,
        picgoOrigin: "http://localhost:36678",
      }),
    ).rejects.toThrow();
    expect(plugin.runtimeIdentity()).toBe(before);
    await plugin.shutdown();
  });

  it("invalidates a rebuild waiting for the old controller when shutdown begins", async () => {
    const app = pluginApp();
    const plugin = pluginFor(app);
    await plugin.onload();
    const old = plugin.runtimeIdentity() as { stop(): Promise<void> };
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stop = vi.spyOn(old, "stop").mockReturnValue(blocked);
    const applying = plugin.applySettings({
      ...DEFAULT_SETTINGS,
      picgoOrigin: "http://localhost:36678",
    });
    await vi.waitFor(() => expect(stop).toHaveBeenCalled());
    const shuttingDown = plugin.shutdown();
    release();
    await Promise.allSettled([applying, shuttingDown]);
    expect(plugin.runtimeIdentity()).toBeUndefined();
    expect(app.workspace.onLayoutReady).toHaveBeenCalledTimes(1);
  });

  it("waits for a rebuild already constructing and never starts its replacement after shutdown", async () => {
    const app = pluginApp();
    const plugin = pluginFor(app);
    await plugin.onload();
    const internal = plugin as unknown as {
      buildRuntime(settings: PluginSettings): Promise<unknown>;
    };
    const original = internal.buildRuntime.bind(plugin);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(internal, "buildRuntime").mockImplementation(async (settings) => {
      await blocked;
      return original(settings);
    });
    const applying = plugin.applySettings({
      ...DEFAULT_SETTINGS,
      picgoOrigin: "http://localhost:36678",
    });
    await vi.waitFor(() => expect(internal.buildRuntime).toHaveBeenCalled());
    let shutdownFinished = false;
    const shuttingDown = plugin.shutdown().then(() => {
      shutdownFinished = true;
    });
    await Promise.resolve();
    expect(shutdownFinished).toBe(false);
    release();
    await Promise.allSettled([applying, shuttingDown]);
    expect(plugin.runtimeIdentity()).toBeUndefined();
    expect(app.workspace.onLayoutReady).toHaveBeenCalledTimes(1);
  });

  it("rolls back durable settings and restarts the old runtime when replacement pruning fails", async () => {
    const app = pluginApp();
    const plugin = pluginFor(app);
    await plugin.onload();
    const old = plugin.runtimeIdentity() as {
      snapshot(): { state: string };
    };
    const repository = (
      plugin as unknown as { repository: PluginDataRepository }
    ).repository;
    let attempt = 0;
    let rejectPrune!: (error: Error) => void;
    const prune = new Promise<void>((_resolve, reject) => {
      rejectPrune = reject;
    });
    const saved: unknown[] = [];
    vi.spyOn(plugin, "saveData").mockImplementation(async (value) => {
      attempt++;
      if (attempt === 2) return prune;
      saved.push(structuredClone(value));
    });
    const applying = plugin.applySettings({
      ...DEFAULT_SETTINGS,
      picgoOrigin: "http://localhost:36678",
    });
    await vi.waitFor(() => expect(attempt).toBe(2));
    const checkpoint: JobSnapshot = {
      jobs: [
        {
          vaultPath: "attachments/checkpoint.png",
          state: "queued",
          createdAt: 1,
          updatedAt: 1,
          rewrittenNotePaths: [],
          rewrittenReferenceCount: 0,
        },
      ],
      logs: [],
    };
    const checkpointSave = repository.save(checkpoint);
    rejectPrune(new Error("C:\\private\\prune"));
    await checkpointSave;
    await expect(applying).rejects.toThrow();
    expect(repository.settings().picgoOrigin).toBe(
      DEFAULT_SETTINGS.picgoOrigin,
    );
    expect((await repository.loadJobs()).jobs).toEqual(checkpoint.jobs);
    expect(plugin.runtimeIdentity()).toBe(old);
    expect(old.snapshot().state).toBe("running");
    expect(saved.at(-1)).toMatchObject({
      settings: { picgoOrigin: DEFAULT_SETTINGS.picgoOrigin },
      jobs: checkpoint.jobs,
    });
    await plugin.shutdown();
  });
});
