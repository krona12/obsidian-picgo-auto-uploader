import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CachedMetadata,
  EmbedCache,
  EventRef,
  TFile,
  Vault,
} from "obsidian";
import {
  ObsidianReferenceService,
  type ReferenceMetadata,
  type ReferenceVault,
} from "../src/obsidian/reference-service";

// Complete data at the actual I/O boundary: process commits text, and changed carries
// the committed text plus a new cache. The planner and edit engine remain real.
function fixture() {
  const files: TFile[] = [];
  const contents = new Map<string, string>();
  const caches = new Map<TFile, CachedMetadata | null>();
  const destinations = new Map<string, TFile>();
  type MetadataEventName = "changed" | "deleted" | "resolve" | "resolved";
  type MetadataEventCallback = (...args: unknown[]) => void;
  const handlers = new Map<
    EventRef,
    { name: MetadataEventName; callback: MetadataEventCallback }
  >();
  const failedReads = new Set<string>();
  const failedWrites = new Set<string>();
  let refresh = true;
  let concurrent: ((file: TFile) => void) | undefined;
  let failAfterCommit = false;
  const vault: ReferenceVault = {
    getFiles: () => [...files],
    getMarkdownFiles: () => files.filter((file) => file.extension === "md"),
    async read(file) {
      if (failedReads.has(file.path))
        throw new Error("private filesystem detail");
      const data = contents.get(file.path);
      if (data === undefined) throw new Error("missing file");
      return data;
    },
    async process(file, transform) {
      if (failedWrites.has(file.path)) throw new Error("private write detail");
      concurrent?.(file);
      const next = transform(await vault.read(file));
      contents.set(file.path, next);
      file.stat.mtime++;
      file.stat.size = next.length;
      if (refresh) emit(file, next, {});
      if (failAfterCommit) throw new Error("post-commit failure");
      return next;
    },
    on() {
      return {};
    },
    offref() {},
  };
  const metadata: ReferenceMetadata = {
    getFileCache: (file) => caches.get(file) ?? null,
    getFirstLinkpathDest: (link, source) =>
      destinations.get(`${source}:${link}`) ?? null,
    on(name, callback) {
      const ref = {};
      handlers.set(ref, {
        name,
        callback: callback as unknown as MetadataEventCallback,
      });
      return ref;
    },
    offref(ref) {
      handlers.delete(ref);
    },
  };
  function emit(file: TFile, data: string, cache: CachedMetadata) {
    caches.set(file, cache);
    for (const handler of handlers.values())
      if (handler.name === "changed") handler.callback(file, data, cache);
  }
  function add(path: string, text = "", embeds: EmbedCache[] = []): TFile {
    const name = path.split("/").at(-1)!;
    const file: TFile = {
      path,
      name,
      basename: name.slice(0, name.lastIndexOf(".")),
      extension: name.split(".").at(-1)!,
      parent: null,
      vault: vault as Vault,
      stat: { ctime: 1, mtime: 2, size: text.length },
    };
    files.push(file);
    contents.set(path, text);
    caches.set(file, { embeds });
    return file;
  }
  return {
    add,
    contents,
    caches,
    destinations,
    failedReads,
    failedWrites,
    emit,
    handlers,
    vault,
    metadata,
    service: new ObsidianReferenceService(vault, metadata),
    setRefresh: (value: boolean) => {
      refresh = value;
    },
    setConcurrent: (value: (file: TFile) => void) => {
      concurrent = value;
    },
    setFailAfterCommit: () => {
      failAfterCommit = true;
    },
  };
}
function embed(original: string, link: string, start = 0): EmbedCache {
  return {
    original,
    link,
    displayText: "",
    position: {
      start: { line: 0, col: start, offset: start },
      end: {
        line: 0,
        col: start + original.length,
        offset: start + original.length,
      },
    },
  };
}
function linked() {
  const f = fixture();
  const target = f.add("attachments/a.png", "image");
  const note = f.add("one.md", "![[a.png]]", [embed("![[a.png]]", "a.png")]);
  f.destinations.set("one.md:a.png", target);
  return { ...f, target, note };
}
afterEach(() => {
  vi.useRealTimers();
});

