import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseDirectory = join(repositoryRoot, "release");
const releaseScript = join(repositoryRoot, "scripts", "check-release.mjs");
const versionScript = join(repositoryRoot, "scripts", "version-bump.mjs");
const npmCli = process.env.npm_execpath;
const expectedAssets = ["main.js", "manifest.json", "styles.css"];
const stableSemver = /^\d+\.\d+\.\d+$/;
let nonRootDirectory = "";

function read(relativePath: string): string {
  return readFileSync(join(repositoryRoot, relativePath), "utf8");
}

function json<T>(relativePath: string): T {
  return JSON.parse(read(relativePath)) as T;
}

function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) {
  return spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: "utf8",
    env: options.env ?? process.env,
    shell: false,
  });
}

function releaseSnapshot(): Map<string, Buffer> {
  return new Map(
    readdirSync(releaseDirectory).map((name) => [
      name,
      readFileSync(join(releaseDirectory, name)),
    ]),
  );
}

function snapshotDirectory(directory: string): Map<string, Buffer> {
  return new Map(
    readdirSync(directory).map((name) => [
      name,
      readFileSync(join(directory, name)),
    ]),
  );
}

function createAuditFixture(): { root: string; script: string } {
  const root = mkdtempSync(join(tmpdir(), "picgo-audit-fixture-"));
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "release"));
  copyFileSync(releaseScript, join(root, "scripts", "check-release.mjs"));
  for (const name of [
    "package.json",
    "manifest.json",
    "versions.json",
    ...expectedAssets,
  ]) {
    copyFileSync(join(repositoryRoot, name), join(root, name));
  }
  for (const name of expectedAssets)
    copyFileSync(join(root, name), join(root, "release", name));
  return { root, script: join(root, "scripts", "check-release.mjs") };
}

function expectFailedWithoutReplacing(args: string[]): void {
  const before = releaseSnapshot();
  const result = run(process.execPath, [releaseScript, ...args]);
  expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
  const after = releaseSnapshot();
  expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
  for (const [name, bytes] of before) expect(after.get(name)).toEqual(bytes);
}

beforeAll(() => {
  nonRootDirectory = mkdtempSync(join(tmpdir(), "picgo-release-test-"));
  expect(npmCli, "npm_execpath must be available under npm test").toBeTruthy();
  const result = run(
    process.execPath,
    [npmCli!, "--prefix", repositoryRoot, "run", "package"],
    { cwd: nonRootDirectory },
  );
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}, 60_000);

afterAll(() => {
  if (nonRootDirectory)
    rmSync(nonRootDirectory, { recursive: true, force: true });
});

describe("release identity", () => {
  test("keeps package, manifest, versions mapping, and stable tag aligned", () => {
    const pkg = json<{ version: string }>("package.json");
    const manifest = json<{
      id: string;
      name: string;
      version: string;
      minAppVersion: string;
      isDesktopOnly: boolean;
    }>("manifest.json");
    const versions = json<Record<string, string>>("versions.json");

    expect(pkg.version).toMatch(stableSemver);
    expect(pkg.version).toBe("0.1.2");
    expect(manifest).toMatchObject({
      id: "picgo-auto-uploader",
      name: "PicGo Auto Uploader",
      version: pkg.version,
      minAppVersion: "1.7.2",
      isDesktopOnly: true,
    });
    expect(versions[pkg.version]).toBe(manifest.minAppVersion);
    expect(`v${pkg.version}`).not.toMatch(stableSemver);
  });

  test("version consistency check is mutation-free", () => {
    const before = ["package.json", "manifest.json", "versions.json"].map(read);
    const result = run(process.execPath, [versionScript, "--check"]);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(
      ["package.json", "manifest.json", "versions.json"].map(read),
    ).toEqual(before);
  });
});

