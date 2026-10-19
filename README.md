# PicGo Auto Uploader

[简体中文](README.zh-CN.md)

PicGo Auto Uploader is a safety-first Obsidian plugin for converting synced local image attachments into PicGo-hosted Markdown embeds. It is Windows desktop only, requires Obsidian 1.7.2 or later, and runs only while Obsidian is open.

The plugin watches configured attachment folders, waits for each file to stop changing, uploads referenced images one at a time, rewrites every supported Markdown embed, verifies the result, and then moves the source to the Vault trash. Uncertainty always preserves the local file.

## Requirements

- Windows desktop and Obsidian 1.7.2+.
- PicGo with its HTTP server enabled. The default address is `http://127.0.0.1:36677`.
- A working PicGo uploader/provider configuration.
- A backup or file-history system. Start with a small test folder before enabling the plugin across an important Vault.

The PicGo `POST /heartbeat` endpoint is used only by **Test connection**. Each actual upload sends one image per `POST /upload` request; a successful heartbeat does not guarantee that a later upload will succeed.

## How it works

1. A startup scan, create/modify events, and a five-minute reconciliation scan find eligible files in configured attachment folders.
2. The file must pass the extension/size rules and remain unchanged for the configured stability observations.
3. Obsidian metadata must resolve at least one supported image embed to the exact source file. An orphan is neither uploaded nor deleted.
4. The absolute Windows source path is sent to PicGo. The response must contain one validated `http:` or `https:` URL.
5. The confirmed URL is saved before notes are changed. A saved remote URL resumes rewriting after restart without another upload.
6. All supported references are rewritten and checked again against fresh note content and metadata.
7. Only after every deletion gate passes does Obsidian move the local image to the Vault `.trash` folder. It is never permanently deleted by this plugin.

Uploads are sequential. A timeout or disconnect after dispatch is marked `uncertain` and is not automatically retried because PicGo may already have stored the image. Inspect PicGo and the provider before explicitly retrying uncertain work; a retry may create a duplicate remote image.

## Supported content

The default attachment folder is `attachments`. Eligible extensions are exactly `png`, `jpg`, `jpeg`, `gif`, `webp`, `bmp`, `svg`, and `avif`. Both the folders and the allowed subset of extensions are configurable.

Supported image embeds include:

```markdown
![[attachments/image.png]]
![[image.png|Alt text]]
![[image.png|300]]
![Alt text](attachments/image.png)
![Alt text](<attachments/image with spaces.png> "Title")
```

The target must resolve to the exact attachment in the source note's context. The plugin preserves Markdown alt text, titles, and Obsidian display/size text while converting to an external image embed.

Within Markdown files, HTML `<img>`, reference-style/block links, malformed embeds, and other plausible raw dependencies are not rewritten but do block deletion. In addition to Markdown, only `.canvas`, `.base`, and `.html` files are scanned conservatively for a plausible path or file-name dependency; a match blocks deletion.

Other formats, including Excalidraw and unknown plugin data, are not interpreted or scanned in 0.1.0. References stored only in unknown plugin data are not detected and are not protected by the deletion check. Do not enable automatic processing for attachments relied on only by such formats; keep backups and test with a small folder. Missing/stale Markdown metadata, unreadable protected files, overlapping offsets, or concurrent edits also leave the source in place.

## Deletion safety

A source can be trashed only when all of these are true:

- PicGo returned exactly one validated remote URL.
- At least one reference was positively rewritten.
- Fresh reference verification finds no local or ambiguous dependency.
- The unchanged source fingerprint still matches the verified upload input.
- The plugin lifecycle is still active.
- The file is still the exact source identity being processed.

Any upload, rewrite, verification, fingerprint, lifecycle, or trash error retains the local attachment and records a redacted status. Orphans remain local. The sole deletion operation is Obsidian's recoverable Vault trash API, which moves files to `.trash` rather than permanently deleting them.

## Privacy and network access