describe("Obsidian reference discovery and rewriting", () => {
  it("resolves across every note and leaves same-basename targets and external embeds untouched", async () => {
    const f = linked();
    const other = f.add("other/a.png", "different image");
    f.add("two.md", "before ![Alt](<attachments/a.png> 'title') after", [
      embed("![Alt](<attachments/a.png> 'title')", "attachments/a.png", 7),
    ]);
    f.add("three.md", "![[a.png]]", [embed("![[a.png]]", "a.png")]);
    f.add("external.md", "![](https://cdn.example/a.png)");
    f.destinations.set("two.md:attachments/a.png", f.target);
    f.destinations.set("three.md:a.png", other);
    const plan = await f.service.discover(f.target);
    expect(plan.blockers).toEqual([]);
    expect(plan.references.map((ref) => ref.notePath)).toEqual([
      "one.md",
      "two.md",
    ]);
    expect(plan.fingerprint).toEqual({ size: 5, mtime: 2 });
    expect(await f.service.rewrite(plan, "https://cdn.example/a.png")).toEqual({
      ok: true,
      value: {
        rewrittenNotePaths: ["one.md", "two.md"],
        rewrittenReferenceCount: 2,
      },
    });
    expect(f.contents.get("one.md")).toBe("![](<https://cdn.example/a.png>)");
    expect(f.contents.get("two.md")).toBe(
      "before ![Alt](<https://cdn.example/a.png> 'title') after",
    );
    expect(f.contents.get("three.md")).toBe("![[a.png]]");
    expect(await f.service.verifyNoLocalReferences(f.target)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(f.handlers.size).toBe(0);
  });

  it("blocks any missing Markdown cache, including unrelated notes", async () => {
    const f = linked();
    const unrelated = f.add("unrelated.md", "hello");
    f.caches.set(unrelated, null);
    const plan = await f.service.discover(f.target);
    expect(plan.blockers).toContainEqual(
      expect.objectContaining({
        code: "missing-cache",
        notePath: "unrelated.md",
      }),
    );
    expect(
      await f.service.rewrite(plan, "https://cdn.example/a.png"),
    ).toMatchObject({
      ok: false,
      error: {
        code: "discovery-blocked",
        rewrittenNotePaths: [],
        rewrittenReferenceCount: 0,
      },
    });
    expect(f.contents.get("one.md")).toBe("![[a.png]]");
  });

  it.each([
    ["canvas.canvas", '{"nodes":[{"type":"file","file":"attachments/a.png"}]}'],
    ["view.base", 'filter: file.name == "a.png"'],
    ["page.html", '<img src="attachments/a.png">'],
    ["raw.md", '<img src="attachments/a.png">'],
    ["reference.md", "![Alt][image]\n[image]: attachments/a.png"],
    ["encoded.html", '<img src="attachments/a&#46;png">'],
    ["encoded.canvas", '{"file":"attachments/\\u0061.png"}'],
    ["encoded.md", "![Alt][image]\n[image]: attachments/%61.png"],
    ["extensionless.md", "![Alt][image]\n[image]: attachments/a"],
    ["entity.html", '<img src="attachments/&alpha;.png">'],
  ])("blocks plausible unsupported dependencies in %s", async (path, text) => {
    const f = linked();
    f.add(path, text);
    expect((await f.service.discover(f.target)).blockers).toContainEqual(
      expect.objectContaining({
        code: "unsupported-dependency",
        notePath: path,
      }),
    );
    expect(f.contents.get(path)).toBe(text);
  });

  it.each(["stale", "range", "overlap", "unresolved", "syntax", "mismatch"])(
    "blocks %s metadata without unsafe edits",
    async (kind) => {
      const f = linked();
      if (kind === "stale") f.contents.set("one.md", "![[b.png]]");
      if (kind === "range")
        f.caches.set(f.note, { embeds: [embed("![[a.png]]", "a.png", 100)] });
      if (kind === "overlap")
        f.caches.set(f.note, {
          embeds: [embed("![[a.png]]", "a.png"), embed("![[a.png]]", "a.png")],
        });
      if (kind === "unresolved") f.destinations.clear();
      if (kind === "syntax") {
        f.contents.set("one.md", "![Alt][a.png]");
        f.caches.set(f.note, { embeds: [embed("![Alt][a.png]", "a.png")] });
      }
      if (kind === "mismatch") {
        f.contents.set("one.md", "![[b.png]]");
        f.caches.set(f.note, { embeds: [embed("![[b.png]]", "a.png")] });
      }
      const plan = await f.service.discover(f.target);
      expect(plan.blockers.length).toBeGreaterThan(0);
      expect(
        await f.service.rewrite(plan, "https://cdn.example/a.png"),
      ).toMatchObject({ ok: false });
    },
  );

  it.each([
    ["named-link.html", '<a href="attachments/a&period;png">image</a>'],
    ["named-link.md", '<a href="attachments&sol;a&period;png">image</a>'],
    [
      "style-attribute.html",
      '<div style="background-image: url(attachments/a&period;png)"></div>',
    ],
    [
      "stylesheet.html",
      '<style>.image { background: url("attachments/a&period;png") }</style>',
    ],
    ["unknown-link.html", '<a href="attachments/&unknown;">image</a>'],
    ["prototype-entity.html", '<a href="attachments/&constructor;">image</a>'],
    [
      "unknown-style.html",
      '<style>.image { background: url("attachments/&unknown;") }</style>',
    ],
  ])(
    "blocks entity-bearing unsupported URLs in discovery and final verification: %s",
    async (path, text) => {
      const f = linked();
      await f.service.rewrite(
        await f.service.discover(f.target),
        "https://cdn.example/a.png",
      );
      f.add(path, text);
      expect((await f.service.discover(f.target)).blockers).toContainEqual(
        expect.objectContaining({
          code: "unsupported-dependency",
          notePath: path,
        }),
      );
      expect(await f.service.verifyNoLocalReferences(f.target)).toMatchObject({
        ok: false,
        error: { code: "unsupported-dependency", notePath: path },
      });
      expect(f.contents.get(path)).toBe(text);
    },
  );

  it.each([
    ["inline code", "`![[a.png]]`", 1],
    ["double-backtick code", "``![[a.png]]``", 2],
    ["multiline inline code", "`example\n![[a.png]]`", 9],
    ["escaped image", "\\![[a.png]]", 1],
    ["backtick fence", "```\n![[a.png]]\n```", 4],
    ["tilde fence", "~~~\n![[a.png]]\n~~~", 4],
    ["fence with indented pseudo-close", "```\n    ```\n![[a.png]]\n```", 12],
    ["fence with shorter pseudo-close", "````\n```\n![[a.png]]\n````", 9],
    [
      "unquoted fence with quoted pseudo-close",
      "```\n> ```\n![[a.png]]\n```",
      10,
    ],
    ["tilde fence with quoted pseudo-close", "~~~\n> ~~~\n![[a.png]]\n~~~", 10],
    [
      "quoted fence with nested-quote pseudo-close",
      "> ```\n> > ```\n> ![[a.png]]\n> ```",
      16,
    ],
    ["quoted fence", "> ```\n> ![[a.png]]\n> ```", 8],
    ["indented code", "    ![[a.png]]", 4],
    ["unordered list-indented code", "-     ![[a.png]]", 6],
    ["ordered list-indented code", "1.     ![[a.png]]", 7],
    ["quoted list-indented code", "> -     ![[a.png]]", 8],
    ["nested list-indented code", "- -     ![[a.png]]", 8],
    ["tab-indented unordered list code", "-\t\t![[a.png]]", 3],
    ["tab-indented ordered list code", "1.\t\t![[a.png]]", 4],
    ["HTML comment", "<!-- ![[a.png]] -->", 5],
    ["Obsidian comment", "%% ![[a.png]] %%", 3],
  ])(
    "rejects metadata already stale before discovery in %s",
    async (_label, text, start) => {
      const f = linked();
      f.contents.set("one.md", text);
      f.caches.set(f.note, { embeds: [embed("![[a.png]]", "a.png", start)] });
      const plan = await f.service.discover(f.target);
      expect(plan.references).toEqual([]);
      expect(plan.blockers).toContainEqual(
        expect.objectContaining({
          code: "unsafe-markdown-context",
          notePath: "one.md",
        }),
      );
      expect(
        await f.service.rewrite(plan, "https://cdn.example/a.png"),
      ).toMatchObject({
        ok: false,
        error: { rewrittenNotePaths: [], rewrittenReferenceCount: 0 },
      });
      expect(await f.service.verifyNoLocalReferences(f.target)).toMatchObject({
        ok: false,
        error: { code: "unsafe-markdown-context" },
      });
      expect(f.contents.get("one.md")).toBe(text);
    },
  );

  it.each([
    ["`example` ", 10],
    ["```\nexample\n```\n", 16],
    ["<!-- comment --> ", 17],
    ["%% comment %% ", 14],
    ["> ```\n> example\n> ```\n", 22],
    ["- ", 2],
    ["1. ", 3],
    ["- - ", 4],
  ])(
    "still rewrites a proven embed after closed literal context %s",
    async (prefix, start) => {
      const f = linked();
      f.contents.set("one.md", `${prefix}![[a.png]]`);
      f.caches.set(f.note, { embeds: [embed("![[a.png]]", "a.png", start)] });
      const plan = await f.service.discover(f.target);
      expect(plan.blockers).toEqual([]);
      expect(
        await f.service.rewrite(plan, "https://cdn.example/a.png"),
      ).toMatchObject({ ok: true });
      expect(f.contents.get("one.md")).toBe(
        `${prefix}![](<https://cdn.example/a.png>)`,
      );
    },
  );

  it("uses decoded escaped Markdown paths for exact metadata resolution", async () => {
    const f = fixture();
    const target = f.add("attachments/a (1).png", "image");
    f.add("note.md", "![A \\[x\\]](attachments/a%20\\(1\\).png)", [
      embed(
        "![A \\[x\\]](attachments/a%20\\(1\\).png)",
        "attachments/a%20(1).png",
      ),
    ]);
    f.destinations.set("note.md:attachments/a (1).png", target);
    const plan = await f.service.discover(target);
    expect(plan.blockers).toEqual([]);
    expect(plan.references).toHaveLength(1);
    expect(
      await f.service.rewrite(plan, "https://cdn.example/a.png"),
    ).toMatchObject({ ok: true });
    expect(f.contents.get("note.md")).toBe(
      "![A \\[x\\]](<https://cdn.example/a.png>)",
    );
  });

  it("validates all edits inside process so concurrent text changes cannot be overwritten", async () => {
    const f = linked();
    const plan = await f.service.discover(f.target);
    f.setConcurrent(() => {
      f.contents.set("one.md", "new user text ![[a.png]]");
    });
    expect(
      await f.service.rewrite(plan, "https://cdn.example/a.png"),
    ).toMatchObject({
      ok: false,
      error: {
        code: "stale-offsets",
        rewrittenNotePaths: [],
        rewrittenReferenceCount: 0,
      },
    });
    expect(f.contents.get("one.md")).toBe("new user text ![[a.png]]");
  });

  it("reports partial completion precisely and a fresh retry changes only remaining embeds", async () => {
    const f = linked();
    f.add("two.md", "![[a.png]]", [embed("![[a.png]]", "a.png")]);
    f.destinations.set("two.md:a.png", f.target);
    f.failedWrites.add("two.md");
    expect(
      await f.service.rewrite(
        await f.service.discover(f.target),
        "https://cdn.example/a.png",
      ),
    ).toMatchObject({
      ok: false,
      error: {
        code: "process-failed",
        rewrittenNotePaths: ["one.md"],
        rewrittenReferenceCount: 1,
      },
    });
    expect(f.contents.get("one.md")).toBe("![](<https://cdn.example/a.png>)");
    expect(f.contents.get("two.md")).toBe("![[a.png]]");
    f.failedWrites.clear();
    const retry = await f.service.discover(f.target);
    expect(retry.references.map((ref) => ref.notePath)).toEqual(["two.md"]);
    expect(await f.service.rewrite(retry, "https://cdn.example/a.png")).toEqual(
      {
        ok: true,
        value: { rewrittenNotePaths: ["two.md"], rewrittenReferenceCount: 1 },
      },
    );
    expect(await f.service.verifyNoLocalReferences(f.target)).toEqual({
      ok: true,
      value: undefined,
    });
  });

  it("blocks source fingerprint or resolution changes between discovery and rewrite", async () => {
    const f = linked();
    const plan = await f.service.discover(f.target);
    f.target.stat.mtime++;
    expect(
      await f.service.rewrite(plan, "https://cdn.example/a.png"),
    ).toMatchObject({ ok: false, error: { code: "source-changed" } });
    expect(f.contents.get("one.md")).toBe("![[a.png]]");
  });

  it("blocks non-image links resolved to the source even when the extension is omitted", async () => {
    const f = linked();
    const linkedNote = f.add("linked.md", "[[a]]");
    f.caches.set(linkedNote, { links: [embed("[[a]]", "a")] });
    f.destinations.set("linked.md:a", f.target);
    expect((await f.service.discover(f.target)).blockers).toContainEqual(
      expect.objectContaining({
        code: "unsupported-dependency",
        notePath: "linked.md",
      }),
    );
  });

  it.each([
    "file:///vault/attachments/a.png",
    "obsidian://open?file=attachments%2Fa.png",
  ])(
    "does not treat a local-file URI as a remote image: %s",
    async (destination) => {
      const f = linked();
      const source = `![](<${destination}>)`;
      f.add("uri.md", source);
      expect((await f.service.discover(f.target)).blockers).toContainEqual(
        expect.objectContaining({
          code: "unsupported-dependency",
          notePath: "uri.md",
        }),
      );
      expect(f.contents.get("uri.md")).toBe(source);
    },
  );

  it("keeps a raw extensionless wiki dependency even when cache omitted it", async () => {
    const f = linked();
    f.add("uncached-link.md", "[[attachments/a|image]]");
    expect((await f.service.discover(f.target)).blockers).toContainEqual(
      expect.objectContaining({
        code: "unsupported-dependency",
        notePath: "uncached-link.md",
      }),
    );
  });

  it("returns a blocker if source enumeration becomes unavailable before rewrite", async () => {
    const f = linked();
    const plan = await f.service.discover(f.target);
    f.vault.getFiles = () => {
      throw new Error("private enumeration detail");
    };
    expect(
      await f.service.rewrite(plan, "https://cdn.example/a.png"),
    ).toMatchObject({
      ok: false,
      error: {
        code: "source-changed",
        rewrittenNotePaths: [],
        rewrittenReferenceCount: 0,
      },
    });
    expect(f.contents.get("one.md")).toBe("![[a.png]]");
  });

  it("requires exact TFile identity again inside process", async () => {
    const f = linked();
    const plan = await f.service.discover(f.target);
    f.destinations.set("one.md:a.png", f.add("elsewhere/a.png", "other"));
    expect(
      await f.service.rewrite(plan, "https://cdn.example/a.png"),
    ).toMatchObject({
      ok: false,
      error: { code: "metadata-mismatch", rewrittenReferenceCount: 0 },
    });
    expect(f.contents.get("one.md")).toBe("![[a.png]]");
  });

  it("rejects changed surrounding context even when the embed slice is identical", async () => {
    const f = linked();
    f.contents.set("one.md", " ![[a.png]]");
    f.caches.set(f.note, { embeds: [embed("![[a.png]]", "a.png", 1)] });
    const plan = await f.service.discover(f.target);
    f.setConcurrent(() => {
      f.contents.set("one.md", "\\![[a.png]]");
    });
    expect(
      await f.service.rewrite(plan, "https://cdn.example/a.png"),
    ).toMatchObject({
      ok: false,
      error: { code: "stale-offsets", rewrittenReferenceCount: 0 },
    });
    expect(f.contents.get("one.md")).toBe("\\![[a.png]]");
  });

  it("groups multiple embeds in one atomic note write and preserves trailing Unicode", async () => {
    const f = linked();
    f.contents.set("one.md", "![[a.png]] + ![[a.png|300]] 后");
    f.caches.set(f.note, {
      embeds: [
        embed("![[a.png]]", "a.png"),
        embed("![[a.png|300]]", "a.png", 13),
      ],
    });
    expect(
      await f.service.rewrite(
        await f.service.discover(f.target),
        "https://cdn.example/a.png",
      ),
    ).toEqual({
      ok: true,
      value: { rewrittenNotePaths: ["one.md"], rewrittenReferenceCount: 2 },
    });
    expect(f.contents.get("one.md")).toBe(
      "![](<https://cdn.example/a.png>) + ![|300](<https://cdn.example/a.png>) 后",
    );
  });

  it("returns proven progress even if the port reports failure after committing", async () => {
    const f = linked();
    f.setFailAfterCommit();
    expect(
      await f.service.rewrite(
        await f.service.discover(f.target),
        "https://cdn.example/a.png",
      ),
    ).toMatchObject({
      ok: false,
      error: {
        code: "process-failed",
        rewrittenNotePaths: ["one.md"],
        rewrittenReferenceCount: 1,
      },
    });
    expect(f.contents.get("one.md")).toBe("![](<https://cdn.example/a.png>)");
  });

  it("returns a blocking result if file enumeration fails during rewrite", async () => {
    const f = linked();
    const plan = await f.service.discover(f.target);
    f.vault.getMarkdownFiles = () => {
      throw new Error("private enumeration detail");
    };
    expect(
      await f.service.rewrite(plan, "https://cdn.example/a.png"),
    ).toMatchObject({
      ok: false,
      error: {
        code: "process-failed",
        rewrittenNotePaths: [],
        rewrittenReferenceCount: 0,
      },
    });
    expect(f.contents.get("one.md")).toBe("![[a.png]]");
  });

  it("blocks before committing if a metadata refresh listener cannot be registered", async () => {
    const f = linked();
    const plan = await f.service.discover(f.target);
    f.metadata.on = () => {
      throw new Error("metadata unavailable");
    };
    expect(
      await f.service.rewrite(plan, "https://cdn.example/a.png"),
    ).toMatchObject({
      ok: false,
      error: {
        code: "process-failed",
        rewrittenNotePaths: [],
        rewrittenReferenceCount: 0,
      },
    });
    expect(f.contents.get("one.md")).toBe("![[a.png]]");
    expect(f.handlers.size).toBe(0);
  });

  it("can recover with fresh metadata after a refresh timeout and keeps external text untouched", async () => {
    vi.useFakeTimers();
    const f = linked();
    f.setRefresh(false);
    await f.service.rewrite(
      await f.service.discover(f.target),
      "https://cdn.example/a.png",
    );
    const failed = f.service.waitForRefresh(["one.md"]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await failed).toMatchObject({ ok: false });
    f.emit(f.note, "![](<https://cdn.example/a.png>)", {});
    const retry = await f.service.discover(f.target);
    expect(retry.references).toEqual([]);
    expect(retry.blockers).toEqual([]);
    expect(await f.service.verifyNoLocalReferences(f.target)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(f.contents.get("one.md")).toBe("![](<https://cdn.example/a.png>)");
  });

  it("blocks read failures and fresh verification that discovers a new dependency", async () => {
    const f = linked();
    f.failedReads.add("one.md");
    expect((await f.service.discover(f.target)).blockers).toContainEqual(
      expect.objectContaining({ code: "read-failed" }),
    );
    f.failedReads.clear();
    await f.service.rewrite(
      await f.service.discover(f.target),
      "https://cdn.example/a.png",
    );
    f.add("new.md", "![[a.png]]", [embed("![[a.png]]", "a.png")]);
    f.destinations.set("new.md:a.png", f.target);
    expect(await f.service.verifyNoLocalReferences(f.target)).toMatchObject({
      ok: false,
      error: { code: "local-references-remain" },
    });
  });

  it("blocks after the five-second refresh deadline without rolling back completed rewrites", async () => {
    vi.useFakeTimers();
    const f = linked();
    f.setRefresh(false);
    await f.service.rewrite(
      await f.service.discover(f.target),
      "https://cdn.example/a.png",
    );
    let settled = false;
    const waiting = f.service.waitForRefresh(["one.md"]).then((value) => {
      settled = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(4999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await waiting).toMatchObject({
      ok: false,
      error: { code: "metadata-refresh-timeout" },
    });
    expect(f.contents.get("one.md")).toBe("![](<https://cdn.example/a.png>)");
    expect(f.handlers.size).toBe(0);
  });

  it("ignores unrelated or stale changed events, accepts matching committed text, and cleans listeners", async () => {
    vi.useFakeTimers();
    const f = linked();
    f.setRefresh(false);
    await f.service.rewrite(
      await f.service.discover(f.target),
      "https://cdn.example/a.png",
    );
    let settled = false;
    const waiting = f.service.waitForRefresh(["one.md"]).then((value) => {
      settled = true;
      return value;
    });
    f.emit(f.note, "![[a.png]]", { embeds: [embed("![[a.png]]", "a.png")] });
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBe(false);
    f.emit(f.note, "![](<https://cdn.example/a.png>)", {});
    expect(await waiting).toEqual({ ok: true, value: undefined });
    expect(f.handlers.size).toBe(0);
  });

  it("supports abort during refresh and final verification cannot skip a pending refresh", async () => {
    vi.useFakeTimers();
    const f = linked();
    f.setRefresh(false);
    await f.service.rewrite(
      await f.service.discover(f.target),
      "https://cdn.example/a.png",
    );
    const controller = new AbortController();
    const waiting = f.service.waitForRefresh(["one.md"], controller.signal);
    controller.abort();
    expect(await waiting).toMatchObject({
      ok: false,
      error: { code: "aborted" },
    });
    expect(f.handlers.size).toBe(0);
    const g = linked();
    g.setRefresh(false);
    await g.service.rewrite(
      await g.service.discover(g.target),
      "https://cdn.example/a.png",
    );
    const verification = g.service.verifyNoLocalReferences(g.target);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await verification).toMatchObject({
      ok: false,
      error: { code: "metadata-refresh-timeout" },
    });
  });
});
