# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.3] - 2026-10-19

### Fixed

- Wait for each rewritten note's link resolution after its matching metadata cache update, preventing normal Obsidian `changed` → `resolve` → `resolved` ordering from being reported as a source change.
- Treat the all-files `resolved` notification as a summary instead of a new mutation, while retaining invalidation for real Vault and per-file metadata changes.
- Stop unchanged orphan attachments from being retried and logged on every reconciliation scan. Orphans are rechecked at startup and after Markdown, Canvas, Base, or HTML reference sources change.

### Changed

- Report a reference-state race separately from a physical source change, then safely retry it without uploading the already confirmed image again.
- Clarify in the status center that orphan attachments were skipped, not uploaded, and retained locally.

### Safety

- Permanent deletion still requires a confirmed PicGo URL, completed reference rewrites, fresh resolution and verification, zero remaining local dependencies, an unchanged SHA-256 fingerprint, exact source identity, no pending snapshot cleanup, and a valid mutation proof.
- Upload, rewrite, refresh, verification, or deletion-precondition failures continue to retain the Vault source. A confirmed conversion still uses permanent `Vault.delete`; it is not moved into local Vault trash.

## [0.1.2] - 2026-10-19

### Fixed

- Scope reference blockers to the image currently being processed, so unrelated external HTML images, broken links, code examples, or missing metadata no longer block every upload in the Vault.
- Preserve local CSS/HTML dependencies, extensionless Markdown image and file links, and unsupported cached reference-style embeds during target-scoped safety scans.
- Preserve the first concrete reference failure code and blocking note path in job history and diagnostics.

### Changed

- Permanently delete a successfully converted local source with Obsidian's `Vault.delete` API instead of moving it into Vault `.trash`.
- Upload an immutable temporary snapshot instead of the live Vault path, bind saved URLs to a SHA-256 content fingerprint, and remove the snapshot after PicGo returns.
- Preserve a confirmed remote URL when post-upload verification or snapshot cleanup is temporarily unavailable, preventing an unnecessary duplicate upload. Persist an opaque cleanup checkpoint, retain the Vault source until the private snapshot is gone, and clean crash-left plugin snapshots on startup.
- Retry only private-snapshot cleanup during reconciliation, including for uncertain uploads, without implicitly authorizing another upload, rewrite, or source deletion. Automatically re-evaluate legacy `discovery-blocked` jobs and safely changed source generations after restart.
- Start a new job generation when a strong content hash proves that the file changed during upload, allowing the replacement bytes to upload without ever assigning the old URL to them.
- Persist a `deleting` write-ahead state so restart recovery can reconcile completed or interrupted permanent deletion without another upload.

### Safety

- Permanent deletion still requires a confirmed PicGo response, no pending private snapshot cleanup, at least one persisted rewrite, fresh metadata verification, zero remaining target dependencies, an unchanged SHA-256 fingerprint, exact file identity, an active lifecycle, and a valid mutation proof.
- Any failure before permanent-delete dispatch retains the local source. An ambiguous deletion outcome remains in the durable `deleting` state and is reconciled without another upload.

## [0.1.1] - 2026-10-19

### Changed

- Scan supported images across the entire Vault by default, including files stored at the Vault root or outside configured attachment folders.
- Add a **Scan the entire Vault** setting; disabling it restores the configured-folder-only scope.
- Rename the manual scan command to `Scan referenced images now`.

### Safety

- Vault-wide discovery still excludes hidden folders and Vault trash, and only uploads images with supported Markdown references.
- Unreferenced images remain local, while upload, rewrite, verification, fingerprint, and trash gates are unchanged.

## [0.1.0] - 2026-10-19

### Added

- Windows desktop attachment scanning with event-driven and periodic reconciliation.
- Sequential PicGo HTTP uploads, optional bearer authentication, durable job history, and restart-safe URL checkpoints.
- Conservative Markdown image reference rewriting for resolved wikilinks and inline image embeds.
- English and Simplified Chinese settings, status center, status bar, ribbon action, and commands.
- Redacted diagnostic export, connection test, safe/manual retry controls, and release packaging audit.

### Safety

- Local images move to Vault `.trash` only after every upload, rewrite, verification, fingerprint, lifecycle, and identity gate passes.
- Orphans, ambiguous references, upload uncertainty, concurrent changes, and failures retain the local source.
- Timeout/disconnect results never retry automatically, and saved URLs resume rewriting without duplicate uploads.

[Unreleased]: https://github.com/krona12/obsidian-picgo-auto-uploader/compare/0.1.3...HEAD
[0.1.3]: https://github.com/krona12/obsidian-picgo-auto-uploader/compare/0.1.2...0.1.3
[0.1.2]: https://github.com/krona12/obsidian-picgo-auto-uploader/compare/0.1.1...0.1.2
[0.1.1]: https://github.com/krona12/obsidian-picgo-auto-uploader/compare/0.1.0...0.1.1
[0.1.0]: https://github.com/krona12/obsidian-picgo-auto-uploader/releases/tag/0.1.0
