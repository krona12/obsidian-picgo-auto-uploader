# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/krona12/obsidian-picgo-auto-uploader/compare/0.1.1...HEAD
[0.1.1]: https://github.com/krona12/obsidian-picgo-auto-uploader/compare/0.1.0...0.1.1
[0.1.0]: https://github.com/krona12/obsidian-picgo-auto-uploader/releases/tag/0.1.0
