import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { Vault } from "obsidian";
import type { SourceVault } from "../src/obsidian/vault-adapter";
import {
  canTrash,
  sameFingerprint,
  type TrashInput,
} from "../src/attachment-processor";
import { fixture } from "./task5-fixture";
afterEach(() => vi.useRealTimers());

describe("deletion proof", () => {
  it("accepts the real Obsidian Vault event signatures", () => {
    expectTypeOf<Vault>().toExtend<SourceVault>();
  });
  const proof: TrashInput = {
    remoteUrl: "https://cdn.test/image.png",
    rewrittenReferenceCount: 1,
    remainingReferences: 0,
    blockers: 0,
    stableFingerprint: { size: 10, mtime: 1, sha256: "a".repeat(64) },
    currentFingerprint: { size: 10, mtime: 1, sha256: "a".repeat(64) },
    localSnapshotClean: true,
    active: true,
    exactSourceExists: true,
    referenceProofValid: true,
  };
  it("allows trash only with every independently established proof", () => {
    expect(canTrash(proof)).toBe(true);
  });
  it("does not treat equal metadata with different content hashes as the same source", () => {
    expect(
      sameFingerprint(
        { size: 10, mtime: 1, sha256: "a".repeat(64) },
        { size: 10, mtime: 1, sha256: "b".repeat(64) },
      ),
    ).toBe(false);
    expect(
      sameFingerprint(
        { size: 10, mtime: 1 },
        { size: 10, mtime: 1, sha256: "a".repeat(64) },
      ),
    ).toBe(false);
  });
  it.each([
    { remoteUrl: undefined },
    { remoteUrl: "file:///private/image.png" },
    { rewrittenReferenceCount: 0 },
    { remainingReferences: 1 },
    { blockers: 1 },
    { currentFingerprint: { size: 11, mtime: 1 } },
    { currentFingerprint: { size: 10, mtime: 2 } },
    { currentFingerprint: { size: 10, mtime: 1 } },
    { localSnapshotClean: false },
    { rewrittenReferenceCount: Number.NaN },
    { currentFingerprint: null },
    { active: false },
    { exactSourceExists: false },
    { referenceProofValid: false },
  ])("retains source when one proof is absent: %j", (patch) => {
    expect(canTrash({ ...proof, ...patch })).toBe(false);
  });
});

