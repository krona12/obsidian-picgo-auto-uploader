import type {
  CachedMetadata,
  EventRef,
  MetadataCache,
  TAbstractFile,
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
export interface ReferenceVault extends Pick<
  Vault,
  "getFiles" | "getMarkdownFiles" | "read" | "process"
> {
  on(
    name: "create" | "modify" | "delete",
    callback: (file: TAbstractFile) => void,
  ): EventRef;
  on(
    name: "rename",
    callback: (file: TAbstractFile, oldPath: string) => void,
  ): EventRef;
  offref(ref: EventRef): void;
}
export interface ReferenceMetadata extends Pick<
  MetadataCache,
  "getFileCache" | "getFirstLinkpathDest"
> {
  on(
    name: "changed",
    callback: (file: TFile, data: string, cache: CachedMetadata) => void,
  ): EventRef;
  on(
    name: "deleted",
    callback: (file: TFile, previousCache: CachedMetadata | null) => void,
  ): EventRef;
  on(name: "resolve", callback: (file: TFile) => void): EventRef;
  on(name: "resolved", callback: () => void): EventRef;
  offref(ref: EventRef): void;
}
export interface RewriteSummary {
  rewrittenNotePaths: string[];
  rewrittenReferenceCount: number;
}
export type RewriteFailure = ReferenceBlocker & RewriteSummary;
export interface ReferenceMutationProof {
  isValid(): boolean;
  release(): void;
}

type RefreshResult = Result<void, ReferenceBlocker>;
interface RefreshWatch {
  targetPath: string;
  promise: Promise<RefreshResult>;
  indexed: boolean;
  result?: RefreshResult;
  finish(result: RefreshResult): void;
}

const fallbackHtmlEntities: Record<string, string> = {
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

function decodeHtmlEntities(text: string): string {
  let decoder: HTMLTextAreaElement | undefined;
  if (typeof document !== "undefined") {
    try {
      decoder = document.createElement("textarea");
    } catch {
      /* The fallback still covers path punctuation in non-DOM environments. */
    }
  }
  return text.replace(
    /&#(?:x[\da-f]+|\d+);?|&([a-z][a-z\d]*);?/gi,
    (match, name: string | undefined) => {
      if (decoder) {
        decoder.innerHTML = match;
        if (decoder.value !== match) return decoder.value;
      }
      if (name === undefined) {
        const hexadecimal = /^&#x/i.test(match);
        const digits = match.slice(hexadecimal ? 3 : 2).replace(/;$/, "");
        const point = parseInt(digits, hexadecimal ? 16 : 10);
        return point > 0 &&
          point <= 0x10ffff &&
          !(point >= 0xd800 && point <= 0xdfff)
          ? String.fromCodePoint(point)
          : "\ufffd";
      }
      return Object.hasOwn(fallbackHtmlEntities, name)
        ? fallbackHtmlEntities[name]!
        : match;
    },
  );
}

/** Only used to find blockers, never to identify a replacement. */
function searchableText(text: string): string {
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
    .replace(/&[a-z][a-z\d]*;?/gi, (match) => decodeHtmlEntities(match))
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

/** Decode CSS escapes only after a value is proven to be a CSS URL token.
 * Applying CSS rules to arbitrary Markdown would reinterpret path separators. */
function decodeCssEscapes(value: string): string {
  let decoded = "";
  for (let cursor = 0; cursor < value.length;) {
    if (value[cursor] !== "\\") {
      decoded += value[cursor]!;
      cursor++;
      continue;
    }
    cursor++;
    if (cursor >= value.length) {
      decoded += "\ufffd";
      break;
    }
    if (value[cursor] === "\r" && value[cursor + 1] === "\n") {
      cursor += 2;
      continue;
    }
    if (["\n", "\r", "\f"].includes(value[cursor]!)) {
      cursor++;
      continue;
    }
    const hexadecimal = /^[\da-f]{1,6}/i.exec(value.slice(cursor))?.[0];
    if (!hexadecimal) {
      decoded += value[cursor]!;
      cursor++;
      continue;
    }
    cursor += hexadecimal.length;
    const point = parseInt(hexadecimal, 16);
    decoded +=
      point === 0 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)
        ? "\ufffd"
        : String.fromCodePoint(point);
    if (value[cursor] === "\r" && value[cursor + 1] === "\n") cursor += 2;
    else if (/[ \t\r\n\f]/.test(value[cursor] ?? "")) cursor++;
  }
  return decoded;
}

const htmlUrlAttributes = new Set([
  "action",
  "archive",
  "background",
  "cite",
  "classid",
  "codebase",
  "data",
  "formaction",
  "href",
  "icon",
  "imagesrcset",
  "longdesc",
  "manifest",
  "poster",
  "profile",
  "src",
  "srcset",
  "usemap",
  "xlink:href",
]);

interface TextReplacement {
  start: number;
  end: number;
  value: string;
}

function replaceTextRanges(
  content: string,
  replacements: readonly TextReplacement[],
): string {
  let result = content;
  for (const replacement of [...replacements].sort((a, b) => b.start - a.start))
    result =
      result.slice(0, replacement.start) +
      replacement.value +
      result.slice(replacement.end);
  return result;
}

function normalizeSrcset(value: string): string {
  const replacements: TextReplacement[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    while (/[\t\n\f\r ,]/.test(value[cursor] ?? "")) cursor++;
    const start = cursor;
    while (cursor < value.length && !/[\t\n\f\r ]/.test(value[cursor]!))
      cursor++;
    let end = cursor;
    while (end > start && value[end - 1] === ",") end--;
    if (isExternalDestination(value.slice(start, end)))
      replacements.push({ start, end, value: " ".repeat(end - start) });
    if (end < cursor) continue;

    let parentheses = 0;
    while (cursor < value.length) {
      if (value[cursor] === "(") parentheses++;
      else if (value[cursor] === ")")
        parentheses = Math.max(0, parentheses - 1);
      else if (value[cursor] === "," && parentheses === 0) {
        cursor++;
        break;
      }
      cursor++;
    }
  }
  return replaceTextRanges(value, replacements);
}

/** Decode every URL-bearing HTML attribute and mask only values proven remote. */
function normalizeHtmlUrlAttributes(content: string): string {
  return content.replace(/<[a-z][^>]*>/gi, (tag: string) => {
    const replacements: TextReplacement[] = [];
    const attributes =
      /([^\s"'=<>`]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
    let attribute: RegExpExecArray | null;
    while ((attribute = attributes.exec(tag))) {
      const name = attribute[1]!.toLowerCase();
      if (!htmlUrlAttributes.has(name)) continue;
      const raw = attribute[2] ?? attribute[3] ?? attribute[4] ?? "";
      const decoded = decodeHtmlEntities(raw);
      const normalized =
        name === "srcset" || name === "imagesrcset"
          ? normalizeSrcset(decoded)
          : isExternalDestination(decoded.trim())
            ? " ".repeat(decoded.length)
            : decoded;
      const relative = attribute[0].lastIndexOf(raw);
      if (relative < 0) continue;
      replacements.push({
        start: attribute.index + relative,
        end: attribute.index + relative + raw.length,
        value: normalized,
      });
    }
    return replaceTextRanges(tag, replacements);
  });
}

function cssEscapeEnd(content: string, start: number): number {
  let cursor = start + 1;
  if (cursor >= content.length) return cursor;
  if (content[cursor] === "\r" && content[cursor + 1] === "\n")
    return cursor + 2;
  if (["\n", "\r", "\f"].includes(content[cursor]!)) return cursor + 1;
  const hexadecimal = /^[\da-f]{1,6}/i.exec(content.slice(cursor))?.[0];
  if (!hexadecimal) return cursor + 1;
  cursor += hexadecimal.length;
  if (content[cursor] === "\r" && content[cursor + 1] === "\n")
    return cursor + 2;
  return /[ \t\r\n\f]/.test(content[cursor] ?? "") ? cursor + 1 : cursor;
}

function quotedCssValue(
  content: string,
  quoteIndex: number,
): { start: number; end: number; next: number } | undefined {
  const quote = content[quoteIndex];
  let cursor = quoteIndex + 1;
  while (cursor < content.length) {
    if (content[cursor] === "\\") {
      cursor = cssEscapeEnd(content, cursor);
      continue;
    }
    if (content[cursor] === quote)
      return { start: quoteIndex + 1, end: cursor, next: cursor + 1 };
    cursor++;
  }
  return undefined;
}

function cssUrlValueRanges(content: string): TextReplacement[] {
  const ranges: TextReplacement[] = [];
  const urls = /\burl\s*\(/gi;
  while (urls.exec(content) !== null) {
    let cursor = urls.lastIndex;
    while (/[ \t\r\n\f]/.test(content[cursor] ?? "")) cursor++;
    let range: { start: number; end: number; next: number } | undefined;
    if (content[cursor] === '"' || content[cursor] === "'") {
      range = quotedCssValue(content, cursor);
      if (!range) continue;
      cursor = range.next;
      while (/[ \t\r\n\f]/.test(content[cursor] ?? "")) cursor++;
      if (content[cursor] !== ")") continue;
      urls.lastIndex = cursor + 1;
    } else {
      const start = cursor;
      while (cursor < content.length && content[cursor] !== ")") {
        if (content[cursor] === "\\") cursor = cssEscapeEnd(content, cursor);
        else cursor++;
      }
      if (content[cursor] !== ")") continue;
      let end = cursor;
      while (end > start && /[ \t\r\n\f]/.test(content[end - 1]!)) end--;
      range = { start, end, next: cursor };
      urls.lastIndex = cursor + 1;
    }
    ranges.push({ start: range.start, end: range.end, value: "" });
  }
  const imports = /@import\b/gi;
  while (imports.exec(content) !== null) {
    let cursor = imports.lastIndex;
    while (/[ \t\r\n\f]/.test(content[cursor] ?? "")) cursor++;
    if (content[cursor] !== '"' && content[cursor] !== "'") continue;
    const range = quotedCssValue(content, cursor);
    if (!range) continue;
    ranges.push({ start: range.start, end: range.end, value: "" });
    imports.lastIndex = range.next;
  }
  return ranges;
}

/** Decode CSS URL values losslessly enough for blocker detection, then remove
 * only destinations that are independently proven HTTP(S). */
function normalizeCssUrlTokens(content: string): string {
  const replacements = cssUrlValueRanges(content).map((range) => {
    const raw = content.slice(range.start, range.end);
    const decoded = decodeCssEscapes(decodeHtmlEntities(raw));
    return {
      ...range,
      value: isExternalDestination(decoded.trim())
        ? " ".repeat(decoded.length)
        : decoded,
    };
  });
  return replaceTextRanges(content, replacements);
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

  /** Start before final discovery so every protected Vault mutation invalidates it. */
  captureMutationProof(): ReferenceMutationProof {
    let valid = true;
    let released = false;
    const releases: Array<() => void> = [];
    const invalidate = () => {
      // Any Vault topology/content mutation can change contextual basename
      // resolution, even when the mutated file itself is not scanned.
      valid = false;
    };
    try {
      for (const name of ["create", "modify", "delete"] as const) {
        const ref = this.vault.on(name, invalidate);
        releases.push(() => this.vault.offref(ref));
      }
      const rename = this.vault.on("rename", invalidate);
      releases.push(() => this.vault.offref(rename));
      // Metadata can be re-resolved after a cache refresh without another Vault
      // event; that also invalidates the proof captured for final discovery.
      const changed = this.metadata.on("changed", invalidate);
      releases.push(() => this.metadata.offref(changed));
      const deleted = this.metadata.on("deleted", invalidate);
      releases.push(() => this.metadata.offref(deleted));
      const resolve = this.metadata.on("resolve", invalidate);
      releases.push(() => this.metadata.offref(resolve));
    } catch {
      valid = false;
      for (const release of releases.splice(0)) release();
    }
    return {
      isValid: () => valid && !released,
      release: () => {
        if (released) return;
        released = true;
        for (const remove of releases.splice(0)) remove();
      },
    };
  }

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
    const searchable = searchableText(
      normalizeCssUrlTokens(
        normalizeHtmlUrlAttributes(maskExternalEmbeds(text)),
      ),
    );
    const stem = target.basename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const referenceBearing =
      /!\[|\[\[|\]\s*\(|(?:^|\n)\s*\[[^\]\n]+\]:|<[a-z][^>]*>|\burl\s*\(|@import|\bbackground(?:-image)?\s*:/i.test(
        searchable,
      );
    // Unknown entities may hide a target name, while extensionless image paths
    // can name a target by basename. Unrelated broken or unsupported image syntax
    // must not block every image in the Vault.
    return (
      searchable.includes(target.name.toLowerCase()) ||
      new RegExp(
        `\\[\\[\\s*(?:[^|#\\]\\n]*[/\\\\])?${stem}(?:[#|\\]]|$)`,
        "i",
      ).test(searchable) ||
      (referenceBearing &&
        new RegExp(
          `(?:^|[/\\\\(<'"=:\\s])${stem}(?=[#?|'"\\)\\]}>\\s]|$)`,
          "i",
        ).test(searchable))
    );
  }

  private destinationCouldNameTarget(
    destination: string,
    target: TFile,
  ): boolean {
    const searchable = searchableText(destination)
      .trim()
      .replace(/^<|>$/g, "")
      .split(/[?#]/, 1)[0]!
      .replace(/\\/g, "/");
    const basename = searchable.slice(searchable.lastIndexOf("/") + 1);
    return (
      basename === target.name.toLowerCase() ||
      basename === target.basename.toLowerCase()
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
      if (this.hasPlausibleDependency(content, target))
        plan.blockers.push(referenceFailure("missing-cache", file.path));
      return;
    }
    for (const link of cache.links ?? []) {
      const destination = decodeDestination(link.link);
      if (!destination) {
        if (
          this.hasPlausibleDependency(link.original, target) ||
          this.destinationCouldNameTarget(link.link, target)
        )
          plan.blockers.push(
            referenceFailure("unresolved-destination", file.path),
          );
        continue;
      }
      if (isExternalDestination(destination)) continue;
      const resolved = this.metadata.getFirstLinkpathDest(
        destination,
        file.path,
      );
      if (resolved === target)
        plan.blockers.push(
          referenceFailure("unsupported-dependency", file.path),
        );
      else if (
        !resolved &&
        (this.hasPlausibleDependency(link.original, target) ||
          this.destinationCouldNameTarget(destination, target))
      )
        plan.blockers.push(
          referenceFailure("unresolved-destination", file.path),
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
      if (
        this.hasPlausibleDependency(content, target) ||
        embeds.some(
          (embed) =>
            this.hasPlausibleDependency(embed.original, target) ||
            this.hasPlausibleDependency(embed.link, target),
        )
      )
        plan.blockers.push(validation.error);
      return;
    }
    const covered: RewriteEdit[] = [];
    for (let index = 0; index < embeds.length; index++) {
      const embed = embeds[index]!;
      const slice = slices[index]!;
      if (!hasSafeEmbedContext(content, slice.start)) {
        if (this.hasPlausibleDependency(embed.original, target))
          plan.blockers.push(
            referenceFailure("unsafe-markdown-context", file.path),
          );
        continue;
      }
      const parsed = parseEmbed(embed.original);
      if (!parsed.ok) {
        if (
          this.hasPlausibleDependency(embed.original, target) ||
          this.destinationCouldNameTarget(embed.link, target)
        )
          plan.blockers.push(referenceFailure("unsupported-syntax", file.path));
        continue;
      }
      const cachedDestination = decodeDestination(embed.link);
      if (cachedDestination !== parsed.value.destination) {
        if (
          this.hasPlausibleDependency(embed.original, target) ||
          (cachedDestination !== null &&
            this.destinationCouldNameTarget(cachedDestination, target))
        )
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
        if (
          this.hasPlausibleDependency(embed.original, target) ||
          this.destinationCouldNameTarget(parsed.value.destination, target)
        )
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
    const resources: {
      refs: EventRef[];
      timer?: ReturnType<typeof setTimeout>;
    } = { refs: [] };
    const watch: RefreshWatch = {
      targetPath,
      promise,
      indexed: false,
      finish: (result) => {
        if (watch.result) return;
        watch.result = result;
        for (const ref of resources.refs.splice(0)) this.metadata.offref(ref);
        clearTimeout(resources.timer);
        complete(result);
      },
    };
    this.refreshes.set(file.path, watch);
    // This subscription runs in the process callback, before Vault can commit and
    // publish changed. Matching event data proves which text was indexed.
    resources.refs.push(
      this.metadata.on("changed", (changed, data) => {
        if (changed === file && data === expected) watch.indexed = true;
      }),
    );
    resources.refs.push(
      this.metadata.on("resolve", (resolved) => {
        if (watch.indexed && resolved === file)
          watch.finish({ ok: true, value: undefined });
      }),
    );
    resources.refs.push(
      this.metadata.on("resolved", () => {
        if (watch.indexed) watch.finish({ ok: true, value: undefined });
      }),
    );
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
