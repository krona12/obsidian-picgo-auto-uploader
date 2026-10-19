import type {
  CachedMetadata,
  EventRef,
  MetadataCache,
  TFile,
  Vault,
} from "obsidian";
import type { Result } from "../domain";
import { normalizeVaultPath } from "../path-policy";
import {
  applyVerifiedEdits,
  buildRewriteEdit,
  decodeDestination,
  hasSafeEmbedContext,
  isExternalDestination,
  parseEmbed,
  referenceFailure,
  type EmbedReference,
  type ReferenceBlocker,
  type ReferenceDiscovery,
  type RewriteEdit,
} from "../reference-rewriter";
export type ReferenceVault = Pick<
  Vault,
  "getFiles" | "getMarkdownFiles" | "read" | "process"
>;
export interface ReferenceMetadata extends Pick<
  MetadataCache,
  "getFileCache" | "getFirstLinkpathDest"
> {
  on(
    name: "changed",
    callback: (file: TFile, data: string, cache: CachedMetadata) => void,
  ): EventRef;
  offref(ref: EventRef): void;
}
export interface RewriteSummary {
  rewrittenNotePaths: string[];
  rewrittenReferenceCount: number;
}
export type RewriteFailure = ReferenceBlocker & RewriteSummary;

type RefreshResult = Result<void, ReferenceBlocker>;
interface RefreshWatch {
  targetPath: string;
  promise: Promise<RefreshResult>;
  result?: RefreshResult;
  finish(result: RefreshResult): void;
}

/** Only used to find blockers, never to identify a replacement. */
function searchableText(text: string): string {
  const entities: Record<string, string> = {
    period: ".",
    sol: "/",
    bsol: "\\",
    colon: ":",
    quest: "?",
    num: "#",
    percnt: "%",
    amp: "&",
    AMP: "&",
    equals: "=",
    lowbar: "_",
    hyphen: "-",
    semi: ";",
    lpar: "(",
    rpar: ")",
    lsqb: "[",
    rsqb: "]",
    lcub: "{",
    rcub: "}",
    comma: ",",
    commat: "@",
    plus: "+",
    ast: "*",
    excl: "!",
    dollar: "$",
    tilde: "~",
    vert: "|",
    quot: '"',
    QUOT: '"',
    apos: "'",
    lt: "<",
    gt: ">",
    Tab: "\t",
    NewLine: "\n",
    nbsp: "\u00a0",
  };
  const decoded = text
    .replace(/\\u([\da-f]{4})/gi, (_match, code: string) =>
      String.fromCharCode(parseInt(code, 16)),
    )
    .replace(/&#(x[\da-f]+|\d+);?/gi, (match, code: string) => {
      const point =
        code[0]?.toLowerCase() === "x"
          ? parseInt(code.slice(1), 16)
          : parseInt(code, 10);
      return point <= 0x10ffff ? String.fromCodePoint(point) : match;
    })
    .replace(/&([a-z][a-z\d]*);/gi, (match, name: string) =>
      Object.hasOwn(entities, name) ? entities[name]! : match,
    )
    .replace(/%(?:[\da-f]{2})(?:%[\da-f]{2})*/gi, (match) => {
      try {
        return decodeURIComponent(match);
      } catch {
        return match;
      }
    })
    .replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, "$1");
  return decoded.toLowerCase();
}

/** External Markdown images need no cache entry and must not make a retry look local. */
function maskExternalEmbeds(content: string): string {
  let masked = content;
  let start = content.indexOf("![");
  while (start >= 0) {
    const newline = content.indexOf("\n", start);
    const limit = newline < 0 ? content.length : newline;
    let end = content.indexOf(")", start);
    while (end >= 0 && end < limit) {
      const parsed = parseEmbed(content.slice(start, end + 1));
      if (parsed.ok) {
        if (isExternalDestination(parsed.value.destination))
          masked =
            masked.slice(0, start) +
            " ".repeat(end + 1 - start) +
            masked.slice(end + 1);
        break;
      }
      end = content.indexOf(")", end + 1);
    }
    start = content.indexOf("![", start + 2);
  }
  return masked;
}

export class ObsidianReferenceService {
  private readonly targets = new WeakMap<ReferenceDiscovery, TFile>();
  private readonly noteContents = new WeakMap<
    ReferenceDiscovery,
    Map<string, string>
  >();
  private readonly refreshes = new Map<string, RefreshWatch>();