describe("attachment processing with real collaborators", () => {
  it("persists URL and rewrite progress before permanently deleting the exact source", async () => {
    const f = fixture();
    await f.run();
    expect(f.text.get(f.note)).toBe("![](<https://cdn.test/image.png>)");
    expect(f.trash).toEqual(["attachments/image.png"]);
    expect(f.legacyTrash).toEqual([]);
    expect(f.job()).toMatchObject({
      state: "trashed",
      remoteUrl: "https://cdn.test/image.png",
      rewrittenReferenceCount: 1,
      rewrittenNotePaths: ["note.md"],
    });
    expect(
      f.checkpoints.some(
        (s) => s.jobs[0]?.state === "rewriting" && s.jobs[0]?.remoteUrl,
      ),
    ).toBe(true);
    expect(
      f.checkpoints.some(
        (s) =>
          s.jobs[0]?.state === "verifying" &&
          s.jobs[0]?.rewrittenReferenceCount === 1,
      ),
    ).toBe(true);
    expect(
      f.checkpoints.some((snapshot) => snapshot.jobs[0]?.state === "deleting"),
    ).toBe(true);
  });

  it("keeps durable deletion intent when completion persistence fails, then reconciles without uploading", async () => {
    const f = fixture();
    f.failSave("trashed");
    await f.run();
    expect(f.files).not.toContain(f.source);
    expect(f.job().state).toBe("deleting");
    expect(f.uploads()).toBe(1);

    await f.queue.recover(f.source.path);
    await f.queue.drain();
    expect(f.job().state).toBe("trashed");
    expect(f.uploads()).toBe(1);
  });

  it("reconciles an ambiguous delete that removed the source without uploading again", async () => {
    const f = fixture();
    f.rejectDeleteAfterRemoval();
    await f.run();
    expect(f.files).not.toContain(f.source);
    expect(f.job().state).toBe("deleting");
    expect(f.uploads()).toBe(1);

    f.rejectDeleteAfterRemoval(false);
    await f.queue.recover(f.source.path);
    await f.queue.drain();
    expect(f.job().state).toBe("trashed");
    expect(f.uploads()).toBe(1);
  });

  it("does not complete a delete intent while Vault still reports the source", async () => {
    const f = fixture();
    f.leaveSourceAfterDelete();
    await f.run();
    expect(f.job().state).toBe("deleting");
    expect(f.files).toContain(f.source);
    expect(f.trash).toEqual([]);

    f.leaveSourceAfterDelete(false);
    await f.queue.recover(f.source.path);
    await f.queue.drain();
    expect(f.job().state).toBe("trashed");
    expect(f.uploads()).toBe(1);
  });

  it("stops deletion recovery when a new local reference appears", async () => {
    const f = fixture();
    f.failTrash();
    await f.run();
    expect(f.job().state).toBe("deleting");
    f.failTrash(false);
    f.add("late.md", "![[attachments/image.png]]");

    await f.queue.recover(f.source.path);
    await f.queue.drain();
    expect(f.job()).toMatchObject({
      state: "failed",
      failure: { code: "remaining-references", stage: "trash" },
    });
    expect(f.files).toContain(f.source);
    expect(f.trash).toEqual([]);
    expect(f.uploads()).toBe(1);
  });

  it("refuses to reuse a legacy saved URL that has no content hash", async () => {
    const f = fixture({
      jobs: [
        {
          vaultPath: "attachments/image.png",
          state: "queued",
          createdAt: 1,
          updatedAt: 1,
          remoteUrl: "https://cdn.test/image.png",
          fingerprint: { size: 1, mtime: 2 },
          rewrittenNotePaths: [],
          rewrittenReferenceCount: 0,
        },
      ],
      logs: [],
    });
    await f.store.hydrate();
    await f.run();
    expect(f.job()).toMatchObject({
      state: "failed",
      failure: { code: "source-changed" },
    });
    expect(f.uploads()).toBe(0);
    expect(f.trash).toEqual([]);
  });
  it("uploads an immutable temporary snapshot and removes it afterward", async () => {
    const f = fixture();
    await f.run();
    expect(f.uploadedBytes).toEqual([[1]]);
    expect(f.uploadedSources).toHaveLength(1);
    expect(f.uploadedSources[0]).not.toBe(
      "C:\\private\\vault\\attachments/image.png",
    );
    expect(existsSync(f.uploadedSources[0]!)).toBe(false);
  });
  it("does not rewrite or delete when the Vault source changes during snapshot upload", async () => {
    const f = fixture();
    let replace = true;
    f.onUploadRequest(() => {
      if (replace) f.setSourceBytes([2]);
      replace = false;
    });
    await f.run();
    expect(f.uploadedBytes).toEqual([[1]]);
    expect(f.writes).toEqual([]);
    expect(f.trash).toEqual([]);
    expect(f.job()).toMatchObject({
      state: "failed",
      failure: { code: "source-changed", stage: "upload" },
    });

    await f.queue.retry(f.source.path);
    await f.queue.drain();
    expect(f.uploadedBytes).toEqual([[1], [2]]);
    expect(f.uploads()).toBe(2);
    expect(f.job().state).toBe("trashed");
  });
  it("retains the source and saved URL until a locked upload snapshot is removed", async () => {
    let allowCleanup = false;
    let snapshotDirectory = "";
    const f = fixture(undefined, undefined, {
      initialize: async () => {},
      remove: async (directory) => {
        snapshotDirectory = directory;
        if (!allowCleanup) throw new Error("temporary Windows file lock");
        await rm(directory, { recursive: true, force: true });
      },
    });
    try {
      await f.run();
      expect(f.job()).toMatchObject({
        state: "failed",
        remoteUrl: "https://cdn.test/image.png",
        pendingSnapshotId: expect.stringMatching(
          /^obsidian-picgo-\d+-[0-9a-f-]+$/,
        ),
        failure: { code: "snapshot-cleanup-failed", stage: "upload" },
      });
      expect(f.uploads()).toBe(1);
      expect(f.writes).toEqual([]);
      expect(f.trash).toEqual([]);
      expect(f.files).toContain(f.source);
      expect(existsSync(snapshotDirectory)).toBe(true);

      allowCleanup = true;
      await f.queue.retry(f.source.path);
      await f.queue.drain();
      expect(f.job().state).toBe("trashed");
      expect(f.job().pendingSnapshotId).toBeUndefined();
      expect(f.uploads()).toBe(1);
      expect(existsSync(snapshotDirectory)).toBe(false);
    } finally {
      if (snapshotDirectory)
        await rm(snapshotDirectory, { recursive: true, force: true });
    }
  });
  it("atomically retains a confirmed URL and cleanup token when their first checkpoint save fails", async () => {
    let allowCleanup = false;
    let snapshotDirectory = "";
    const f = fixture(undefined, undefined, {
      initialize: async () => {},
      remove: async (directory) => {
        snapshotDirectory = directory;
        if (!allowCleanup) throw new Error("temporary Windows file lock");
        await rm(directory, { recursive: true, force: true });
      },
    });
    f.failSave("rewriting");
    try {
      await f.run();
      expect(f.saveFailures()).toBe(1);
      expect(f.job()).toMatchObject({
        state: "failed",
        remoteUrl: "https://cdn.test/image.png",
        pendingSnapshotId: expect.stringMatching(
          /^obsidian-picgo-\d+-[0-9a-f-]+$/,
        ),
        failure: { stage: "upload", retry: "safe" },
      });
      expect(f.uploads()).toBe(1);
      expect(f.writes).toEqual([]);
      expect(f.trash).toEqual([]);
      expect(existsSync(snapshotDirectory)).toBe(true);

      allowCleanup = true;
      await f.queue.retry(f.source.path);
      await f.queue.drain();
      expect(f.job().state).toBe("trashed");
      expect(f.uploads()).toBe(1);
      expect(existsSync(snapshotDirectory)).toBe(false);
    } finally {
      if (snapshotDirectory)
        await rm(snapshotDirectory, { recursive: true, force: true });
    }
  });
  it("cleans a failed upload snapshot before any later successful upload can delete the source", async () => {
    let allowCleanup = false;
    const snapshotDirectories: string[] = [];
    const f = fixture(undefined, undefined, {
      initialize: async () => {},
      remove: async (directory) => {
        snapshotDirectories.push(directory);
        if (!allowCleanup) throw new Error("temporary Windows file lock");
        await rm(directory, { recursive: true, force: true });
      },
    });
    f.setResponse({
      ok: true,
      value: { statusCode: 500, body: "server error" },
    });
    try {
      await f.run();
      expect(f.job()).toMatchObject({
        state: "failed",
        pendingSnapshotId: expect.stringMatching(
          /^obsidian-picgo-\d+-[0-9a-f-]+$/,
        ),
      });
      const firstDirectory = snapshotDirectories[0]!;
      expect(existsSync(firstDirectory)).toBe(true);
      expect(f.trash).toEqual([]);

      allowCleanup = true;
      f.setResponse({
        ok: true,
        value: {
          statusCode: 200,
          body: JSON.stringify({
            success: true,
            result: ["https://cdn.test/image.png"],
          }),
        },
      });
      await f.queue.retry(f.source.path);
      await f.queue.drain();

      expect(f.uploads()).toBe(2);
      expect(f.job().state).toBe("trashed");
      expect(f.job().pendingSnapshotId).toBeUndefined();
      expect(existsSync(firstDirectory)).toBe(false);
    } finally {
      for (const directory of new Set(snapshotDirectories))
        await rm(directory, { recursive: true, force: true });
    }
  });
  it("persists snapshot cleanup before rejecting an invalid successful URL", async () => {
    const f = fixture();
    const pendingSnapshotId =
      "obsidian-picgo-123-00000000-0000-4000-8000-000000000000";
    let uploads = 0;
    let cleanupCalls = 0;
    f.adapter.upload = async () => {
      uploads++;
      return {
        ok: true,
        value: {
          remoteUrl: "file:///private/not-a-remote-url.png",
          fingerprint: {
            size: 1,
            mtime: 100,
            sha256: "a".repeat(64),
          },
          pendingSnapshotId,
        },
      };
    };
    f.adapter.cleanupSnapshot = async () => {
      cleanupCalls++;
      return false;
    };

    await f.run();

    expect(f.job()).toMatchObject({
      state: "uncertain",
      pendingSnapshotId,
      failure: { code: "invalid-result", stage: "upload" },
    });
    expect(uploads).toBe(1);
    expect(cleanupCalls).toBe(0);
    expect(f.writes).toEqual([]);
    expect(f.trash).toEqual([]);

    await f.queue.retrySafeFailures();
    await f.queue.drain();
    expect(uploads).toBe(1);
    expect(f.job().pendingSnapshotId).toBe(pendingSnapshotId);
    expect(f.trash).toEqual([]);
  });
  it("retains a failed-upload cleanup token when its first terminal save fails", async () => {
    const f = fixture();
    const pendingSnapshotId =
      "obsidian-picgo-123-00000000-0000-4000-8000-000000000001";
    f.adapter.upload = async () => ({
      ok: false,
      error: {
        code: "snapshot-upload-failed",
        stage: "upload",
        message: "The snapshot upload failed.",
        retry: "safe",
        state: "failed",
        pendingSnapshotId,
      },
    });
    f.failSave("failed");

    await f.run();

    expect(f.saveFailures()).toBe(1);
    expect(f.job()).toMatchObject({
      state: "failed",
      pendingSnapshotId,
      failure: { code: "operation-failed", stage: "upload", retry: "safe" },
    });
    expect(f.writes).toEqual([]);
    expect(f.trash).toEqual([]);
  });
  it("persists a confirmed URL before a transient post-upload fingerprint failure", async () => {
    const f = fixture();
    f.binaryReadHook(() => {
      if (f.binaryReads() === 2)
        throw new Error("transient post-upload read failure");
    });

    await f.run();

    expect(f.job()).toMatchObject({
      state: "failed",
      remoteUrl: "https://cdn.test/image.png",
      failure: { stage: "upload", retry: "safe" },
    });
    expect(f.uploads()).toBe(1);
    expect(f.writes).toEqual([]);
    expect(f.trash).toEqual([]);

    f.binaryReadHook(() => {});
    await f.queue.retry(f.source.path);
    await f.queue.drain();

    expect(f.job().state).toBe("trashed");
    expect(f.uploads()).toBe(1);
  });
  it("skips an orphan safely without uploading", async () => {
    const f = fixture();
    f.files.splice(f.files.indexOf(f.note), 1);
    await f.run();
    expect(f.job()).toMatchObject({
      state: "skipped",
      failure: { code: "orphan", retry: "safe" },
    });
    expect(f.uploads()).toBe(0);
    expect(f.trash).toEqual([]);
  });
  it("blocks ambiguous references before uploading", async () => {
    const f = fixture();
    f.caches.delete(f.note);
    await f.run();
    expect(f.job()).toMatchObject({
      state: "failed",
      failure: {
        code: "missing-cache",
        stage: "reference",
        notePath: "note.md",
      },
    });
    expect(f.store.snapshot().logs).toContainEqual(
      expect.objectContaining({
        code: "missing-cache",
        notePath: "note.md",
      }),
    );
    expect(f.uploads()).toBe(0);
    expect(f.trash).toEqual([]);
  });
  it.each([
    [{ ok: false, error: { kind: "refused", dispatched: false } }, "failed"],
    [{ ok: false, error: { kind: "timeout", dispatched: true } }, "uncertain"],
  ] as const)(
    "retains source on upload response %j",
    async (response, state) => {
      const f = fixture();
      f.setResponse(response);
      await f.run();
      expect(f.job().state).toBe(state);
      expect(f.trash).toEqual([]);
      expect(f.writes).toEqual([]);
    },
  );
  it("does not safely retry an ambiguous malformed 200 upload response", async () => {
    const f = fixture();
    f.setResponse({
      ok: true,
      value: { statusCode: 200, body: "not JSON" },
    });
    await f.run();
    expect(f.job()).toMatchObject({
      state: "uncertain",
      failure: { retry: "uncertain" },
    });
    expect(f.uploads()).toBe(1);

    await f.queue.retrySafeFailures();
    await f.queue.drain();
    expect(f.uploads()).toBe(1);

    f.setResponse({
      ok: true,
      value: {
        statusCode: 200,
        body: JSON.stringify({
          success: true,
          result: ["https://cdn.test/image.png"],
        }),
      },
    });
    await f.queue.retry(f.source.path, { acknowledgeUncertain: true });
    await f.queue.drain();
    expect(f.uploads()).toBe(2);
    expect(f.job().state).toBe("trashed");
  });
  it("persists exact partial rewrites and resumes without uploading twice", async () => {
    const f = fixture();
    const second = f.add("second.md", "![[attachments/image.png]]");
    f.failNote(second.path);
    await f.run();
    expect(f.job()).toMatchObject({
      state: "failed",
      remoteUrl: "https://cdn.test/image.png",
      rewrittenReferenceCount: 1,
      rewrittenNotePaths: ["note.md"],
    });
    expect(f.trash).toEqual([]);
    f.failNote("");
    await f.queue.retry(f.source.path);
    await f.queue.drain();
    expect(f.uploads()).toBe(1);
    expect(f.job()).toMatchObject({
      state: "trashed",
      rewrittenReferenceCount: 2,
      rewrittenNotePaths: ["note.md", "second.md"],
    });
  });
  it("resumes saved URL with zero remaining references after trash failure", async () => {
    const f = fixture();
    f.failTrash();
    await f.run();
    expect(f.job()).toMatchObject({
      state: "deleting",
      rewrittenReferenceCount: 1,
    });
    expect(f.uploads()).toBe(1);
    expect(f.trash).toEqual([]);
    expect(JSON.stringify(f.store.snapshot())).not.toMatch(
      /private-secret|C:\\private/,
    );
    f.failTrash(false);
    await f.queue.recover(f.source.path);
    await f.queue.drain();
    expect(f.job().state).toBe("trashed");
    expect(f.uploads()).toBe(1);
    expect(f.trash).toEqual(["attachments/image.png"]);
  });
  it("fresh reference discovery catches a dependency added during rewrite", async () => {
    const f = fixture();
    f.afterWrite(() => {
      f.add("new.md", "![[attachments/image.png]]");
    });
    await f.run();
    expect(f.job().failure?.stage).toBe("verify");
    expect(f.trash).toEqual([]);
  });
  it.each(["changed", "missing", "replaced", "cancelled"])(
    "retains source when final check is %s",
    async (mode) => {
      const f = fixture();
      const abort = new AbortController();
      f.afterWrite(() => {
        if (mode === "changed") f.source.stat.mtime++;
        if (mode === "missing" || mode === "replaced")
          f.files.splice(f.files.indexOf(f.source), 1);
        if (mode === "replaced") f.add("attachments/image.png");
        if (mode === "cancelled") abort.abort();
      });
      await f.store.upsert({
        vaultPath: f.source.path,
        state: "queued",
        createdAt: 1,
        updatedAt: 1,
        rewrittenNotePaths: [],
        rewrittenReferenceCount: 0,
      });
      await f.processor.process(f.source.path, abort.signal);
      expect(f.trash).toEqual([]);
      expect(["failed", "cancelled"]).toContain(f.job().state);
    },
  );
  it("reuses a saved URL when only metadata changes but content is identical", async () => {
    const f = fixture();
    f.failNote(f.note.path);
    await f.run();
    f.source.stat.mtime++;
    f.failNote("");
    await f.queue.retry(f.source.path);
    await f.queue.drain();
    expect(f.uploads()).toBe(1);
    expect(f.writes).toEqual(["note.md"]);
    expect(f.trash).toEqual(["attachments/image.png"]);
    expect(f.job().state).toBe("trashed");
  });
  it("rechecks physical source metadata before upload", async () => {
    const f = fixture();
    f.statHook(() => {
      if (f.statReads() === 3) f.source.stat.mtime++;
    });
    await f.run();
    expect(f.uploads()).toBe(0);
    expect(f.job().failure?.code).toBe("source-changed");
    expect(f.trash).toEqual([]);
  });
  it("saved URL alone cannot justify deleting an orphan", async () => {
    const f = fixture();
    f.files.splice(f.files.indexOf(f.note), 1);
    const fingerprint = await f.adapter.fingerprint(f.source);
    await f.store.upsert({
      vaultPath: f.source.path,
      state: "queued",
      createdAt: 1,
      updatedAt: 1,
      remoteUrl: "https://cdn.test/image.png",
      fingerprint: fingerprint!,
      rewrittenNotePaths: [],
      rewrittenReferenceCount: 0,
    });
    await f.run();
    expect(f.job().failure?.code).toBe("orphan");
    expect(f.trash).toEqual([]);
    expect(f.uploads()).toBe(0);
  });
  it.each([
    "discover",
    "rewrite",
    "waitForRefresh",
    "verifyNoLocalReferences",
  ] as const)(
    "settles thrown %s errors without leaking native messages",
    async (method) => {
      const f = fixture();
      f.references[method] = async () => {
        throw new Error("C:\\private\\secret private-secret");
      };
      await f.run();
      expect(f.job().state).toBe("failed");
      expect(f.trash).toEqual([]);
      expect(JSON.stringify(f.store.snapshot())).not.toMatch(
        /private-secret|C:\\private/,
      );
    },
  );
  it("URL persistence failure retains the confirmed result before any rewrite", async () => {
    const f = fixture();
    f.failSave("rewriting");
    await f.run();
    expect(f.job()).toMatchObject({
      state: "failed",
      remoteUrl: "https://cdn.test/image.png",
      failure: { retry: "safe" },
    });
    expect(f.writes).toEqual([]);
    expect(f.trash).toEqual([]);
  });
  it("cancellation releases a refresh watch even before the refresh wait begins", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.setRefresh(false);
    const abort = new AbortController();
    f.afterWrite(() => abort.abort());
    await f.processor.process(f.source.path, abort.signal);
    expect(f.job().state).toBe("cancelled");
    expect(f.metadataListeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(f.trash).toEqual([]);
  });
  it("cancellation during final physical metadata check records a cancelled job", async () => {
    const f = fixture();
    const abort = new AbortController();
    f.statHook(() => {
      if (f.statReads() === 6) abort.abort();
    });
    await f.processor.process(f.source.path, abort.signal);
    expect(f.job()).toMatchObject({
      state: "cancelled",
      failure: { stage: "lifecycle" },
    });
    expect(f.trash).toEqual([]);
  });
  it("physical source changes after fresh verification still prevent trash", async () => {
    const f = fixture();
    f.statHook(() => {
      if (f.statReads() === 6) f.source.stat.mtime++;
    });
    await f.run();
    expect(f.job()).toMatchObject({
      state: "failed",
      rewrittenReferenceCount: 1,
      failure: { code: "source-changed", stage: "verify" },
    });
    expect(f.trash).toEqual([]);
  });
  it("retains same-size same-mtime replacement bytes after upload", async () => {
    const f = fixture();
    f.afterWrite(() => f.setSourceBytes([2]));
    await f.run();
    expect(f.job()).toMatchObject({
      state: "failed",
      rewrittenReferenceCount: 1,
      failure: { code: "source-changed", stage: "verify" },
    });
    expect(f.trash).toEqual([]);
    expect(f.files).toContain(f.source);
  });
  it("rehashes inside the delete adapter and retains a last-moment replacement", async () => {
    const f = fixture();
    f.binaryReadHook(() => {
      if (f.binaryReads() === 4) f.setSourceBytes([2]);
    });
    await f.run();
    expect(f.trash).toEqual([]);
    expect(f.files).toContain(f.source);
    expect(f.job().state).toBe("deleting");
    await f.queue.recover(f.source.path);
    await f.queue.drain();
    expect(f.job()).toMatchObject({
      state: "failed",
      failure: { code: "source-changed", stage: "trash" },
    });
  });
  it("retains the source when a new protected note appears during the final stat", async () => {
    const f = fixture();
    f.statHook(() => {
      if (f.statReads() !== 6) return;
      const late = f.add("late.md", "![[attachments/image.png]]");
      f.vaultEvent("create", late);
    });
    await f.run();
    expect(f.text.get(f.files.find((file) => file.path === "late.md")!)).toBe(
      "![[attachments/image.png]]",
    );
    expect(f.trash).toEqual([]);
    expect(f.job().state).toBe("failed");
  });
  it.each(["modify", "rename", "delete"] as const)(
    "invalidates final reference proof on protected-file %s",
    async (event) => {
      const f = fixture();
      f.statHook(() => {
        if (f.statReads() === 6)
          f.vaultEvent(
            event,
            f.note,
            event === "rename" ? "old.md" : undefined,
          );
      });
      await f.run();
      expect(f.trash).toEqual([]);
      expect(f.job().state).toBe("failed");
    },
  );
  it("invalidates final reference proof on unrelated attachment topology changes", async () => {
    const f = fixture();
    f.statHook(() => {
      if (f.statReads() !== 6) return;
      const other = f.add("attachments/other.png");
      f.vaultEvent("create", other);
    });
    await f.run();
    expect(f.trash).toEqual([]);
    expect(f.job().state).toBe("failed");
  });
  it("invalidates final reference proof on metadata-only resolution changes", async () => {
    const f = fixture();
    f.statHook(() => {
      if (f.statReads() === 6) f.metadataEvent("resolve");
    });
    await f.run();
    expect(f.trash).toEqual([]);
    expect(f.job().state).toBe("failed");
  });
  it("unexpected stability exceptions settle safely", async () => {
    const f = fixture();
    f.stability.wait = async () => {
      throw new Error("C:\\private\\locked private-secret");
    };
    await f.run();
    expect(f.job()).toMatchObject({
      state: "failed",
      failure: { stage: "stability" },
    });
    expect(f.uploads()).toBe(0);
    expect(f.trash).toEqual([]);
  });
  it("unexpected upload exceptions become uncertain rather than retryable", async () => {
    const f = fixture();
    f.client.uploadOne = async () => {
      throw new Error("C:\\private\\network private-secret");
    };
    await f.run();
    expect(f.job()).toMatchObject({
      state: "uncertain",
      failure: { stage: "upload", retry: "uncertain" },
    });
    expect(f.writes).toEqual([]);
    expect(f.trash).toEqual([]);
  });
  it("persists a redacted failure log after the terminal rewrite checkpoint", async () => {
    const f = fixture();
    f.failNote(f.note.path);
    await f.run();
    expect(f.store.snapshot().logs).toEqual([
      {
        timestamp: expect.any(Number),
        level: "error",
        stage: "rewrite",
        code: "process-failed",
        message: "Attachment conversion could not be completed safely.",
        notePath: "note.md",
        vaultPath: "attachments/image.png",
      },
    ]);
    expect(f.checkpoints.at(-1)?.jobs[0]?.state).toBe("failed");
    expect(JSON.stringify(f.store.snapshot().logs)).not.toMatch(
      /private-secret|C:\\private/,
    );
  });
  it("transient terminal-log persistence failure preserves a terminal job and cannot cause another upload or trash", async () => {
    const f = fixture();
    f.failNote(f.note.path);
    f.failLogSave();
    await expect(f.run()).resolves.toBeUndefined();
    expect(f.job()).toMatchObject({
      state: "failed",
      failure: { stage: "rewrite" },
      remoteUrl: "https://cdn.test/image.png",
    });
    expect(f.store.snapshot().logs).toHaveLength(1);
    expect(
      f.checkpoints
        .filter((snapshot) => snapshot.jobs[0]?.state === "failed")
        .every((snapshot) => snapshot.logs.length === 1),
    ).toBe(true);
    expect(f.uploads()).toBe(1);
    expect(f.trash).toEqual([]);
    expect(f.writes).toEqual([]);
  });
  it("terminal save failure after an uncertain upload cannot downgrade it to a safe retry", async () => {
    const f = fixture();
    f.setResponse({ ok: false, error: { kind: "timeout", dispatched: true } });
    f.failSave("uncertain");
    await f.run();
    expect(f.job()).toMatchObject({
      state: "uncertain",
      failure: { retry: "uncertain", stage: "upload" },
    });
    expect(f.uploads()).toBe(1);
    expect(f.trash).toEqual([]);
  });
});
