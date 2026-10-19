import type { CachedMetadata, EventRef, TFile, Vault } from "obsidian";
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
import { ObsidianVaultAdapter } from "../src/obsidian/vault-adapter";
import { AttachmentProcessor } from "../src/attachment-processor";
import { UploadQueue } from "../src/upload-queue";

export function fixture(initial?: JobSnapshot, storeOptions?: JobStoreOptions) {
  const settings = sanitizeSettings({
    quietPeriodMs: 10,
    stabilitySampleIntervalMs: 1,
    reconciliationIntervalMs: 100,
    picgoSecret: "private-secret",
  });
  const files: TFile[] = [];
  const text = new Map<TFile, string>();
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
  const trash: string[] = [];
  const checkpoints: JobSnapshot[] = [];
  let uploads = 0;
  let failNote = "";
  let failTrash = false;
  let refresh = true;
  let pendingUpload = false;
  let uploadAborted = false;
  let holdAbort = false;
  let releaseAbort: (() => void) | undefined;
  let saveFailures = 0;
  let failLog = false;
  let statReads = 0;
  let statHook: (() => void) | undefined;
  let saveFailureState = "";
  let afterWrite: (() => void) | undefined;
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
      trash.push(file.path);
      files.splice(files.indexOf(file), 1);
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
  const adapter = new ObsidianVaultAdapter({
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
  });
  const client = new PicGoClient(settings, {
    async request(_request, signal) {
      uploads++;
      if (pendingUpload)
        return new Promise((resolve) => {
          const abort = () => {
            uploadAborted = true;
            const finish = () =>
              resolve({
                ok: false,
                error: { kind: "aborted", dispatched: true },
              });
            if (holdAbort) releaseAbort = finish;
            else finish();
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
  const queue = new UploadQueue(store, (job, signal) =>
    processor.process(job.vaultPath, signal),
  );
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
    trash,
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
    statReads: () => statReads,
    statHook: (callback: () => void) => {
      statHook = callback;
    },
    setRefresh: (value: boolean) => {
      refresh = value;
    },
    blockUpload: () => {
      pendingUpload = true;
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
    afterWrite: (callback: () => void) => {
      afterWrite = callback;
    },
    job: () => store.snapshot().jobs[0]!,
    async run() {
      await queue.enqueue(source.path);
      await queue.drain();
    },
  };
}
