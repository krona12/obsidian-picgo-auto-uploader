# PicGo Auto Uploader Design

## Purpose

Build a production-ready, Windows desktop-only Obsidian plugin that converts locally synced attachment images into remote PicGo-hosted images without breaking notes or deleting recoverable data.

The plugin scans configured attachment folders when Obsidian is ready, watches for newly created or modified images, waits until each file is stable, uploads it through the local PicGo HTTP service, rewrites every supported Markdown image embed that resolves to that file, verifies that no supported local reference remains, and only then moves the local image into the Vault's `.trash` folder.

The public project will live at `krona12/obsidian-picgo-auto-uploader` and ship as `PicGo Auto Uploader` with plugin ID `picgo-auto-uploader`.

## Product Principles

1. **Uncertainty preserves local data.** A network error, ambiguous PicGo response, stale metadata, unsupported link syntax, concurrent note edit, or failed final verification prevents deletion.
2. **A successful upload alone is not permission to delete.** At least one local Markdown embed must be rewritten and all supported references must pass final verification.
3. **Deletion is recoverable.** The plugin uses `Vault.trash(file, false)` and never permanently deletes attachment files.
4. **No duplicate work inside the plugin.** A normalized Vault path can have at most one active job. A saved remote URL is reused after a restart or rewrite failure.
5. **The plugin is inspectable.** Queue state, history, failures, and actions are visible in a native Obsidian status center; logs never contain secrets or image contents.
6. **No telemetry.** The plugin contacts only the configured PicGo endpoint and, optionally, the returned image URL when the user explicitly enables remote verification in a future release. Version 0.1.0 performs no remote URL probe.

## Scope

### Version 0.1.0 includes

- Windows desktop Obsidian support, `minAppVersion` 1.7.2, `isDesktopOnly: true`.
- Startup scan, Vault create/modify event handling, and a five-minute reconciliation scan.
- Configurable Vault-relative attachment folders, defaulting to `attachments`.
- Supported image extensions: `png`, `jpg`, `jpeg`, `gif`, `webp`, `bmp`, `svg`, and `avif`.
- A configurable 3-second quiet period, two stable observations 2 seconds apart, a 60-second stability timeout, and a configurable 50 MiB file-size limit.
- Sequential uploads to `http://127.0.0.1:36677/upload` using JSON `{ "list": [absolutePath] }`.
- Optional PicGo bearer secret sent in the `Authorization` header.
- Strict response validation and safe handling of timeout/connection ambiguity.
- Markdown embed discovery, context-aware target resolution, conservative rewrite, final verification, and recovery-safe trash.
- Persistent bounded job/history records, manual scan, manual retry, connection test, and redacted diagnostic export.
- Native Obsidian settings page, ribbon command, command palette actions, compact status-bar state, and a non-persistent modal status center.
- Simplified Chinese and English UI copy selected from Obsidian's current Moment locale.
- README, Chinese README, MIT license, contribution/security documents, CI, release workflow, and distributable release assets.

### Explicitly out of scope for version 0.1.0

- Running when Obsidian is closed.
- Mobile execution.
- Uploading clipboard images or intercepting paste.
- Rewriting Canvas, HTML, Base, Excalidraw, or arbitrary plugin data references.
- Deleting unreferenced/orphan images. They are reported and left untouched.
- Deleting remote images or deduplicating images already uploaded outside this plugin.
- Upload batching. One-file requests avoid partial-success mapping ambiguity.
- Automatic retry after an ambiguous timeout or disconnect. Such jobs require manual retry because PicGo may already have stored the image.
- Community-directory submission; the repository and first GitHub release will be prepared for later submission.

## Chosen Architecture

Three approaches were considered:

- Event-only processing is fast but can miss files created while the plugin is disabled or during startup.
- Polling-only processing is simple but slow and wasteful for large Vaults.
- A separate Windows service can run while Obsidian is closed but cannot safely use Obsidian's metadata and Vault mutation APIs.

Version 0.1.0 uses an Obsidian-native hybrid: event-driven enqueueing plus a low-frequency reconciliation scan. All mutation occurs through the official Obsidian APIs while the app is open.

The implementation is split into independently testable units:

- `PathPolicy`: normalizes Vault paths, checks configured folder boundaries and extensions, and rejects roots or traversal.
- `StabilityGate`: samples size and modification time until the file is stable or times out.
- `JobStore`: persists job state, remote URLs, bounded history, and redacted logs in plugin data.
- `UploadQueue`: serializes work, deduplicates paths, enforces legal state transitions, and supports cancellation.
- `PicGoClient`: probes `/heartbeat`, uploads one absolute path, applies authentication, rejects redirects, and validates PicGo responses.
- `ReferencePlanner`: reads Obsidian metadata, resolves each embed in its source-note context, and creates conservative text-edit plans.
- `ReferenceRewriter`: applies verified edits with `Vault.process`, then performs a fresh metadata/raw-text verification.
- `AttachmentProcessor`: orchestrates stability, reference discovery, upload/reuse, rewrite, verification, and trash.
- `AutoUploaderController`: owns scans, Vault events, timers, queue lifecycle, commands, and plugin unload cancellation.
- `SettingsTab`, `StatusModal`, and `StatusBar`: expose configuration and operational state through native Obsidian UI.

