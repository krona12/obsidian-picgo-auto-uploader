const REDACTED = "[REDACTED]";

function variants(value: string): string[] {
  const values = [
    value,
    value.replaceAll("\\", "/"),
    JSON.stringify(value).slice(1, -1),
  ];
  try {
    values.push(encodeURIComponent(value));
  } catch {
    /* A malformed surrogate can still be redacted in raw and JSON form. */
  }
  return [...new Set(values)];
}

/** Redact before a message enters persistence, a log, or any user-facing view. */
export function redactText(
  text: string,
  secrets: readonly string[] = [],
  absolutePaths: readonly string[] = [],
): string {
  let output = text;
  const sensitive = [...secrets, ...absolutePaths]
    .filter(Boolean)
    .flatMap(variants)
    .sort((left, right) => right.length - left.length);
  for (const value of sensitive) output = output.split(value).join(REDACTED);
  // Match a complete quoted value, including escaped Digest parameter quotes.
  output = output.replace(
    /((["'])authorization\2\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/gi,
    `$1"${REDACTED}"`,
  );
  // Raw headers and assignments occupy the remainder of their log line. Commas
  // and quotes belong to valid authorization schemes and cannot delimit them.
  output = output.replace(
    /(\bauthorization\b\s*[:=]\s*)[^\r\n]*/gi,
    `$1${REDACTED}`,
  );
  output = output.replace(
    /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_.=~-]+/gi,
    REDACTED,
  );
  // Quoted paths may contain spaces; stop at log/JSON delimiters or a line break.
  output = output.replace(
    /(?<![A-Za-z0-9])(?:[A-Za-z]:[\\/]|\\\\[^\\/\s"']+[\\/][^\\/\s"']+)[^\r\n"'<>|,;}]*/g,
    REDACTED,
  );
  output = output.replace(
    /(?<![:/])\/\/[^/\s"']+\/[^/\s"']+[^\r\n"'<>|,;}]*/g,
    REDACTED,
  );
  return output;
}

export type DiagnosticValue =
  | null
  | boolean
  | number
  | string
  | DiagnosticValue[]
  | { [key: string]: DiagnosticValue };

const sensitiveField =
  /^(?:picgoSecret|secret|authorization|password|token|accessToken|apiKey)$/i;

/** Clone into serializable data, omitting credential fields before the final redaction pass. */
export function createDiagnosticExport(snapshot: object): {
  [key: string]: DiagnosticValue;
} {
  const secrets: string[] = [];
  const absolutePaths: string[] = [];
  const collected = new WeakSet<object>();
  const collect = (value: unknown): void => {
    if (typeof value !== "object" || value === null || collected.has(value))
      return;
    collected.add(value);
    for (const [key, item] of Object.entries(value)) {
      if (sensitiveField.test(key) && typeof item === "string" && item)
        secrets.push(item);
      if (/^authorization$/i.test(key) && typeof item === "string") {
        const credentials = /^\s*(?:Bearer|Basic)\s+(.+?)\s*$/i.exec(item)?.[1];
        if (credentials) secrets.push(credentials);
      }
      if (key === "absolutePaths" && Array.isArray(item))
        for (const path of item)
          if (typeof path === "string") absolutePaths.push(path);
      collect(item);
    }
  };
  collect(snapshot);

  const visiting = new WeakSet<object>();
  const clone = (value: unknown): DiagnosticValue => {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    )
      return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value !== "object") return null;
    if (visiting.has(value)) return "[Circular]";
    visiting.add(value);
    let result: DiagnosticValue;
    if (Array.isArray(value)) result = value.map(clone);
    else {
      result = Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => !sensitiveField.test(key))
          .map(([key, item]) => [key, clone(item)]),
      );
    }
    visiting.delete(value);
    return result;
  };

  const redact = (value: DiagnosticValue): DiagnosticValue => {
    if (typeof value === "string")
      return redactText(value, secrets, absolutePaths);
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          redactText(key, secrets, absolutePaths),
          redact(item),
        ]),
      );
    return value;
  };
  return redact(clone(snapshot)) as { [key: string]: DiagnosticValue };
}
