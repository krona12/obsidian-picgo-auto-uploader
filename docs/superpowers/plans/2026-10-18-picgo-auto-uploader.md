# PicGo Auto Uploader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build, verify, document, and release a Windows desktop Obsidian plugin that safely converts synced local attachment embeds to PicGo URLs and trashes local files only after verified rewrites.

**Architecture:** A small domain core owns settings validation, file policy, job state, upload protocol, rewrite planning, and the guarded processing pipeline. Thin Obsidian adapters supply Vault events, metadata, filesystem paths, persistence, and native UI. Work is event-driven with a periodic reconciliation scan and a sequential, deduplicating queue.

**Tech Stack:** TypeScript 5.8+, Obsidian API, Node `http`/`https`, esbuild, Vitest with V8 coverage, ESLint 9, GitHub Actions, Node 22.

**Spec:** `docs/superpowers/specs/2026-10-18-picgo-auto-uploader-design.md`

## Global Constraints

- Plugin ID `picgo-auto-uploader`, display name `PicGo Auto Uploader`, version `0.1.0`, `minAppVersion` `1.7.2`, desktop-only.
- Default PicGo origin `http://127.0.0.1:36677`; one source path per upload request; optional bearer secret; no telemetry or returned-URL probe.
- The only deletion operation is `Vault.trash(file, false)` after a verified upload, at least one successful rewrite, unchanged source fingerprint, and clean final verification.
- Orphan, ambiguous, unsupported, timed-out, cancelled, or failed inputs remain local.
- Native Obsidian UI only; settings page plus non-persistent status modal; English and Simplified Chinese.
- All filesystem commands run from `F:\workspace`; commands enter the project with PowerShell `Set-Location -LiteralPath` rather than setting tool `workdir`.
- Source changes follow red-green-refactor TDD; release claims require a fresh full verification run.

## Review Focus

- Duplicate create/modify/scan events must produce one active job and one upload request per normalized path.
- A PicGo timeout after dispatch must become `uncertain`, never automatic retry or deletion.
- Same-basename attachments and relative/Unicode/space-containing embeds must resolve to the exact target before rewrite.
- Cache staleness, concurrent note edits, unsupported references, or source fingerprint changes must block trash.
- Secrets and absolute Windows paths must be absent from logs, exported diagnostics, repository fixtures, and release assets.

---

### Task 1: Project foundation, domain types, and path/settings policy

**Files:**
- Create: `package.json`, `package-lock.json`, `tsconfig.json`, `esbuild.config.mjs`, `vitest.config.ts`, `eslint.config.mjs`, `.gitignore`, `.editorconfig`
- Create: `manifest.json`, `versions.json`, `src/domain.ts`, `src/defaults.ts`, `src/path-policy.ts`
- Test: `tests/path-policy.test.ts`, `tests/defaults.test.ts`

**Interfaces:**
- Produces `PluginSettings`, `JobRecord`, `JobState`, `LogEntry`, `SourceFingerprint`, `Result<T,E>` in `src/domain.ts`.
- Produces `DEFAULT_SETTINGS`, `validateSettings(input)`, `sanitizeSettings(input)` in `src/defaults.ts`.
- Produces `normalizeVaultPath(path)`, `isEligibleAttachment(path, settings)`, `isPathInsideFolder(path, folder)` in `src/path-policy.ts`.

- [ ] **Step 1: Write failing tests** for default values, endpoint/folder validation, path normalization, `.trash` exclusion, traversal/root rejection, extension checks, Unicode/spaces, and same-prefix folder boundaries.
- [ ] **Step 2: Run `npm test -- tests/path-policy.test.ts tests/defaults.test.ts`** and confirm failures are caused by missing modules.
- [ ] **Step 3: Add the project toolchain and minimal domain/settings/path implementations** matching the interfaces and manifest constants above.
- [ ] **Step 4: Run the focused tests, `npm run typecheck`, and `npm run build`**; require zero failures.
- [ ] **Step 5: Commit** with `feat: scaffold plugin domain and path policy`.

### Task 2: PicGo protocol and redacted diagnostics

**Files:**
- Create: `src/picgo-client.ts`, `src/redaction.ts`
- Test: `tests/picgo-client.test.ts`, `tests/redaction.test.ts`

**Interfaces:**
- Consumes `Result` and PicGo settings from Task 1.
- Produces `PicGoTransport.request(request, signal)`, `NodePicGoTransport`, `PicGoClient.heartbeat(signal)`, and `PicGoClient.uploadOne(absolutePath, signal)`.
- Produces `redactText(text, secrets, absolutePaths)` and `createDiagnosticExport(snapshot)`.

