import type { JobFailure, Result, SourceFingerprint } from "./domain";

export interface ReferenceBlocker extends JobFailure {
  notePath?: string;
}
export interface EmbedReference {
  notePath: string;
  targetPath: string;
  start: number;
  end: number;
  expectedSource: string;
}
export interface RewriteEdit extends EmbedReference {
  replacement: string;
}
export interface ReferenceDiscovery {
  targetPath: string;
  fingerprint: SourceFingerprint;
  references: EmbedReference[];
  blockers: ReferenceBlocker[];
}
export function referenceFailure(
  code: string,
  notePath?: string,
): ReferenceBlocker {
  return {
    code,
    stage: "reference",
    retry: code === "aborted" ? "non-retryable" : "safe",
    message:
      "Attachment references could not be safely verified; the local file must be retained.",
    ...(notePath === undefined ? {} : { notePath }),
  };
}

export interface ParsedEmbed {
  destination: string;
  prefix: string;
  suffix: string;
}

/** Decode Markdown escapes and URI escapes once, as a link destination, not a path heuristic. */
export function decodeDestination(value: string): string | null {
  try {
    return decodeURIComponent(
      value.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, "$1"),
    );
  } catch {
    return null;
  }
}

export function isExternalDestination(value: string): boolean {
  // file:, obsidian:, and protocol-relative paths can still depend on local files.
  return /^https?:\/\//i.test(value);
}

/** A conservative context gate, not an alternative source of embed references. */
export function hasSafeEmbedContext(content: string, start: number): boolean {
  let backslashes = 0;
  for (
    let cursor = start - 1;
    cursor >= 0 && content[cursor] === "\\";
    cursor--
  )
    backslashes++;
  if (backslashes % 2 !== 0) return false;
  let fence: { marker: string; length: number; container: string } | undefined;
  let inlineTicks = 0;
  let comment: "html" | "obsidian" | undefined;
  let lineStart = 0;
  while (lineStart <= start) {
    const newline = content.indexOf("\n", lineStart);
    const lineEnd = newline < 0 ? content.length : newline;
    const line = content.slice(lineStart, lineEnd).replace(/\r$/, "");
    const withoutQuotes = line.replace(/^(?: {0,3}>[ \t]?)+/, "");
    const currentLine = start <= lineEnd;
    // Container prefixes allow quoted/list fences. Ambiguous nesting is retained.
    const marker =
      /^[ \t]*(?:(?:>[ \t]*|(?:[-+*]|\d+[.)])[ \t]+))*(`{3,}|~{3,})(.*)$/.exec(
        line,
      );
    const container = marker
      ? line.slice(0, line.indexOf(marker[1]!)).replace(/[ \t]/g, "")
      : "";
    if (fence) {
      if (currentLine) return false;
      if (
        marker &&
        container === fence.container &&
        marker[1]![0] === fence.marker &&
        marker[1]!.length >= fence.length &&
        /^ {0,3}(?:`+|~+)[ \t]*$/.test(withoutQuotes)
      )
        fence = undefined;
    } else if (!comment && inlineTicks === 0 && marker) {
      if (currentLine) return false;
      fence = { marker: marker[1]![0]!, length: marker[1]!.length, container };
    } else {
      // Remove only a container's required separator, preserving extra spaces
      // that make the content an indented code block (including nested lists).
      let nestedContent = line;
      const prefix = /^(?: {0,3}>[ \t]?| {0,3}(?:[-+*]|\d+[.)])(?: |(?=\t)))/;
      while (prefix.test(nestedContent))
        nestedContent = nestedContent.replace(prefix, "");
      if (currentLine && /^(?: {4}| *\t)/.test(nestedContent)) return false;
      const limit = Math.min(start, lineEnd);
      for (let cursor = lineStart; cursor < limit;) {
        if (comment) {
          const close = comment === "html" ? "-->" : "%%";
          if (content.startsWith(close, cursor)) {
            comment = undefined;
            cursor += close.length;
          } else cursor++;
          continue;
        }
        if (content[cursor] === "`") {
          let end = cursor + 1;
          while (content[end] === "`") end++;
          const length = end - cursor;
          if (inlineTicks === 0) inlineTicks = length;
          else if (inlineTicks === length) inlineTicks = 0;
          cursor = end;
          continue;
        }
        if (inlineTicks !== 0) {
          cursor++;
          continue;
        }
        if (content[cursor] === "\\") {
          cursor += 2;
          continue;
        }
        if (content.startsWith("<!--", cursor)) {
          comment = "html";
          cursor += 4;
          continue;
        }
        if (content.startsWith("%%", cursor)) {
          comment = "obsidian";
          cursor += 2;
          continue;
        }
        cursor++;
      }
    }
    if (currentLine) return !fence && !comment && inlineTicks === 0;
    lineStart = lineEnd + 1;
  }
  return false;
}