The plugin reads eligible Vault images, Markdown notes, and Obsidian metadata. It sends the absolute Windows source path and, when configured, an optional bearer secret only to the configured PicGo endpoint. PicGo then reads the image and sends its bytes to the image provider selected by the user.

Version 0.1.0 has no telemetry and performs no returned-URL probe. It does not contact an analytics service. Logs and exported diagnostics redact configured secrets and absolute paths; they do not contain image bytes or arbitrary PicGo response bodies.

To remain compatible with Obsidian 1.7.2, version 0.1.0 does not rely on newer SecretStorage APIs. The optional secret is plaintext in this plugin's local `data.json`; syncing that file can expose it. Exclude `.obsidian/plugins/picgo-auto-uploader/data.json` from synchronization or do not store a secret if that risk is unacceptable.

Plain HTTP is safe from passive network observers only when it stays on the local machine. A non-loopback HTTP endpoint exposes paths and credentials on the network, so the settings page requires explicit acknowledgement. Prefer loopback or HTTPS.

## Settings and status center

Open **Settings → Community plugins → PicGo Auto Uploader** to configure automation, PicGo address/secret, folders, extensions, size limit, timing, and history retention. Invalid settings are not activated. **Test connection** calls only `POST /heartbeat`.

Use the ribbon icon, status bar, or command palette to open the non-persistent status center. It shows PicGo reachability, automation state, queue/history, last scan, last successful conversion, redacted failures, and safe actions. It can scan now, retry safe failures, require confirmation for uncertain retries, cancel pending work, clear completed history, and export redacted diagnostics.

Commands are named exactly:

- `Open PicGo Auto Uploader status`
- `Scan attachment folders now`
- `Retry failed uploads`

## Recovery

1. Disable automatic processing while investigating.
2. Restore the attachment from the Vault `.trash` folder if it was moved there.
3. Recover or revert Markdown from your backup or file history when needed.
4. Review the status center and export sanitized diagnostics.
5. For `uncertain` uploads, inspect PicGo and the image provider before retrying; the remote image may already exist and an explicit retry can duplicate it.

The plugin never deletes remote images. Keep regular Vault backups and trial the workflow with a small folder first.

## Manual installation

1. Open the [Releases](https://github.com/krona12/obsidian-picgo-auto-uploader/releases) page and download `main.js`, `manifest.json`, and `styles.css` from the same release.
2. Create `<vault>/.obsidian/plugins/picgo-auto-uploader/`.
3. Copy the three files directly into that directory.
4. Reload Obsidian, then enable **PicGo Auto Uploader** under Community plugins.

Do not use GitHub's source ZIP as the plugin package; it does not contain the audited built plugin assets.

## Troubleshooting

### PicGo is offline

Start PicGo, enable its HTTP server, confirm the port, and use **Test connection**. The default is `http://127.0.0.1:36677`. A firewall or a different PicGo port can also block access.

### An image was skipped

Confirm that it is inside a configured folder, uses an enabled extension, is below the size limit, and has a supported Markdown image embed. Orphans and ambiguous references are intentionally retained.

### A job is uncertain

The connection ended after upload dispatch. Check PicGo/provider history before selecting the explicit retry action. There is no safe automatic retry without an idempotency contract.

### A file remains after a URL was returned

This is expected when rewriting or final verification cannot prove safety. Review the redacted failure, fix unsupported or stale references, then retry. A saved URL prevents another upload during safe rewrite recovery.

## Development

Node.js 22.12 or later is required.

```powershell
npm ci
npm test
npm run check
npm run package
```

`npm run check` performs formatting, lint, type checking, coverage tests, build, and release audit. `npm run package` creates `release/` containing exactly `main.js`, `manifest.json`, and `styles.css`.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and release rules, [SECURITY.md](SECURITY.md) for private vulnerability reporting, and [CHANGELOG.md](CHANGELOG.md) for release notes.

## License

[MIT](LICENSE) © 2026 krona12.
