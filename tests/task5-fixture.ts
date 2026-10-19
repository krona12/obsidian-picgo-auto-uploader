import type { CachedMetadata, EventRef, TFile, Vault } from "obsidian";
import { sanitizeSettings } from "../src/defaults";
import { JobStore, type JobSnapshot } from "../src/job-store";
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

export function fixture() {
  const settings = sanitizeSettings({
    quietPeriodMs: 10,
    stabilitySampleIntervalMs: 1,
    reconciliationIntervalMs: 100,
    picgoSecret: "private-secret",
  });
  const files: TFile[] = [];
  const text = new Map<TFile, string>();
  const caches = new Map<TFile, CachedMetadata>();
  const metadataListeners = new Map<
    EventRef,
    (file: TFile, data: string, cache: CachedMetadata) => void
  >();
  const eventListeners = new Map<EventRef, (file: TFile) => void>();
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
        for (const cb of metadataListeners.values()) cb(file, next, {});
      afterWrite?.();
      return next;
    },
    async trash(file, system) {
      if (system !== false) throw new Error("Must use Vault trash");
      if (failTrash) throw new Error("C:\\private\\trash private-secret");
      trash.push(file.path);
      files.splice(files.indexOf(file), 1);
    },
  };
  const metadata: ReferenceMetadata = {
    getFileCache: (file) => caches.get(file) ?? null,
    getFirstLinkpathDest: (link) => files.find((f) => f.path === link) ?? null,
    on(_name, cb) {
      const ref = {};
      metadataListeners.set(ref, cb);
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
      vault: vault as Vault,
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
  const store = new JobStore({
    async load() {
      return null;
    },
    async save(snapshot) {
      if (snapshot.jobs[0]?.state === saveFailureState) {
        saveFailureState = "";
        throw new Error("C:\\private\\persistence private-secret");
      }
      checkpoints.push(structuredClone(snapshot));
    },
  });
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
    on(_name, callback) {
      const ref = {};
      eventListeners.set(ref, callback);
      return ref;
    },
    offref(ref) {
      eventListeners.delete(ref);
    },
  });
  const client = new PicGoClient(settings, {
    async request(_request, signal) {
      uploads++;
      if (pendingUpload)
        return new Promise((resolve) => {
          const abort = () => {
            uploadAborted = true;
            resolve({
              ok: false,
              error: { kind: "aborted", dispatched: true },
            });
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
      for (const cb of eventListeners.values()) cb(file);
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