describe("repository release files", () => {
  test("contains parseable release infrastructure and policy files", () => {
    const required = [
      "README.md",
      "README.zh-CN.md",
      "LICENSE",
      "SECURITY.md",
      "CONTRIBUTING.md",
      "CHANGELOG.md",
      ".github/workflows/ci.yml",
      ".github/workflows/release.yml",
      ".github/ISSUE_TEMPLATE/bug_report.yml",
      ".github/ISSUE_TEMPLATE/feature_request.yml",
      ".github/ISSUE_TEMPLATE/config.yml",
      "scripts/check-release.mjs",
      "scripts/version-bump.mjs",
    ];
    for (const path of required) expect(read(path).trim(), path).not.toBe("");
    expect(() => json("package.json")).not.toThrow();
    expect(() => json("manifest.json")).not.toThrow();
    expect(() => json("versions.json")).not.toThrow();
  });

  test.each([
    ["README.md", "English"],
    ["README.zh-CN.md", "Chinese"],
  ])("%s independently documents every safety boundary", (path, language) => {
    const content = read(path);
    const disclosures =
      path === "README.md"
        ? [
            /Windows desktop only/i,
            /Obsidian 1\.7\.2/i,
            /only while Obsidian is open/i,
            /http:\/\/127\.0\.0\.1:36677/i,
            /\/heartbeat/i,
            /\/upload/i,
            /one image/i,
            /png.*jpg.*jpeg.*gif.*webp.*bmp.*svg.*avif/is,
            /orphan.*neither uploaded nor deleted/is,
            /timeout.*disconnect.*uncertain/is,
            /not automatically retried/i,
            /saved URL.*same content hash/is,
            /temporary snapshot/i,
            /SHA-256/,
            /deleting.*intent/is,
            /exact source identity/i,
            /Vault\.delete\(file, true\)/i,
            /permanently delete/is,
            /restore.*backup.*sync history.*file-history/is,
            /file[- ]history/i,
            /duplicate remote image/i,
            /absolute Windows.*path/i,
            /optional bearer secret/i,
            /no telemetry/i,
            /no returned-URL probe/i,
            /data\.json/i,
            /compatible.*Obsidian 1\.7\.2.*SecretStorage/is,
            /non-loopback HTTP/i,
            /only.*\.canvas.*\.base.*\.html.*scanned/is,
            /unknown plugin data.*not detected.*not protected/is,
            /main\.js.*manifest\.json.*styles\.css/is,
            /source ZIP/i,
            /Vault-wide discovery.*enabled by default/is,
            /Open PicGo Auto Uploader status/i,
            /Scan referenced images now/i,
            /Retry failed uploads/i,
          ]
        : [
            /仅支持 Windows 桌面版/,
            /Obsidian 1\.7\.2/,
            /仅在 Obsidian 打开时/,
            /http:\/\/127\.0\.0\.1:36677/,
            /\/heartbeat/,
            /\/upload/,
            /每次.*一张图片/s,
            /png.*jpg.*jpeg.*gif.*webp.*bmp.*svg.*avif/is,
            /孤立.*既不会上传.*也不会删除/s,
            /超时.*断开.*不确定/s,
            /不会自动重试/,
            /内容哈希.*已保存的 URL/s,
            /临时快照/,
            /SHA-256/,
            /deleting.*删除意图/s,
            /源文件身份/,
            /Vault\.delete\(file, true\)/i,
            /永久删除/,
            /备份.*同步历史.*文件历史/s,
            /文件历史/,
            /重复的远程图片/,
            /Windows.*绝对路径/s,
            /Bearer.*密钥/is,
            /不收集遥测/,
            /不会探测返回的 URL/,
            /data\.json/,
            /兼容 Obsidian 1\.7\.2.*SecretStorage/s,
            /非本机.*HTTP/s,
            /仅.*\.canvas.*\.base.*\.html.*扫描/s,
            /未知插件数据.*无法检测.*不受保护/s,
            /main\.js.*manifest\.json.*styles\.css/is,
            /源码 ZIP/,
            /默认启用全仓库扫描/,
            /Open PicGo Auto Uploader status/,
            /Scan referenced images now/,
            /Retry failed uploads/,
          ];
    for (const disclosure of disclosures)
      expect(content, `${language}: ${disclosure}`).toMatch(disclosure);
  });
});

