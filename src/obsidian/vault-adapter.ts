import type {
  DataAdapter,
  EventRef,
  TAbstractFile,
  TFile,
  Vault,
} from "obsidian";
import type { SourcePort } from "../attachment-processor";
import type { SourceFingerprint } from "../domain";
import { normalizeVaultPath } from "../path-policy";
import type { PicGoClient } from "../picgo-client";

export interface SourceVault extends Pick<
  Vault,
  "getFiles" | "trash" | "offref"
> {
  adapter: Pick<DataAdapter, "stat"> & { getFullPath?(path: string): string };
  on(
    name: "create" | "modify",
    callback: (file: TAbstractFile) => void,
  ): EventRef;
}
/** Absolute paths live only in the call from this adapter to the upload client. */
export class ObsidianVaultAdapter implements SourcePort<TFile> {
  constructor(private readonly vault: SourceVault) {}
  get(path: string): TFile | null {
    const normalized = normalizeVaultPath(path);
    return normalized
      ? (this.vault.getFiles().find((file) => file.path === normalized) ?? null)
      : null;
  }
  async stat(path: string): Promise<SourceFingerprint | null> {
    const file = this.get(path);
    if (!file) return null;
    const stat = await this.vault.adapter.stat(file.path);
    return stat?.type === "file" && this.get(path) === file
      ? { size: stat.size, mtime: stat.mtime }
      : null;
  }
  listPaths(): string[] {
    return this.vault.getFiles().map((file) => file.path);
  }
  onFileEvent(callback: (path: string) => void): () => void {
    const refs = [
      this.vault.on("create", (file) => callback(file.path)),
      this.vault.on("modify", (file) => callback(file.path)),
    ];
    return () => {
      for (const ref of refs) this.vault.offref(ref);
    };
  }
  upload(
    file: TFile,
    client: Pick<PicGoClient, "uploadOne">,
    signal: AbortSignal,
  ): ReturnType<PicGoClient["uploadOne"]> {
    if (this.get(file.path) !== file || !this.vault.adapter.getFullPath)
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
    return client.uploadOne(this.vault.adapter.getFullPath(file.path), signal);
  }
  async trash(file: TFile, system: false): Promise<void> {
    if (this.get(file.path) !== file)
      throw new Error("The source identity changed.");
    await this.vault.trash(file, system);
  }
}