- [ ] **Step 1: Write failing transport-independent tests** for heartbeat, authorization, exact one-item JSON body, 2xx/JSON/`success`/one-URL validation, `items` contradiction, invalid schemes, explicit failures, redirect rejection, timeout classification, and sentinel redaction.
- [ ] **Step 2: Run `npm test -- tests/picgo-client.test.ts tests/redaction.test.ts`** and confirm expected missing-feature failures.
- [ ] **Step 3: Implement `PicGoClient` around an injected transport, then implement Node HTTP/HTTPS transport** with a 30-second timeout, no redirect following, bounded response size, and abort support.
- [ ] **Step 4: Run focused tests plus typecheck**; require all protocol and redaction cases to pass.
- [ ] **Step 5: Commit** with `feat: add strict PicGo client`.

### Task 3: Persistent jobs, stability gate, and sequential queue

**Files:**
- Create: `src/job-store.ts`, `src/stability-gate.ts`, `src/upload-queue.ts`
- Test: `tests/job-store.test.ts`, `tests/stability-gate.test.ts`, `tests/upload-queue.test.ts`

**Interfaces:**
- Consumes Task 1 domain types and settings.
- Produces `JobPersistence.load/save`, `JobStore.hydrate/snapshot/upsert/transition/appendLog/prune`, and `JobStore.subscribe`.
- Produces `FileProbe.stat(path)`, `StabilityGate.wait(path, options, signal)`, and `UploadQueue.enqueue/cancelPending/retrySafeFailures/drain`.

- [ ] **Step 1: Write failing tests** for legal/illegal transitions, bounded retention, resumable remote URLs, duplicate events, sequential execution, queue bounds, cancellation, stable samples, intermittent writes, removed/locked/oversized files, and plugin-unload abort.
- [ ] **Step 2: Run the three focused test files** and verify they fail for the absent implementations.
- [ ] **Step 3: Implement the store, gate, and queue minimally**, using injectable clock/sleep/probe/persistence dependencies and normalized paths as queue keys.
- [ ] **Step 4: Run focused tests and the full suite**; require zero failures and no unhandled rejections.
- [ ] **Step 5: Commit** with `feat: add durable upload queue`.

### Task 4: Conservative Markdown reference planning and rewriting

**Files:**
- Create: `src/reference-rewriter.ts`, `src/obsidian/reference-service.ts`
- Test: `tests/reference-rewriter.test.ts`, `tests/reference-service.test.ts`

**Interfaces:**
- Consumes `SourceFingerprint`, `Result`, and normalized target paths.
- Produces `EmbedReference`, `RewriteEdit`, `ReferenceDiscovery`, `buildRewriteEdit(reference, remoteUrl)`, and `applyVerifiedEdits(content, edits)`.
- Produces `ObsidianReferenceService.discover(target)`, `rewrite(plan, remoteUrl)`, `waitForRefresh(paths, signal)`, and `verifyNoLocalReferences(target)`.

- [ ] **Step 1: Write failing pure tests** for wikilinks, alt/size display text, Markdown destinations with spaces/angle brackets/titles, multiple reverse-ordered edits, escaped characters, unrelated text preservation, overlapping/stale offsets, and unsupported syntax.
- [ ] **Step 2: Write failing adapter tests** with an Obsidian fake for exact target resolution across multiple notes, same-basename files, missing cache, concurrent edits, metadata refresh timeout, Canvas/HTML blockers, and final verification.
- [ ] **Step 3: Run both focused test files** and confirm failures point to missing rewrite/reference behavior.
- [ ] **Step 4: Implement pure edit planning first, then the thin Obsidian reference service** using `getFileCache`, `getFirstLinkpathDest`, and `Vault.process`; ambiguity always returns a blocking result.
- [ ] **Step 5: Run focused tests, full suite, and typecheck**; require zero failures.
- [ ] **Step 6: Commit** with `feat: safely rewrite attachment references`.

### Task 5: Guarded attachment processor and Obsidian controller

**Files:**
- Create: `src/attachment-processor.ts`, `src/obsidian/controller.ts`, `src/obsidian/vault-adapter.ts`
- Test: `tests/attachment-processor.test.ts`, `tests/controller.test.ts`

**Interfaces:**
- Consumes `PathPolicy`, `StabilityGate`, `JobStore`, `PicGoClient`, `ObsidianReferenceService`, and `UploadQueue` from Tasks 1-4.
- Produces `AttachmentProcessor.process(vaultPath, signal)` and `AutoUploaderController.start/stop/scanNow/retrySafeFailures/cancelPending`.
- Produces an observable `ControllerSnapshot` for UI consumers.

