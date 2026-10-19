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
  return [normalized, normalized.replaceAll("\\", "/")];
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

  try {
    mkdirSync(staging);
    for (const name of expectedAssets)
      copyFileSync(join(root, name), join(staging, name));
    const sizes = validateDirectory(staging, privatePaths);

    let backedUp = false;
    try {
      if (existsSync(releasePath)) {
        renameSync(releasePath, backup);
        backedUp = true;
      }
      renameSync(staging, releasePath);
      if (backedUp) removeManaged(backup, ".release-backup-");
    } catch (error) {
      if (!existsSync(releasePath) && backedUp && existsSync(backup))
        renameSync(backup, releasePath);
      throw error;
    }

    console.log(
      `Verified release ${tag}: ${sizes.map(([name, size]) => `${name} (${size} bytes)`).join(", ")}`,
    );
  } finally {
    if (existsSync(staging)) removeManaged(staging, ".release-stage-");
    if (existsSync(backup)) removeManaged(backup, ".release-backup-");
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
