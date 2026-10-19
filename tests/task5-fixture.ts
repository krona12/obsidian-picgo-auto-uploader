import type { CachedMetadata, EventRef, TFile, Vault } from "obsidian";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { sanitizeSettings } from "../src/defaults";
import {
  JobStore,
  type JobSnapshot,
  type JobStoreOptions,
} from "../src/job-store";
import { PicGoClient, type PicGoTransportResult } from "../src/picgo-client";
import { StabilityGate } from "../src/stability-gate";
import {
  ObsidianReferenceService,
  type ReferenceMetadata,
  type ReferenceVault,
} from "../src/obsidian/reference-service";
import {
  ObsidianVaultAdapter,
  type SnapshotMaintenance,
} from "../src/obsidian/vault-adapter";
import { AttachmentProcessor } from "../src/attachment-processor";
import { UploadQueue } from "../src/upload-queue";

export function fixture(
  initial?: JobSnapshot,
  storeOptions?: JobStoreOptions,
  snapshotMaintenance?: SnapshotMaintenance,
) {
  const settings = sanitizeSettings({
    quietPeriodMs: 10,
    stabilitySampleIntervalMs: 1,
    reconciliationIntervalMs: 100,
    picgoSecret: "private-secret",
  });
  const files: TFile[] = [];
  const text = new Map<TFile, string>();
  const binary = new Map<TFile, Uint8Array>();
  const caches = new Map<TFile, CachedMetadata>();
  type MetadataEventName = "changed" | "deleted" | "resolve" | "resolved";
  type MetadataEventCallback = (...args: unknown[]) => void;
  const metadataListeners = new Map<
    EventRef,
    { name: MetadataEventName; callback: MetadataEventCallback }
  >();
  type VaultEventName = "create" | "modify" | "rename" | "delete";
  type VaultEventCallback = (file: TFile, oldPath?: string) => void;
  const eventListeners = new Map<
    EventRef,
    { name: VaultEventName; callback: VaultEventCallback }
  >();
  const readyListeners = new Set<() => void>();
  const writes: string[] = [];
  const deleted: string[] = [];
  const legacyTrash: string[] = [];
  const checkpoints: JobSnapshot[] = [];
  let uploads = 0;
  const uploadedSources: string[] = [];
  const uploadedBytes: number[][] = [];
  let failNote = "";
  let failTrash = false;
  let rejectDeleteAfterRemoval = false;
  let leaveSourceAfterDelete = false;
  let refresh = true;
  let pendingUpload = false;
  let uploadAborted = false;
  let holdAbort = false;
  let releaseAbort: (() => void) | undefined;
  let releaseUpload: (() => void) | undefined;
  let saveFailures = 0;
  let failLog = false;
  let statReads = 0;
  let statHook: (() => void) | undefined;
  let binaryReads = 0;
  let binaryReadHook: (() => void) | undefined;
  let uploadRequestHook: (() => void) | undefined;
  let saveFailureState = "";
  let afterWrite: (() => void) | undefined;
  let holdWorkerAfterProcess = false;
  let reportWorkerAfterProcess!: () => void;
  let releaseWorkerAfterProcess!: () => void;
  const workerAfterProcess = new Promise<void>((resolve) => {
    reportWorkerAfterProcess = resolve;
  });
  const workerRelease = new Promise<void>((resolve) => {
    releaseWorkerAfterProcess = resolve;
  });
  let response: PicGoTransportResult = {
    ok: true,
    value: {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        result: ["https://cdn.test/image.png"],
      }),
    },
  };
  const vault: ReferenceVault & {
    readBinary(file: TFile): Promise<ArrayBuffer>;
    delete(file: TFile, force?: boolean): Promise<void>;
    trash(file: TFile, system: boolean): Promise<void>;
    on(name: VaultEventName, callback: VaultEventCallback): EventRef;
    offref(ref: EventRef): void;
  } = {
    getFiles: () => [...files],
    getMarkdownFiles: () => files.filter((f) => f.extension === "md"),
    async read(file) {
      if (!text.has(file)) throw new Error("C:\\private\\missing");
      return text.get(file)!;
    },
    async readBinary(file) {
      binaryReads++;
      binaryReadHook?.();
      const value = binary.get(file) ?? new Uint8Array();
      return value.buffer.slice(
        value.byteOffset,
        value.byteOffset + value.byteLength,
      ) as ArrayBuffer;
    },
    async process(file, transform) {
      if (file.path === failNote)
        throw new Error("C:\\private\\write private-secret");
      const next = transform(await vault.read(file));
      text.set(file, next);
      writes.push(file.path);
      caches.set(file, {});
      if (refresh)
        for (const listener of metadataListeners.values())
          if (listener.name === "changed") listener.callback(file, next, {});
      afterWrite?.();
      return next;
    },
    async trash(file, system) {
      if (system !== false) throw new Error("Must use Vault trash");
      if (failTrash) throw new Error("C:\\private\\trash private-secret");
      legacyTrash.push(file.path);
      files.splice(files.indexOf(file), 1);
    },
    async delete(file, force) {
      if (force !== true) throw new Error("Must force permanent deletion");
      if (failTrash) throw new Error("C:\\private\\delete private-secret");
      if (leaveSourceAfterDelete) return;
      deleted.push(file.path);
      files.splice(files.indexOf(file), 1);
      if (rejectDeleteAfterRemoval)
        throw new Error("C:\\private\\delete-after-remove private-secret");
    },
    on(name, callback) {
      const ref = {};
      eventListeners.set(ref, {
        name,
        callback: callback as unknown as VaultEventCallback,
      });
      return ref;
    },
    offref(ref) {
      eventListeners.delete(ref);
    },
  };
  const metadata: ReferenceMetadata = {
    getFileCache: (file) => caches.get(file) ?? null,
    getFirstLinkpathDest: (link) => files.find((f) => f.path === link) ?? null,
    on(name, cb) {
      const ref = {};
      metadataListeners.set(ref, {
        name,
        callback: cb as unknown as MetadataEventCallback,
      });
      return ref;
    },
    offref(ref) {
      metadataListeners.delete(ref);
    },
  };
  function add(path: string, content = "") {
    const name = path.split("/").at(-1)!;
    const file: TFile = {
      path,
      name,
      basename: name.slice(0, name.lastIndexOf(".")),
      extension: name.split(".").at(-1)!,
      parent: null,
      vault: vault as unknown as Vault,
      stat: { ctime: 1, mtime: 2, size: content.length },
    };
    files.push(file);
    text.set(file, content);
    binary.set(file, new TextEncoder().encode(content));
    caches.set(file, {
      embeds: content
        ? [
            {
              link: "attachments/image.png",
              original: content,
              position: {
                start: { line: 0, col: 0, offset: 0 },
                end: { line: 0, col: content.length, offset: content.length },
              },
            },
          ]
        : [],
    });
    return file;
  }
  const source = add("attachments/image.png");
  binary.set(source, new Uint8Array([1]));
  source.stat.size = 1;
  const note = add("note.md", "![[attachments/image.png]]");
  const store = new JobStore(
    {
      async load() {
        return initial ? structuredClone(initial) : null;
      },
      async save(snapshot) {
        if (failLog && snapshot.logs.length) {
          failLog = false;
          throw new Error("C:\\private\\log private-secret");
        }
        if (snapshot.jobs[0]?.state === saveFailureState) {
          saveFailures++;
          saveFailureState = "";
          throw new Error("C:\\private\\persistence private-secret");
        }
        checkpoints.push(structuredClone(snapshot));
      },
    },
    storeOptions,
  );
  const adapter = new ObsidianVaultAdapter(
    {
      ...vault,
      adapter: {
        getFullPath: (path) => `C:\\private\\vault\\${path}`,
        async stat(path) {
          statReads++;
          statHook?.();
          const file = files.find((f) => f.path === path);
          return file ? { ...file.stat, type: "file" as const } : null;
        },
      },
      on: vault.on,
      offref: vault.offref,
    },
    snapshotMaintenance,
  );
  const client = new PicGoClient(settings, {
    async request(request, signal) {
      uploads++;
      const body = JSON.parse(request.body ?? "{}") as { list?: unknown[] };
      const uploadSource = body.list?.[0];
      if (typeof uploadSource === "string") {
        uploadedSources.push(uploadSource);
        uploadedBytes.push(
          existsSync(uploadSource) ? [...(await readFile(uploadSource))] : [],
        );
      }
      uploadRequestHook?.();
      if (pendingUpload)
        return new Promise((resolve) => {
          let settled = false;
          const finish = (result: PicGoTransportResult) => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener("abort", abort);
            releaseUpload = undefined;
            resolve(result);
          };
          const abort = () => {
            uploadAborted = true;
            const finishAbort = () =>
              finish({
                ok: false,
                error: { kind: "aborted", dispatched: true },
              });
            if (holdAbort) releaseAbort = finishAbort;
            else finishAbort();
          };
          releaseUpload = () => {
            pendingUpload = false;
            finish(response);
          };
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) abort();
        });
      return response;
    },
  });
  const references = new ObsidianReferenceService(vault, metadata);
  let clock = 0;
  const stability = new StabilityGate(adapter, {
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  const processor = new AttachmentProcessor({
    settings,
    store,
    source: adapter,
    stability,
    client,
    references,
  });
  const queue = new UploadQueue(store, async (job, signal) => {
    await processor.process(job.vaultPath, signal);
    if (holdWorkerAfterProcess) {
      reportWorkerAfterProcess();
      await workerRelease;
    }
  });
  const lifecycle = {
    onLayoutReady(callback: () => void) {
      readyListeners.add(callback);
      return () => {
        readyListeners.delete(callback);
      };
    },
    onFileEvent(callback: (path: string) => void) {
      return adapter.onFileEvent(callback);
    },
    listPaths: () => adapter.listPaths(),
    stat: (path: string) => adapter.stat(path),
  };
  return {
    settings,
    files,
    text,
    binary,
    caches,
    source,
    note,
    store,
    adapter,
    client,
    references,
    stability,
    processor,
    queue,
    lifecycle,
    writes,
    trash: deleted,
    legacyTrash,
    checkpoints,
    metadataListeners,
    eventListeners,
    readyListeners,
    add,
    ready: () => {
      for (const cb of [...readyListeners]) cb();
    },
    event: (file = source) => {
      for (const listener of eventListeners.values())
        if (listener.name === "create") listener.callback(file);
    },
    vaultEvent: (name: VaultEventName, file: TFile, oldPath?: string) => {
      for (const listener of eventListeners.values())
        if (listener.name === name) listener.callback(file, oldPath);
    },
    metadataEvent: (name: MetadataEventName, file = note) => {
      for (const listener of metadataListeners.values()) {
        if (listener.name !== name) continue;
        if (name === "changed")
          listener.callback(file, text.get(file) ?? "", {});
        else if (name === "deleted") listener.callback(file, null);
        else if (name === "resolve") listener.callback(file);
        else listener.callback();
      }
    },
    uploads: () => uploads,
    uploadedSources,
    uploadedBytes,
    statReads: () => statReads,
    binaryReads: () => binaryReads,
    statHook: (callback: () => void) => {
      statHook = callback;
    },
    binaryReadHook: (callback: () => void) => {
      binaryReadHook = callback;
    },
    onUploadRequest: (callback: () => void) => {
      uploadRequestHook = callback;
    },
    setRefresh: (value: boolean) => {
      refresh = value;
    },
    blockUpload: () => {
      pendingUpload = true;
    },
    releaseUpload: () => {
      releaseUpload?.();
    },
    holdWorkerAfterProcess: () => {
      holdWorkerAfterProcess = true;
    },
    workerAfterProcess: () => workerAfterProcess,
    releaseWorkerAfterProcess: () => {
      holdWorkerAfterProcess = false;
      releaseWorkerAfterProcess();
    },
    uploadAborted: () => uploadAborted,
    holdUploadAbort: () => {
      holdAbort = true;
    },
    releaseUploadAbort: () => {
      releaseAbort?.();
    },
    saveFailures: () => saveFailures,
    failLogSave: () => {
      failLog = true;
    },
    failSave: (state: string) => {
      saveFailureState = state;
    },
    setResponse: (value: PicGoTransportResult) => {
      response = value;
    },
    failNote: (value: string) => {
      failNote = value;
    },
    failTrash: (value = true) => {
      failTrash = value;
    },
    rejectDeleteAfterRemoval: (value = true) => {
      rejectDeleteAfterRemoval = value;
    },
    leaveSourceAfterDelete: (value = true) => {
      leaveSourceAfterDelete = value;
    },
    afterWrite: (callback: () => void) => {
      afterWrite = callback;
    },
    setSourceBytes: (value: readonly number[]) => {
      binary.set(source, Uint8Array.from(value));
    },
    job: () => store.snapshot().jobs[0]!,
    async run() {
      await queue.enqueue(source.path);
      await queue.drain();
    },
  };
}
