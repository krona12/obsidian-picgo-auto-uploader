import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifestPath = join(root, "manifest.json");
const releasePath = join(root, "release");
const expectedAssets = ["main.js", "manifest.json", "styles.css"];
const semver = /^\d+\.\d+\.\d+$/;

function fail(message) {
  throw new Error(`Release audit failed: ${message}`);
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail(`${label} must contain valid JSON.`);
  }
}

function requestedTag() {
  const args = process.argv.slice(2);
  if (args.length > 0 && (args.length !== 2 || args[0] !== "--tag"))
    fail("the only supported argument is --tag <x.y.z>.");
  if (args[0] === "--tag" && !args[1]) fail("--tag requires a value.");
  if (args[1]) return args[1];
  if (process.env.RELEASE_TAG) return process.env.RELEASE_TAG;
  const tagEvent =
    process.env.GITHUB_REF_TYPE === "tag" ||
    process.env.GITHUB_REF?.startsWith("refs/tags/");
  if (tagEvent && process.env.GITHUB_REF_NAME)
    return process.env.GITHUB_REF_NAME;
  return undefined;
}

function assertManagedDirectory(path, prefix) {
  if (
    resolve(dirname(path)) !== resolve(root) ||
    !basename(path).startsWith(prefix)
  )
    fail("refusing to modify a path outside the repository release area.");
}

function removeManaged(path, prefix) {
  assertManagedDirectory(path, prefix);
  rmSync(path, { recursive: true, force: true });
}

function pathVariants(value) {
  if (!value) return [];
  const normalized = resolve(value);
  const forward = normalized.replaceAll("\\", "/");
  return [
    normalized,
    forward,
    JSON.stringify(normalized).slice(1, -1),
    JSON.stringify(forward).slice(1, -1),
  ];
}

function injectTestFault(name) {
  if (process.env.NODE_ENV !== "test") return;
  const faults = new Set(
    (process.env.PICGO_RELEASE_TEST_FAULTS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  if (faults.has(name)) throw new Error(`Injected ${name} failure.`);
}

function removeInstalledRelease() {
  if (resolve(releasePath) !== resolve(join(root, "release")))
    fail("refusing to remove an unexpected release path.");
  rmSync(releasePath, { recursive: true, force: true });
}

function scanAsset(name, content, privatePaths) {
  const folded = content.toLowerCase();
  for (const privatePath of privatePaths) {
    if (privatePath && folded.includes(privatePath.toLowerCase()))
      fail(`${name} contains a private local path.`);
  }
  if (/PICGO_TEST_SECRET|known-secret-sentinel/i.test(content))
    fail(`${name} contains a known test credential sentinel.`);
  if (
    /(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,})/.test(
      content,
    )
  )
    fail(`${name} contains a concrete credential pattern.`);
  if (/sourceMappingURL\s*=|\.map(?:["'\s]|$)/i.test(content))
    fail(`${name} contains a source-map reference.`);
}

function validateDirectory(directory, privatePaths) {
  const names = readdirSync(directory).sort();
  if (JSON.stringify(names) !== JSON.stringify(expectedAssets))
    fail(`asset set must be exactly ${expectedAssets.join(", ")}.`);
  const sizes = [];
  for (const name of names) {
    const path = join(directory, name);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink())
      fail(`${name} must be a regular file, not a link.`);
    if (stat.size === 0) fail(`${name} must not be empty.`);
    scanAsset(name, readFileSync(path, "utf8"), privatePaths);
    sizes.push([name, stat.size]);
  }
  if (
    !readFileSync(join(directory, "manifest.json")).equals(
      readFileSync(manifestPath),
    )
  )
    fail("packaged manifest.json differs from the root manifest.");
  return sizes;
}

function main() {
  const pkg = readJson(join(root, "package.json"), "package.json");
  const manifest = readJson(manifestPath, "manifest.json");
  const versions = readJson(join(root, "versions.json"), "versions.json");
  const tag = requestedTag() ?? manifest.version;

  if (
    !semver.test(pkg.version) ||
    !semver.test(manifest.version) ||
    !semver.test(tag)
  )
    fail(
      "package, manifest, and tag versions must use stable x.y.z SemVer without a v prefix.",
    );
  if (pkg.version !== manifest.version || tag !== manifest.version)
    fail("package, manifest, and release tag versions must match exactly.");
  if (
    manifest.id !== "picgo-auto-uploader" ||
    manifest.name !== "PicGo Auto Uploader" ||
    manifest.minAppVersion !== "1.7.2" ||
    manifest.isDesktopOnly !== true
  )
    fail("manifest identity or desktop compatibility constants changed.");
  if (versions[manifest.version] !== manifest.minAppVersion)
    fail("versions.json must map the current version to minAppVersion.");
  for (const name of expectedAssets) {
    const path = join(root, name);
    if (
      !existsSync(path) ||
      !lstatSync(path).isFile() ||
      lstatSync(path).isSymbolicLink()
    )
      fail(`${name} must be a regular root file.`);
    if (lstatSync(path).size === 0) fail(`${name} must not be empty.`);
  }

  const unique = `${process.pid}-${Date.now()}`;
  const staging = join(root, `.release-stage-${unique}`);
  const backup = join(root, `.release-backup-${unique}`);
  assertManagedDirectory(staging, ".release-stage-");
  assertManagedDirectory(backup, ".release-backup-");
  const privatePaths = [root, process.cwd(), homedir()]
    .flatMap(pathVariants)
    .filter((value, index, values) => value && values.indexOf(value) === index);

  let stagingOwned = false;
  let backupHoldsPrevious = false;
  let installedNew = false;
  try {
    mkdirSync(staging);
    stagingOwned = true;
    for (const name of expectedAssets)
      copyFileSync(join(root, name), join(staging, name));
    const sizes = validateDirectory(staging, privatePaths);

    if (existsSync(backup))
      fail("refusing to replace a pre-existing backup path.");
    if (existsSync(releasePath)) {
      renameSync(releasePath, backup);
      backupHoldsPrevious = true;
    }
    injectTestFault("install");
    renameSync(staging, releasePath);
    stagingOwned = false;
    installedNew = true;
    if (backupHoldsPrevious) {
      removeManaged(backup, ".release-backup-");
      backupHoldsPrevious = false;
    }

    console.log(
      `Verified release ${tag}: ${sizes.map(([name, size]) => `${name} (${size} bytes)`).join(", ")}`,
    );
  } catch (error) {
    let rollbackError;
    if (backupHoldsPrevious) {
      try {
        if (installedNew && existsSync(releasePath)) {
          removeInstalledRelease();
          installedNew = false;
        }
        if (existsSync(releasePath))
          throw new Error("The replacement release could not be removed.");
        injectTestFault("rollback");
        renameSync(backup, releasePath);
        backupHoldsPrevious = false;
      } catch (failure) {
        rollbackError = failure;
      }
    }
    if (rollbackError) {
      const original =
        error instanceof Error ? error.message : "Install failed.";
      const rollback =
        rollbackError instanceof Error
          ? rollbackError.message
          : "Rollback failed.";
      throw new Error(
        `${original} Rollback failed: ${rollback} The previous release remains at ${basename(backup)}.`,
      );
    }
    throw error;
  } finally {
    if (stagingOwned && existsSync(staging))
      removeManaged(staging, ".release-stage-");
  }
}

try {
  main();
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Release audit failed.",
  );
  process.exitCode = 1;
}
