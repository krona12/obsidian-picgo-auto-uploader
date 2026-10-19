import type { PluginSettings } from "./domain";

/** Reject traversal rather than resolving it: uncertain paths must stay local. */
export function normalizeVaultPath(path: string): string | null {
  if (typeof path !== "string" || !path || /^[\\/]/.test(path)) return null;
  // eslint-disable-next-line no-control-regex -- Reject filesystem control characters deliberately.
  if (/[\u0000-\u001f<>:"|?*]/.test(path)) return null;
  const segments = path
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part !== "" && part !== ".");
  if (
    !segments.length ||
    segments.some(
      (part) =>
        part === ".." ||
        /[. ]$/.test(part) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    )
  )
    return null;
  return segments.join("/");
}

export function isPathInsideFolder(path: string, folder: string): boolean {
  const normalizedPath = normalizeVaultPath(path);
  const normalizedFolder = normalizeVaultPath(folder);
  return (
    normalizedPath !== null &&
    normalizedFolder !== null &&
    normalizedPath.startsWith(`${normalizedFolder}/`)
  );
}

export function isEligibleAttachment(
  path: string,
  settings: Readonly<PluginSettings>,
): boolean {
  const normalized = normalizeVaultPath(path);
  if (!normalized || normalized.split("/").some((part) => part.startsWith(".")))
    return false;
  if (
    !settings.scanEntireVault &&
    !settings.attachmentFolders.some((folder) =>
      isPathInsideFolder(normalized, folder),
    )
  )
    return false;
  const fileName = normalized.slice(normalized.lastIndexOf("/") + 1);
  const dot = fileName.lastIndexOf(".");
  return (
    dot > 0 &&
    settings.allowedExtensions.includes(fileName.slice(dot + 1).toLowerCase())
  );
}