  constructor(
    private readonly vault: ReferenceVault,
    private readonly metadata: ReferenceMetadata,
  ) {}

  async discover(target: TFile): Promise<ReferenceDiscovery> {
    // A fresh attempt may recover after a timed-out/aborted prior attempt. Its full
    // scan still rejects old cache slices and any raw local dependency.
    for (const [path, watch] of this.refreshes)
      if (watch.targetPath === target.path && watch.result)
        this.refreshes.delete(path);
    const plan: ReferenceDiscovery = {
      targetPath: target.path,
      fingerprint: { size: target.stat.size, mtime: target.stat.mtime },
      references: [],
      blockers: [],
    };
    this.targets.set(plan, target);
    this.noteContents.set(plan, new Map());
    if (normalizeVaultPath(target.path) !== target.path) {
      plan.blockers.push(referenceFailure("invalid-target"));
      return plan;
    }
    try {
      const files = this.vault.getFiles();
      if (!files.includes(target)) {
        plan.blockers.push(referenceFailure("source-changed"));
        return plan;
      }
      const markdown = this.vault.getMarkdownFiles();
      for (const file of markdown)
        await this.discoverMarkdown(file, target, plan);
      for (const file of files) {
        if (!["canvas", "base", "html"].includes(file.extension.toLowerCase()))
          continue;
        try {
          const text = await this.vault.read(file);
          if (this.hasPlausibleDependency(text, target))
            plan.blockers.push(
              referenceFailure("unsupported-dependency", file.path),
            );
        } catch {
          plan.blockers.push(referenceFailure("read-failed", file.path));
        }
      }
    } catch {
      plan.blockers.push(referenceFailure("discovery-failed"));
    }
    return plan;
  }

