// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import type { JobSnapshot } from "../src/job-store";
import PicGoAutoUploaderPlugin, {
  PluginDataRepository,
  createPluginDiagnosticExport,
} from "../src/main";

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
});
