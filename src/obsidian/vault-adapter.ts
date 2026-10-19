import type {
  DataAdapter,
  EventRef,
  TAbstractFile,
  TFile,
  Vault,
} from "obsidian";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { SourcePort } from "../attachment-processor";
import type { SourceFingerprint } from "../domain";
import { normalizeVaultPath } from "../path-policy";
import type { PicGoClient } from "../picgo-client";
import type { ReferenceMutationProof } from "./reference-service";

export interface SourceVault extends Pick<
  Vault,
  "delete" | "getFiles" | "offref" | "readBinary"
> {
  adapter: Pick<DataAdapter, "stat"> & { getFullPath?(path: string): string };
  on(
    name: "create" | "modify" | "delete",
    callback: (file: TAbstractFile) => void,
  ): EventRef;
  on(
    name: "rename",
    callback: (file: TAbstractFile, oldPath: string) => void,
  ): EventRef;
}

export const SNAPSHOT_DIRECTORY_PREFIX = "obsidian-picgo-";
const activeSnapshotDirectories = new Set<string>();
const snapshotIdPattern = /^obsidian-picgo-\d+-[0-9a-f-]+$/i;

function isExactSnapshotChild(root: string, path: string): boolean {
  return (
    resolve(dirname(path)) === resolve(root) &&
    basename(path).startsWith(SNAPSHOT_DIRECTORY_PREFIX)
  );
}

async function removeSnapshotDirectory(
  path: string,
  root = tmpdir(),
): Promise<void> {
  if (!isExactSnapshotChild(root, path))
    throw new Error("Refusing to remove an invalid snapshot directory.");
  await rm(path, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  });
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Best-effort crash recovery for private snapshots owned by this plugin. */
export async function cleanupStaleSnapshotDirectories(
  root = tmpdir(),
): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      !entry.name.startsWith(SNAPSHOT_DIRECTORY_PREFIX)
    )
      continue;
    const path = join(root, entry.name);
    if (activeSnapshotDirectories.has(path)) continue;
    const owned = snapshotIdPattern.exec(entry.name);
    // Unknown/legacy lookalikes have no verifiable owner and are left alone.
    if (!owned) continue;
    const pid = Number(/^obsidian-picgo-(\d+)-/i.exec(entry.name)?.[1]);
    // This also protects another Vault running in the same Obsidian process.
    if (processIsAlive(pid)) continue;
    try {
      await removeSnapshotDirectory(path, root);
    } catch {
      // A later startup or upload will retry the same tightly scoped cleanup.
    }
  }
}

export interface SnapshotMaintenance {
  initialize(): Promise<void>;
  remove(directory: string): Promise<void>;
}

const defaultSnapshotMaintenance: SnapshotMaintenance = {
  initialize: () => cleanupStaleSnapshotDirectories(),
  remove: (directory) => removeSnapshotDirectory(directory),
};

/** Absolute paths live only in the call from this adapter to the upload client. */
export class ObsidianVaultAdapter implements SourcePort<TFile> {
  private readonly cleanupReady: Promise<void>;
  constructor(
    private readonly vault: SourceVault,
    private readonly snapshotMaintenance: SnapshotMaintenance = defaultSnapshotMaintenance,
  ) {
    this.cleanupReady = this.snapshotMaintenance.initialize().catch(() => {});
  }
  async initialize(): Promise<void> {
    await this.cleanupReady;
  }
  async cleanupSnapshot(snapshotId: string): Promise<boolean> {
    await this.cleanupReady;
    if (!snapshotIdPattern.test(snapshotId)) return false;
    const directory = join(tmpdir(), snapshotId);
    if (
      !isExactSnapshotChild(tmpdir(), directory) ||
      activeSnapshotDirectories.has(directory)
    )
      return false;
    try {
      await this.snapshotMaintenance.remove(directory);
      return true;
    } catch {
      return false;
    }
  }
  get(path: string): TFile | null {
    const normalized = normalizeVaultPath(path);
    return normalized
      ? (this.vault.getFiles().find((file) => file.path === normalized) ?? null)
      : null;
  }
  async stat(path: string): Promise<SourceFingerprint | null> {
    const file = this.get(path);
    if (!file) return null;
    const physical = await this.vault.adapter.stat(file.path);
    return physical?.type === "file" && this.get(path) === file
      ? { size: physical.size, mtime: physical.mtime }
      : null;
  }
  listPaths(): string[] {
    return this.vault.getFiles().map((file) => file.path);
  }
  onFileEvent(callback: (path: string) => void): () => void {
    const refs = [
      this.vault.on("create", (file) => callback(file.path)),
      this.vault.on("modify", (file) => callback(file.path)),
      this.vault.on("rename", (file, oldPath) => {
        callback(oldPath);
        if (file.path !== oldPath) callback(file.path);
      }),
      this.vault.on("delete", (file) => callback(file.path)),
    ];
    return () => {
      for (const ref of refs) this.vault.offref(ref);
    };
  }
  upload(
    file: TFile,
    expectedFingerprint: SourceFingerprint,
    client: Pick<PicGoClient, "uploadOne">,
    signal: AbortSignal,
  ): ReturnType<SourcePort<TFile>["upload"]> {
    if (this.get(file.path) !== file)
      return Promise.resolve({
        ok: false,
        error: {
          code: "source-unavailable",
          stage: "path",
          message: "The source is unavailable on this device.",
          retry: "safe",
          state: "failed",
        },
      });
    return this.uploadSnapshot(file, expectedFingerprint, client, signal);
  }