  private hasPlausibleDependency(text: string, target: TFile): boolean {
    const searchable = searchableText(text);
    const stem = target.basename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Remaining image markup has no proven supported resolution. In particular,
    // reference-style IDs, HTML entities and extensionless wiki targets can hide
    // the literal filename. False-positive retention is preferable to deletion.
    return (
      searchable.includes(target.name.toLowerCase()) ||
      // Unknown entities may encode arbitrary filename characters. Without a
      // proven decoding, URL-bearing HTML/CSS must retain the local source.
      (/&[a-z][a-z\d]*;?/i.test(searchable) &&
        /<[a-z][^>]*>|\burl\s*\(|@import|\bbackground(?:-image)?\s*:/i.test(
          searchable,
        )) ||
      /!\[|<(?:img|source|object|embed)\b/i.test(searchable) ||
      new RegExp(
        `\\[\\[\\s*(?:[^|#\\]\\n]*[/\\\\])?${stem}(?:[#|\\]]|$)`,
        "i",
      ).test(searchable)
    );
  }

  private async discoverMarkdown(
    file: TFile,
    target: TFile,
    plan: ReferenceDiscovery,
  ): Promise<void> {
    let content: string;
    try {
      content = await this.vault.read(file);
    } catch {
      plan.blockers.push(referenceFailure("read-failed", file.path));
      return;
    }
    const cache = this.metadata.getFileCache(file);
    if (!cache) {
      plan.blockers.push(referenceFailure("missing-cache", file.path));
      return;
    }
    for (const link of cache.links ?? []) {
      const destination = decodeDestination(link.link);
      if (!destination) {
        plan.blockers.push(
          referenceFailure("unresolved-destination", file.path),
        );
        continue;
      }
      if (
        !isExternalDestination(destination) &&
        this.metadata.getFirstLinkpathDest(destination, file.path) === target
      )
        plan.blockers.push(
          referenceFailure("unsupported-dependency", file.path),
        );
    }
    const embeds = cache.embeds ?? [];
    const slices: RewriteEdit[] = embeds.map((embed) => ({
      notePath: file.path,
      targetPath: target.path,
      start: embed.position.start.offset,
      end: embed.position.end.offset,
      expectedSource: embed.original,
      replacement: embed.original,
    }));
    const validation = applyVerifiedEdits(content, slices);
    if (!validation.ok) {
      plan.blockers.push(validation.error);
      return;
    }
    const covered: RewriteEdit[] = [];
    for (let index = 0; index < embeds.length; index++) {
      const embed = embeds[index]!;
      const slice = slices[index]!;
      if (!hasSafeEmbedContext(content, slice.start)) {
        plan.blockers.push(
          referenceFailure("unsafe-markdown-context", file.path),
        );
        continue;
      }
      const parsed = parseEmbed(embed.original);
      if (!parsed.ok) {
        plan.blockers.push(referenceFailure("unsupported-syntax", file.path));
        continue;
      }
      const cachedDestination = decodeDestination(embed.link);
      if (cachedDestination !== parsed.value.destination) {
        plan.blockers.push(referenceFailure("metadata-mismatch", file.path));
        continue;
      }
      if (isExternalDestination(parsed.value.destination)) {
        covered.push(slice);
        continue;
      }
      const resolved = this.metadata.getFirstLinkpathDest(
        parsed.value.destination,
        file.path,
      );
      if (!resolved) {
        plan.blockers.push(
          referenceFailure("unresolved-destination", file.path),
        );
        continue;
      }
      // Object identity is deliberate: a basename or even a reused path is not proof.
      if (resolved === target) {
        this.noteContents.get(plan)!.set(file.path, content);
        plan.references.push({
          notePath: slice.notePath,
          targetPath: slice.targetPath,
          start: slice.start,
          end: slice.end,
          expectedSource: slice.expectedSource,
        });
      }
      covered.push(slice);
    }
    const masked = applyVerifiedEdits(
      content,
      covered.map((slice) => ({
        ...slice,
        replacement: " ".repeat(slice.end - slice.start),
      })),
    );
    if (
      masked.ok &&
      this.hasPlausibleDependency(maskExternalEmbeds(masked.value), target)
    )
      plan.blockers.push(referenceFailure("unsupported-dependency", file.path));
  }

  async rewrite(
    plan: ReferenceDiscovery,
    remoteUrl: string,
  ): Promise<Result<RewriteSummary, RewriteFailure>> {
    const progress: RewriteSummary = {
      rewrittenNotePaths: [],
      rewrittenReferenceCount: 0,
    };
    const fail = (error: ReferenceBlocker): Result<never, RewriteFailure> => ({
      ok: false,
      error: { ...error, stage: "rewrite", ...progress },
    });
    if (plan.blockers.length)
      return fail(referenceFailure("discovery-blocked"));
    const target = this.targets.get(plan);
    if (!target || !this.sourceMatches(target, plan))
      return fail(referenceFailure("source-changed"));
    const grouped = new Map<string, RewriteEdit[]>();
    for (const reference of plan.references) {
      if (reference.targetPath !== plan.targetPath)
        return fail(referenceFailure("metadata-mismatch", reference.notePath));
      const edit = buildRewriteEdit(reference, remoteUrl);
      if (!edit.ok) return fail(edit.error);
      const group = grouped.get(reference.notePath) ?? [];
      group.push(edit.value);
      grouped.set(reference.notePath, group);
    }
    for (const [path, edits] of grouped) {
      let prepared: string | undefined;
      let validationError: ReferenceBlocker | undefined;
      let file: TFile | undefined;
      try {
        file = this.vault
          .getMarkdownFiles()
          .find((candidate) => candidate.path === path);
        if (!file) return fail(referenceFailure("note-missing", path));
        const note = file;
        await this.vault.process(file, (content) => {
          const result = applyVerifiedEdits(content, edits);
          if (content !== this.noteContents.get(plan)?.get(path))
            validationError = referenceFailure("stale-offsets", path);
          else if (!result.ok) validationError = result.error;
          else if (
            !edits.every((edit) => hasSafeEmbedContext(content, edit.start))
          )
            validationError = referenceFailure("unsafe-markdown-context", path);
          else if (!this.sourceMatches(target, plan))
            validationError = referenceFailure("source-changed", path);
          else if (
            !edits.every((edit) => this.stillResolves(note, edit, target))
          )
            validationError = referenceFailure("metadata-mismatch", path);
          if (validationError || !result.ok)
            throw new Error("Reference validation failed.");
          prepared = result.value;
          this.watchRefresh(note, target.path, prepared);
          return prepared;
        });
        progress.rewrittenNotePaths.push(path);
        progress.rewrittenReferenceCount += edits.length;
      } catch {
        // A port can reject after committing. Report a proven committed result as
        // progress while still returning a blocking process failure.
        let committed = false;
        if (prepared !== undefined && file) {
          try {
            committed = (await this.vault.read(file)) === prepared;
          } catch {
            /* No proof of commit. */
          }
        }
        if (committed) {
          progress.rewrittenNotePaths.push(path);
          progress.rewrittenReferenceCount += edits.length;
        } else {
          this.refreshes.get(path)?.finish({
            ok: false,
            error: referenceFailure("process-failed", path),
          });
          this.refreshes.delete(path);
        }
        return fail(
          validationError ?? referenceFailure("process-failed", path),
        );
      }
    }
    return { ok: true, value: progress };
  }

  private sourceMatches(target: TFile, plan: ReferenceDiscovery): boolean {
    try {
      return (
        target.path === plan.targetPath &&
        this.vault.getFiles().includes(target) &&
        target.stat.size === plan.fingerprint.size &&
        target.stat.mtime === plan.fingerprint.mtime
      );
    } catch {
      return false;
    }
  }

  private stillResolves(
    file: TFile,
    reference: EmbedReference,
    target: TFile,
  ): boolean {
    const cache = this.metadata.getFileCache(file);
    const embed = cache?.embeds?.find(
      (entry) =>
        entry.position.start.offset === reference.start &&
        entry.position.end.offset === reference.end &&
        entry.original === reference.expectedSource,
    );
    if (!embed) return false;
    const parsed = parseEmbed(embed.original);
    return (
      parsed.ok &&
      parsed.value.destination === decodeDestination(embed.link) &&
      this.metadata.getFirstLinkpathDest(
        parsed.value.destination,
        file.path,
      ) === target
    );
  }

  private watchRefresh(
    file: TFile,
    targetPath: string,
    expected: string,
  ): void {
    this.refreshes.get(file.path)?.finish({
      ok: false,
      error: referenceFailure("refresh-superseded", file.path),
    });
    let complete!: (result: RefreshResult) => void;
    const promise = new Promise<RefreshResult>((resolve) => {
      complete = resolve;
    });
    const resources: { ref?: EventRef; timer?: ReturnType<typeof setTimeout> } =
      {};
    const watch: RefreshWatch = {
      targetPath,
      promise,
      finish: (result) => {
        if (watch.result) return;
        watch.result = result;
        if (resources.ref) this.metadata.offref(resources.ref);
        clearTimeout(resources.timer);
        complete(result);
      },
    };
    this.refreshes.set(file.path, watch);
    // This subscription runs in the process callback, before Vault can commit and
    // publish changed. Matching event data proves which text was indexed.
    resources.ref = this.metadata.on("changed", (changed, data) => {
      if (changed === file && data === expected)
        watch.finish({ ok: true, value: undefined });
    });
    resources.timer = setTimeout(
      () =>
        watch.finish({
          ok: false,
          error: referenceFailure("metadata-refresh-timeout", file.path),
        }),
      5000,
    );
  }

  async waitForRefresh(
    paths: readonly string[],
    signal?: AbortSignal,
  ): Promise<RefreshResult> {
    const watches = [...new Set(paths)].map((path) => ({
      path,
      watch: this.refreshes.get(path),
    }));
    const abort = () => {
      for (const { path, watch } of watches)
        watch?.finish({ ok: false, error: referenceFailure("aborted", path) });
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      if (signal?.aborted) {
        abort();
        return { ok: false, error: referenceFailure("aborted") };
      }
      const results = await Promise.all(
        watches.map(
          ({ path, watch }) =>
            watch?.promise ??
            Promise.resolve<RefreshResult>({
              ok: false,
              error: referenceFailure("refresh-untracked", path),
            }),
        ),
      );
      if (signal?.aborted)
        return { ok: false, error: referenceFailure("aborted") };
      return (
        results.find((result) => !result.ok) ?? { ok: true, value: undefined }
      );
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  async verifyNoLocalReferences(
    target: TFile,
  ): Promise<Result<void, ReferenceBlocker>> {
    const paths = [...this.refreshes]
      .filter(([, watch]) => watch.targetPath === target.path)
      .map(([path]) => path);
    const refreshed = await this.waitForRefresh(paths);
    if (!refreshed.ok) return refreshed;
    const plan = await this.discover(target);
    if (plan.blockers.length) return { ok: false, error: plan.blockers[0]! };
    if (plan.references.length)
      return { ok: false, error: referenceFailure("local-references-remain") };
    return { ok: true, value: undefined };
  }
}