describe("release package", () => {
  test("audit resolves the repository independently of caller directory", () => {
    const result = run(process.execPath, [releaseScript], {
      cwd: nonRootDirectory,
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  test("contains exactly three non-empty regular assets", () => {
    expect(readdirSync(releaseDirectory).sort()).toEqual(expectedAssets);
    for (const name of expectedAssets) {
      const stat = lstatSync(join(releaseDirectory, name));
      expect(stat.isFile(), name).toBe(true);
      expect(stat.isSymbolicLink(), name).toBe(false);
      expect(stat.size, name).toBeGreaterThan(0);
    }
    expect(readFileSync(join(releaseDirectory, "manifest.json"))).toEqual(
      readFileSync(join(repositoryRoot, "manifest.json")),
    );
    expect(read("release/main.js")).not.toMatch(/sourceMappingURL/);
  });

  test("contains no checkout, home, credential sentinel, or concrete token", () => {
    const assets = expectedAssets
      .map((name) => read(`release/${name}`))
      .join("\n");
    const pathVariants = [
      repositoryRoot,
      process.cwd(),
      process.env.USERPROFILE,
    ]
      .filter((value): value is string => Boolean(value))
      .flatMap((value) => [value, value.replaceAll("\\", "/")]);
    for (const privatePath of new Set(pathVariants))
      expect(assets).not.toContain(privatePath);
    expect(assets).not.toMatch(/PICGO_TEST_SECRET|known-secret-sentinel/i);
    expect(assets).not.toMatch(
      /(?:ghp|github_pat|sk-[A-Za-z0-9_-]*)_[A-Za-z0-9_-]{20,}/,
    );
  });

  test("rejects a JavaScript-escaped Windows checkout path before replacing release", () => {
    const fixture = createAuditFixture();
    try {
      const before = snapshotDirectory(join(fixture.root, "release"));
      const escapedRoot = JSON.stringify(fixture.root).slice(1, -1);
      writeFileSync(
        join(fixture.root, "main.js"),
        `globalThis.syntheticPath = "${escapedRoot}";\n`,
        "utf8",
      );

      const result = run(process.execPath, [fixture.script], {
        cwd: fixture.root,
      });

      expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
      expect(result.stderr).toContain("contains a private local path");
      expect(snapshotDirectory(join(fixture.root, "release"))).toEqual(before);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("retains the last good backup when install and rollback both fail", () => {
    const fixture = createAuditFixture();
    try {
      const before = snapshotDirectory(join(fixture.root, "release"));
      const result = run(process.execPath, [fixture.script], {
        cwd: fixture.root,
        env: {
          ...process.env,
          NODE_ENV: "test",
          PICGO_RELEASE_TEST_FAULTS: "install,rollback",
        },
      });

      expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
      expect(existsSync(join(fixture.root, "release"))).toBe(false);
      const backups = readdirSync(fixture.root).filter((name) =>
        name.startsWith(".release-backup-"),
      );
      expect(backups).toHaveLength(1);
      expect(snapshotDirectory(join(fixture.root, backups[0]!))).toEqual(
        before,
      );
      expect(
        readdirSync(fixture.root).some((name) =>
          name.startsWith(".release-stage-"),
        ),
      ).toBe(false);

      renameSync(
        join(fixture.root, backups[0]!),
        join(fixture.root, "release"),
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("rejects mismatched and v-prefixed tags without replacing valid assets", () => {
    expectFailedWithoutReplacing(["--tag", "0.1.3"]);
    expectFailedWithoutReplacing(["--tag", "v0.1.2"]);
  });
});

describe("workflow policy", () => {
  test("CI is read-only, cross-platform, pinned, and cancels stale runs", () => {
    const workflow = read(".github/workflows/ci.yml");
    expect(workflow).toMatch(/push:[\s\S]*main/);
    expect(workflow).toMatch(/pull_request:/);
    expect(workflow).toMatch(/contents:\s*read/);
    expect(workflow).toMatch(/cancel-in-progress:\s*true/);
    expect(workflow).toMatch(/ubuntu-latest/);
    expect(workflow).toMatch(/windows-latest/);
    expect(workflow).toMatch(/node-version:\s*["']22\.12\.0["']/);
    expect(workflow).toMatch(/timeout-minutes:\s*20/);
    expect(workflow).toMatch(/npm ci/);
    expect(workflow).toMatch(/npm run check/);
    expect(workflow).not.toMatch(/secrets\./);
    expect(workflow).not.toMatch(/contents:\s*write/);
    expect(workflow).not.toMatch(/uses:\s*[^\s@]+@v\d/);
  });

  test("release uses minimal provenance permissions and publishes only audited assets", () => {
    const workflow = read(".github/workflows/release.yml");
    expect(workflow).toMatch(/tags:\s*\n\s*- ["']\*\*?['"]/);
    expect(workflow).toMatch(/contents:\s*write/);
    expect(workflow).toMatch(/id-token:\s*write/);
    expect(workflow).toMatch(/attestations:\s*write/);
    expect(workflow).toMatch(/artifact-metadata:\s*write/);
    expect(workflow).toMatch(/persist-credentials:\s*false/);
    expect(workflow).toMatch(/package-manager-cache:\s*false/);
    expect(workflow).toMatch(/RELEASE_TAG:\s*\$\{\{ github\.ref_name \}\}/);
    expect(workflow).toMatch(/npm ci/);
    expect(workflow).toMatch(/npm run check/);
    expect(workflow).toMatch(/retention-days:\s*[1-9]/);
    expect(workflow).toMatch(/gh release create.*--draft/);
    expect(workflow).toMatch(
      /release_records\(\) \{[\s\S]*gh api[\s\S]*releases/,
    );
    expect(workflow).toMatch(/existing_release_records=\$\(release_records\)/);
    expect(workflow).toMatch(/jq -r --arg tag "\$RELEASE_TAG"/);
    expect(workflow).toMatch(/existing_release_is_draft/);
    expect(workflow).toMatch(/Reusing existing draft release/);
    expect(workflow).toMatch(/expected_digests=.*sha256sum/s);
    expect(workflow).toMatch(/actual_digests=.*\.digest/s);
    expect(workflow).toMatch(/releases\/\$DRAFT_RELEASE_ID/);
    expect(workflow).toMatch(
      /--method PATCH[\s\S]*-F draft=false[\s\S]*-f make_latest=true/,
    );
    expect(workflow).not.toMatch(/releases\/tags\/\$RELEASE_TAG/);
    expect(workflow).not.toMatch(/gh release view/);
    expect(workflow).not.toMatch(/gh release edit/);
    expect(workflow).toMatch(/release\/main\.js/);
    expect(workflow).toMatch(/release\/manifest\.json/);
    expect(workflow).toMatch(/release\/styles\.css/);
    expect(workflow).not.toMatch(/uses:\s*[^\s@]+@v\d/);
  });
});