  private async uploadSnapshot(
    file: TFile,
    expectedFingerprint: SourceFingerprint,
    client: Pick<PicGoClient, "uploadOne">,
    signal: AbortSignal,
  ): ReturnType<SourcePort<TFile>["upload"]> {
    let directory: string | undefined;
    let snapshotPath: string | undefined;
    let dispatched = false;
    let uploaded: Awaited<ReturnType<SourcePort<TFile>["upload"]>> | undefined;
    try {
      await this.cleanupReady;
      if (signal.aborted)
        return {
          ok: false,
          error: {
            code: "aborted",
            stage: "upload",
            message: "The upload was cancelled before snapshot creation.",
            retry: "non-retryable",
            state: "cancelled",
          },
        };
      const captured = await this.capture(file);
      if (!captured)
        throw new Error("The source is unavailable for snapshotting.");
      const { bytes, fingerprint: actual } = captured;
      if (
        actual.size !== expectedFingerprint.size ||
        actual.mtime !== expectedFingerprint.mtime ||
        (expectedFingerprint.sha256 !== undefined &&
          actual.sha256 !== expectedFingerprint.sha256)
      )
        return {
          ok: false,
          error: {
            code: "source-changed",
            stage: "upload",
            message: "The source changed before its upload snapshot was made.",
            retry: "safe",
            state: "failed",
          },
        };
      if (basename(file.name) !== file.name)
        throw new Error("Invalid snapshot filename.");
      directory = join(
        tmpdir(),
        `${SNAPSHOT_DIRECTORY_PREFIX}${process.pid}-${randomUUID()}`,
      );
      activeSnapshotDirectories.add(directory);
      await mkdir(directory);
      snapshotPath = join(directory, file.name);
      await writeFile(snapshotPath, new Uint8Array(bytes), { flag: "wx" });
      dispatched = true;
      const result = await client.uploadOne(snapshotPath, signal);
      if (!result.ok) uploaded = result;
      else {
        const after = await readFile(snapshotPath);
        const afterHash = createHash("sha256").update(after).digest("hex");
        uploaded =
          after.length === actual.size && afterHash === actual.sha256
            ? {
                ok: true,
                value: {
                  remoteUrl: result.value,
                  fingerprint: actual,
                },
              }
            : {
                ok: false,
                error: {
                  code: "snapshot-changed",
                  stage: "upload",
                  message: "The upload snapshot changed during the request.",
                  retry: "uncertain",
                  state: "uncertain",
                },
              };
      }
    } catch {
      if (!uploaded)
        uploaded = {
          ok: false,
          error: {
            code: dispatched ? "snapshot-upload-failed" : "snapshot-failed",
            stage: "upload",
            message: dispatched
              ? "The snapshot upload ended without a confirmed result."
              : "A private upload snapshot could not be prepared.",
            retry: dispatched ? "uncertain" : "safe",
            state: dispatched ? "uncertain" : "failed",
          },
        };
    }
    let cleanupFailed = false;
    if (directory)
      try {
        await this.snapshotMaintenance.remove(directory);
      } catch {
        cleanupFailed = true;
      } finally {
        activeSnapshotDirectories.delete(directory);
      }
    if (cleanupFailed && directory && uploaded)
      uploaded = uploaded.ok
        ? {
            ok: true,
            value: {
              ...uploaded.value,
              pendingSnapshotId: basename(directory),
            },
          }
        : {
            ok: false,
            error: {
              ...uploaded.error,
              pendingSnapshotId: basename(directory),
            },
          };
    return uploaded!;
  }

  async fingerprint(file: TFile): Promise<SourceFingerprint | null> {
    return (await this.capture(file))?.fingerprint ?? null;
  }

  private async capture(
    file: TFile,
  ): Promise<{ bytes: ArrayBuffer; fingerprint: SourceFingerprint } | null> {
    if (this.get(file.path) !== file) return null;
    const before = { size: file.stat.size, mtime: file.stat.mtime };
    const bytes = await this.vault.readBinary(file);
    const physical = await this.vault.adapter.stat(file.path);
    if (
      this.get(file.path) !== file ||
      physical?.type !== "file" ||
      physical.size !== before.size ||
      physical.mtime !== before.mtime ||
      file.stat.size !== before.size ||
      file.stat.mtime !== before.mtime ||
      bytes.byteLength !== before.size
    )
      return null;
    return {
      bytes,
      fingerprint: {
        ...before,
        sha256: createHash("sha256")
          .update(new Uint8Array(bytes))
          .digest("hex"),
      },
    };
  }

  async deletePermanently(
    file: TFile,
    expectedFingerprint: SourceFingerprint,
    proof: ReferenceMutationProof,
  ): Promise<void> {
    const current = await this.fingerprint(file);
    if (!proof.isValid())
      throw new Error("The reference verification proof is stale.");
    if (
      !current ||
      current.size !== expectedFingerprint.size ||
      current.mtime !== expectedFingerprint.mtime ||
      !expectedFingerprint.sha256 ||
      current.sha256 !== expectedFingerprint.sha256 ||
      this.get(file.path) !== file
    )
      throw new Error("The source identity changed.");
    await this.vault.delete(file, true);
  }
}