Core logic depends on small interfaces rather than the Obsidian runtime so it can be tested with in-memory fakes.

## Data Model and State Machine

Settings are stored with `Plugin.loadData()`/`saveData()`:

- PicGo endpoint and optional secret.
- Attachment folder list and allowed extensions.
- Automation toggle, quiet/stability timing, reconciliation interval, size limit, and retention limits.
- History and jobs. The secret is stored because Obsidian has no plugin secret store; the UI and README disclose that it resides in the plugin's local `data.json`.

Each job uses the normalized Vault path as its identity and stores a source fingerprint (`size`, `mtime`), state, timestamps, optional remote URL, rewritten note paths, retry classification, and a redacted error.

Legal states are:

`queued -> waiting-stable -> discovering-references -> uploading -> rewriting -> verifying -> trashed`

Failure exits are `skipped`, `failed`, `uncertain`, and `cancelled`. A job with a saved remote URL resumes at `rewriting`; it does not upload again. A timeout or disconnected upload becomes `uncertain` and never retries automatically. Explicit HTTP or validated PicGo failures become `failed` and may be retried manually.

History retains at most 500 terminal entries and 30 days. Active or resumable jobs are never discarded by retention cleanup.

## Processing Flow

1. After `Workspace.onLayoutReady`, register Vault listeners, enqueue the startup scan, and start the reconciliation interval.
2. A create/modify event or scan result passes through `PathPolicy`. Directories, `.trash`, hidden plugin data, disallowed formats, over-limit files, and paths outside configured folders are ignored or reported.
3. `UploadQueue` deduplicates the normalized path. `StabilityGate` requires two identical size/mtime observations after the quiet period, then the processor rechecks the fingerprint immediately before upload.
4. `ReferencePlanner` scans all Markdown files' cached embeds. For each embed it uses `MetadataCache.getFirstLinkpathDest(link, sourcePath)` and keeps it only when it resolves to the exact `TFile`. Missing cache, invalid positions, or unsupported syntax produces a safe failure. Zero references produces `skipped-orphan`; no upload occurs.
5. `PicGoClient` sends exactly one absolute path. Success requires a 2xx response, parseable JSON, `success === true`, exactly one valid `http:` or `https:` URL in `result`, and no contradictory error. If `items` exists, its successful item must agree with the returned URL and source origin when origin is present.
6. The verified URL is persisted before note mutation. On restart, this checkpoint permits rewrite retry without a duplicate upload.
7. `ReferenceRewriter` processes each note separately with `Vault.process`. It validates every cached source slice against the current text, applies edits from right to left, preserves Markdown alt text or wikilink display/size text, and changes no unrelated characters. Any mismatch aborts the deletion path.
8. Final verification refreshes and re-resolves supported Markdown embeds. It also searches Vault text files for unhandled obvious path references; any supported local reference, unsupported dependency, unreadable file, concurrent change, or verification error preserves the attachment.
9. If at least one reference was rewritten and verification is clean, call `Vault.trash(source, false)`. A trash failure is logged and leaves the job failed without attempting permanent deletion.
10. UI state is derived from the job store. Notices show only brief summaries; full redacted details stay in the status center.

## Link-Rewrite Rules

Supported forms are standard Obsidian image embeds whose metadata resolves to the target file:

- `![[attachments/image.png]]`
- `![[image.png|Alt text]]`
- `![[image.png|300]]`
- `![Alt text](attachments/image.png)`
- Markdown destinations wrapped in angle brackets or containing a title when they can be losslessly parsed.

The replacement remains an image embed and preserves the presentation payload:

- Wikilinks become `![display-or-empty](remote-url)`; numeric or `WIDTHxHEIGHT` display values remain in Obsidian's external-image alt/size form.
- Markdown embeds keep their original alt text and optional title while replacing only the destination.

HTML `<img>`, block/reference-style Markdown links, malformed embeds, and other formats are unsupported in 0.1.0. If one may reference the file, deletion is blocked and the status center explains why.

## PicGo Contract and Network Safety

