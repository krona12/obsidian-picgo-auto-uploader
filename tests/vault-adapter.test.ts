import type { EventRef, TFile, Vault } from "obsidian";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SourceFingerprint } from "../src/domain";
import {
  cleanupStaleSnapshotDirectories,
  ObsidianVaultAdapter,
  SNAPSHOT_DIRECTORY_PREFIX,
  type SnapshotMaintenance,
  type SourceVault,
} from "../src/obsidian/vault-adapter";

function sourceFixture(maintenance?: SnapshotMaintenance) {
  const bytes = new Uint8Array([1]);
  const file = {
    path: "attachments/image.png",
    name: "image.png",
    basename: "image",
    extension: "png",
    parent: null,
    stat: { ctime: 1, mtime: 2, size: bytes.byteLength },
  } as TFile;
  const vault: SourceVault = {
    getFiles: () => [file],
    readBinary: async () => bytes.buffer.slice(0),
    delete: async () => {},
    adapter: {
      stat: async () => ({ ...file.stat, type: "file" as const }),
    },
    on: () => ({}) as EventRef,
    offref: () => {},
  };
  file.vault = vault as unknown as Vault;
  return { adapter: new ObsidianVaultAdapter(vault, maintenance), file };
}

describe("temporary upload snapshot maintenance", () => {
  it("removes only stale plugin snapshot directories from a supplied temp root", async () => {
    const root = await mkdtemp(join(tmpdir(), "picgo-cleanup-test-"));
    const stale = join(
      root,
      `${SNAPSHOT_DIRECTORY_PREFIX}2147483647-00000000-0000-4000-8000-000000000000`,
    );
    const live = join(
      root,
      `${SNAPSHOT_DIRECTORY_PREFIX}${process.pid}-00000000-0000-4000-8000-000000000001`,
    );
    const unrelated = join(root, "keep-me");
    try {
      await mkdir(stale);
      await writeFile(join(stale, "private.png"), new Uint8Array([1]));
      await mkdir(live);
      await mkdir(unrelated);
      await cleanupStaleSnapshotDirectories(root);

      expect(existsSync(stale)).toBe(false);
      expect(existsSync(live)).toBe(true);
      expect(existsSync(unrelated)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a confirmed upload result when snapshot cleanup must be retried later", async () => {
    let snapshotPath = "";
    let allowCleanup = false;
    const maintenance: SnapshotMaintenance = {
      initialize: async () => {},
      remove: async (directory) => {
        if (!allowCleanup) throw new Error("temporary Windows file lock");
        await rm(directory, { recursive: true, force: true });
      },
    };
    const { adapter, file } = sourceFixture(maintenance);
    const expected: SourceFingerprint = { size: 1, mtime: 2 };
    try {
      const result = await adapter.upload(
        file,
        expected,
        {
          uploadOne: async (path) => {
            snapshotPath = path;
            return { ok: true, value: "https://cdn.test/image.png" };
          },
        },
        new AbortController().signal,
      );

      expect(result).toEqual({
        ok: true,
        value: {
          remoteUrl: "https://cdn.test/image.png",
          fingerprint: {
            size: 1,
            mtime: 2,
            sha256:
              "4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a",
          },
          pendingSnapshotId: expect.stringMatching(
            /^obsidian-picgo-\d+-[0-9a-f-]+$/,
          ),
        },
      });
      expect(existsSync(snapshotPath)).toBe(true);
      if (!result.ok) throw new Error("Expected a confirmed upload.");
      allowCleanup = true;
      expect(
        await adapter.cleanupSnapshot(result.value.pendingSnapshotId!),
      ).toBe(true);
      expect(existsSync(snapshotPath)).toBe(false);
    } finally {
      if (snapshotPath)
        await rm(dirname(snapshotPath), { recursive: true, force: true });
    }
  });

  it("returns a cleanup checkpoint even when the upload itself fails", async () => {
    let snapshotPath = "";
    let allowCleanup = false;
    const { adapter, file } = sourceFixture({
      initialize: async () => {},
      remove: async (directory) => {
        if (!allowCleanup) throw new Error("temporary Windows file lock");
        await rm(directory, { recursive: true, force: true });
      },
    });
    try {
      const result = await adapter.upload(
        file,
        { size: 1, mtime: 2 },
        {
          uploadOne: async (path) => {
            snapshotPath = path;
            return {
              ok: false,
              error: {
                code: "picgo-failure",
                stage: "upload",
                message: "PicGo rejected the upload.",
                retry: "safe",
                state: "failed",
              },
            };
          },
        },
        new AbortController().signal,
      );

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "picgo-failure",
          pendingSnapshotId: expect.stringMatching(
            /^obsidian-picgo-\d+-[0-9a-f-]+$/,
          ),
        },
      });
      if (result.ok) throw new Error("Expected upload failure.");
      expect(existsSync(snapshotPath)).toBe(true);
      allowCleanup = true;
      expect(
        await adapter.cleanupSnapshot(result.error.pendingSnapshotId!),
      ).toBe(true);
      expect(existsSync(snapshotPath)).toBe(false);
    } finally {
      if (snapshotPath)
        await rm(dirname(snapshotPath), { recursive: true, force: true });
    }
  });
});
