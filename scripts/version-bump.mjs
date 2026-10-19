import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const paths = {
  package: join(root, "package.json"),
  manifest: join(root, "manifest.json"),
  versions: join(root, "versions.json"),
};
const stableSemver = /^\d+\.\d+\.\d+$/;

function read(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function serialized(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function main() {
  const args = process.argv.slice(2);
  if (args.some((argument) => argument !== "--check") || args.length > 1)
    throw new Error("Usage: node scripts/version-bump.mjs [--check]");
  const check = args[0] === "--check";
  const pkg = read(paths.package);
  const manifest = read(paths.manifest);
  const versions = read(paths.versions);
  if (typeof pkg.version !== "string" || !stableSemver.test(pkg.version))
    throw new Error("package.json version must be stable x.y.z SemVer.");
  if (typeof manifest.minAppVersion !== "string" || !manifest.minAppVersion)
    throw new Error("manifest.json minAppVersion is required.");

  const nextManifest = { ...manifest, version: pkg.version };
  const nextVersions = {
    ...versions,
    [pkg.version]: manifest.minAppVersion,
  };
  if (check) {
    if (
      readFileSync(paths.manifest, "utf8") !== serialized(nextManifest) ||
      readFileSync(paths.versions, "utf8") !== serialized(nextVersions)
    )
      throw new Error(
        "Version files are inconsistent or not deterministically formatted.",
      );
    console.log(`Version files are consistent at ${pkg.version}.`);
    return;
  }
  writeFileSync(paths.manifest, serialized(nextManifest), "utf8");
  writeFileSync(paths.versions, serialized(nextVersions), "utf8");
  console.log(`Updated manifest.json and versions.json to ${pkg.version}.`);
}

try {
  main();
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Version update failed.",
  );
  process.exitCode = 1;
}