- Default endpoint: `http://127.0.0.1:36677`.
- Upload endpoint is derived safely by resolving `/upload` on the configured origin. Credentials, query strings, and fragments are rejected in the base URL.
- Only `http` and `https` are allowed. Plain HTTP to a non-loopback host requires an explicit risk acknowledgement in settings.
- Redirects are rejected so a trusted local endpoint cannot silently forward image paths or authorization to another host.
- The secret uses `Authorization: Bearer <secret>` and is never added to a URL or log.
- The request has a configurable 30-second timeout. Aborts caused by plugin unload become `cancelled`; network timeouts/disconnects after dispatch become `uncertain`.
- `/heartbeat` tests only server availability. It does not mark future uploads safe.
- Version 0.1.0 does not fetch returned URLs; some image hosts block HEAD/CORS or serve eventually consistent content. The strict PicGo response is the success boundary.

## User Interface

### Settings page

The native `PluginSettingTab` contains:

- An enable/disable switch and a safety explanation.
- PicGo endpoint, optional secret, and a Test connection button.
- Attachment folder editor, allowed-extension editor, file-size limit, and automation timings.
- A warning/acknowledgement shown only for non-loopback plain HTTP.
- History retention controls and buttons to open the status center or reset non-secret defaults.

Validation appears next to the relevant control and invalid settings are not activated.

### Status center

A non-persistent native `Modal`, opened from the ribbon or command palette, contains:

- PicGo and automation status, queue depth, last scan, and last successful upload.
- Actions: Scan now, Retry safe failures, Cancel pending work, Export redacted diagnostics, Clear terminal history, and Open settings.
- Current queue rows with file name, state, elapsed time, and safe actions.
- Filterable recent history with status, stage, timestamp, rewritten-note count, and redacted error details.
- Empty, loading, offline, and error states. Color is never the only status signal; controls use native buttons and accessible labels.

The modal does not occupy a permanent sidebar. A status-bar item shows a compact icon/text summary on desktop.

### Commands

- `Open PicGo Auto Uploader status`
- `Scan attachment folders now`
- `Retry failed uploads`

## Error Handling and Logging

Errors use stable codes grouped by `path`, `stability`, `reference`, `upload`, `rewrite`, `verify`, `trash`, and `lifecycle`. User-facing copy is localized; stored codes remain language-independent.

Logs include timestamps, stages, normalized Vault-relative paths, and short safe messages. They exclude the PicGo secret, authorization headers, image bytes, full Windows absolute paths, and arbitrary server response bodies. Diagnostic export applies a second redaction pass and lists plugin/app versions and non-secret settings.

No error path calls `Vault.trash`. The only trash call is behind the processor's explicit success predicate: verified upload URL, at least one applied rewrite, unchanged source fingerprint, clean final verification, and active plugin lifecycle.

## Testing Strategy

Vitest covers pure components and orchestration with in-memory fakes. Required cases include:

- Windows path normalization, Unicode/spaces, folder-boundary checks, same-basename files, and traversal rejection.
- Duplicate events/scans, queue bounds, legal state transitions, cancellation, persisted resume, and timeout uncertainty.
- Stable, partially copied, locked, modified-before-upload, oversized, and removed source files.
- PicGo success, explicit failure, partial/malformed responses, unexpected redirects, authentication, URL validation, and secret redaction.
- All supported embed forms, multiple notes/references, stale cache positions, concurrent edits, unsupported references, and preservation of unrelated text.
- Orphan preservation, rewrite failure, verification failure, trash failure, and the positive full pipeline.
- Settings validation, localization fallback, bounded retention, and diagnostic sanitization.

The CI gate runs formatting check, lint, typecheck, unit/integration tests with coverage, build, and a release-asset audit. The asset audit permits only `main.js`, `manifest.json`, and `styles.css` in the distributable bundle and scans for credential/test-path sentinels.

## Repository and Release

The repository is public and uses an MIT license. Root files include `README.md`, `README.zh-CN.md`, `LICENSE`, `SECURITY.md`, `CONTRIBUTING.md`, `manifest.json`, and `versions.json`. Documentation discloses external network use, local file access, desktop-only behavior, PicGo prerequisites, the local `data.json` secret limitation, safety guarantees, recovery, troubleshooting, and manual installation.

GitHub Actions runs CI on pushes and pull requests. A release workflow builds from a SemVer tag matching `manifest.json` exactly (for example `0.1.0`, without a `v` prefix), verifies the package, and publishes `main.js`, `manifest.json`, and `styles.css` as release assets. Initial release version is `0.1.0`.

## Acceptance Criteria

- Installing the three release assets into `.obsidian/plugins/picgo-auto-uploader` loads the plugin in Obsidian 1.7.2 or later on Windows.
- A newly synced, referenced image is uploaded exactly once after it becomes stable; all supported Markdown embeds point to the returned URL; the source is moved to Vault `.trash` only after verification.
- Every upload, rewrite, verification, and trash failure retains the source image and appears in the status center with an actionable, redacted message.
- An orphan image is neither uploaded nor deleted.
- Restarting after upload but before rewrite reuses the saved URL instead of uploading again.
- Settings, queue/history UI, commands, localization, README, CI, and release assets are complete.
- The public GitHub repository and `0.1.0` release are available under `krona12`.