/** Parse only a whole, losslessly understood image embed. Uncertain syntax is a blocker. */
export function parseEmbed(
  source: string,
): Result<ParsedEmbed, ReferenceBlocker> {
  const unsupported = (): Result<never, ReferenceBlocker> => ({
    ok: false,
    error: referenceFailure("unsupported-syntax"),
  });
  if (/[\r\n]/.test(source)) return unsupported();
  if (source.startsWith("![[")) {
    const match = /^!\[\[([^\]|#]+)(?:\|([^|]*))?\]\]$/.exec(source);
    if (!match || !match[1]?.trim()) return unsupported();
    const destination = match[1];
    const display = match[2] ?? "";
    const alt = /^\d+(?:x\d+)?$/.test(display)
      ? `|${display}`
      : display.replace(/[\\[\]*_`<>!&]/g, "\\$&");
    return {
      ok: true,
      value: { destination, prefix: `![${alt}](`, suffix: ")" },
    };
  }
  if (!source.startsWith("![")) return unsupported();
  let cursor = 2;
  let brackets = 1;
  for (; cursor < source.length; cursor++) {
    const char = source[cursor];
    if (char === "\\") {
      cursor++;
      continue;
    }
    if (char === "[") brackets++;
    if (char === "]" && --brackets === 0) break;
  }
  if (brackets !== 0 || source[cursor + 1] !== "(") return unsupported();
  cursor += 2;
  while (/[ \t]/.test(source[cursor] ?? "")) cursor++;
  const start = cursor;
  let raw: string;
  if (source[cursor] === "<") {
    cursor++;
    const inner = cursor;
    while (cursor < source.length && source[cursor] !== ">") {
      if (source[cursor] === "<") return unsupported();
      if (source[cursor] === "\\") cursor++;
      cursor++;
    }
    if (source[cursor] !== ">") return unsupported();
    raw = source.slice(inner, cursor++);
  } else {
    let depth = 0;
    for (; cursor < source.length; cursor++) {
      const char = source[cursor];
      if (char === "\\") {
        cursor++;
        continue;
      }
      if (char === "(") depth++;
      if (char === ")") {
        if (depth === 0) break;
        depth--;
      }
      if (/[ \t<>]/.test(char ?? "")) break;
    }
    if (depth !== 0) return unsupported();
    raw = source.slice(start, cursor);
  }
  const suffix = source.slice(cursor);
  if (
    !raw ||
    !/^(?:[ \t]+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\((?:\\.|[^()\\])*\)))?[ \t]*\)$/.test(
      suffix,
    )
  )
    return unsupported();
  const destination = decodeDestination(raw);
  if (
    !destination ||
    (!isExternalDestination(destination) && destination.includes("#"))
  )
    return unsupported();
  return {
    ok: true,
    value: { destination, prefix: source.slice(0, start), suffix },
  };
}

export function buildRewriteEdit(
  reference: EmbedReference,
  remoteUrl: string,
): Result<RewriteEdit, ReferenceBlocker> {
  try {
    const url = new URL(remoteUrl);
    // eslint-disable-next-line no-control-regex -- Literal control bytes cannot enter Markdown destinations.
    const unsafeCharacters = /[<>\\\s\u0000-\u001f\u007f]/;
    if (
      !/^https?:\/\//i.test(remoteUrl) ||
      !url.hostname ||
      url.username ||
      url.password ||
      unsafeCharacters.test(remoteUrl)
    )
      return {
        ok: false,
        error: referenceFailure("invalid-remote-url", reference.notePath),
      };
  } catch {
    return {
      ok: false,
      error: referenceFailure("invalid-remote-url", reference.notePath),
    };
  }
  const parsed = parseEmbed(reference.expectedSource);
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    value: {
      ...reference,
      replacement: `${parsed.value.prefix}<${remoteUrl}>${parsed.value.suffix}`,
    },
  };
}

/** Validate every slice before any transformation; UTF-16 offsets match Obsidian's cache. */
export function applyVerifiedEdits(
  content: string,
  edits: readonly RewriteEdit[],
): Result<string, ReferenceBlocker> {
  if (new Set(edits.map((edit) => edit.notePath)).size > 1)
    return { ok: false, error: referenceFailure("mixed-notes") };
  const ordered = [...edits].sort((a, b) => a.start - b.start);
  for (let index = 0; index < ordered.length; index++) {
    const edit = ordered[index]!;
    if (
      !Number.isSafeInteger(edit.start) ||
      !Number.isSafeInteger(edit.end) ||
      edit.start < 0 ||
      edit.end <= edit.start ||
      edit.end > content.length ||
      content.slice(edit.start, edit.end) !== edit.expectedSource
    )
      return {
        ok: false,
        error: referenceFailure("stale-offsets", edit.notePath),
      };
    if (index > 0 && ordered[index - 1]!.end > edit.start)
      return {
        ok: false,
        error: referenceFailure("overlapping-edits", edit.notePath),
      };
  }
  let result = content;
  for (const edit of ordered.reverse())
    result =
      result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
  return { ok: true, value: result };
}