- [ ] **Step 1: Write failing orchestration tests** for the full successful sequence and every deletion gate: orphan, upload failure, uncertain upload, saved-URL resume, rewrite failure, final-reference failure, changed source fingerprint, lifecycle cancellation, and trash failure.
- [ ] **Step 2: Write failing controller tests** for layout-ready startup, create/modify debounce, five-minute reconciliation, path deduplication, disabled automation, and listener/timer cleanup.
- [ ] **Step 3: Run focused tests** and confirm the missing processor/controller causes the failures.
- [ ] **Step 4: Implement the processor with one explicit `canTrash` predicate and implement the controller/adapters** using registered Obsidian events and timers.
- [ ] **Step 5: Run focused tests, full suite, typecheck, and build**; require zero failures.
- [ ] **Step 6: Commit** with `feat: orchestrate safe attachment conversion`.

### Task 6: Native UI, localization, and plugin entry point

**Files:**
- Create: `src/i18n.ts`, `src/ui/settings-tab.ts`, `src/ui/status-modal.ts`, `src/ui/status-bar.ts`, `src/main.ts`, `styles.css`
- Test: `tests/i18n.test.ts`, `tests/settings-ui.test.ts`, `tests/status-ui.test.ts`, `tests/main.test.ts`

**Interfaces:**
- Consumes `ControllerSnapshot`, commands, settings validation, PicGo heartbeat, diagnostics, and persistence from Tasks 1-5.
- Produces `t(locale, key, params)`, `PicGoAutoUploaderSettingTab`, `StatusModal`, `StatusBarPresenter`, and default export `PicGoAutoUploaderPlugin`.

- [ ] **Step 1: Write failing tests** for Chinese/English/fallback copy, settings validation and persistence, non-loopback HTTP acknowledgement, secret masking, status/empty/error views, action wiring, ribbon/commands/status registration, and unload cleanup.
- [ ] **Step 2: Run focused UI/entry tests** and verify failures arise from missing components.
- [ ] **Step 3: Implement native Obsidian UI and entry point** with semantic CSS variables, accessible labels, concise Notices, no permanent sidebar, and no external UI framework.
- [ ] **Step 4: Run focused tests, full suite, lint, typecheck, and build**; require zero failures and no warnings from project code.
- [ ] **Step 5: Commit** with `feat: add settings and status UI`.

### Task 7: Documentation, CI, release packaging, and GitHub publication

**Files:**
- Create: `README.md`, `README.zh-CN.md`, `LICENSE`, `SECURITY.md`, `CONTRIBUTING.md`, `CHANGELOG.md`
- Create: `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `.github/ISSUE_TEMPLATE/bug_report.yml`, `.github/ISSUE_TEMPLATE/feature_request.yml`
- Create: `scripts/check-release.mjs`, `scripts/version-bump.mjs`
- Test: `tests/release-package.test.ts`

**Interfaces:**
- Consumes the built `main.js`, root `manifest.json`, and `styles.css`.
- Produces repeatable commands `npm run check`, `npm run package`, and `npm run version` plus GitHub release assets for tag `0.1.0`.

- [ ] **Step 1: Write a failing release-package test** asserting exact asset names, matching SemVer/tag/version mapping, no secret/path sentinels, and required README safety/network disclosures.
- [ ] **Step 2: Run the release test** and confirm it fails because documentation/workflows/scripts are absent.
- [ ] **Step 3: Add complete bilingual documentation, policy files, issue templates, CI/release workflows, and release audit/version scripts** following the official Obsidian release contract.
- [ ] **Step 4: Run `npm run check`, `npm run package`, and inspect `git status --short`**; require passing tests/lint/typecheck/build/audit and only intentional files.
- [ ] **Step 5: Commit** with `docs: prepare PicGo Auto Uploader release`.
- [ ] **Step 6: Create the public GitHub repository `krona12/obsidian-picgo-auto-uploader`, push `main`, create tag/release `0.1.0`, upload `main.js`, `manifest.json`, and `styles.css`, then verify repository and release URLs**.

## Final Verification

- [ ] Run `npm ci` from a clean dependency state.
- [ ] Run `npm run check` and record exact test/lint/typecheck/build/audit results.
- [ ] Run `npm run package` and list the three generated release assets with sizes.
- [ ] Inspect the complete Git diff and commit history against every acceptance criterion in the spec.
- [ ] Have an independent reviewer inspect deletion gates, link rewriting, secret handling, UI completeness, docs, and workflows; resolve all blocking findings.
- [ ] Verify the public GitHub default branch and release `0.1.0` contain the expected source and assets.
