# Contributing

Thank you for improving PicGo Auto Uploader. Changes must preserve local data whenever the result is uncertain.

## Development setup

Install Node.js 22.12 or later, then run:

```powershell
npm ci
npm test
npm run check
npm run package
```

Use red-green-refactor: add the smallest failing Vitest test, confirm the expected failure, implement the behavior, then run the focused test and the full suite. Use synthetic Vault paths, images, tokens, and responses only; never commit real credentials, private paths, images, or note contents.

## Mandatory safety invariants

- The only local deletion operation is `Vault.delete(file, true)`, reached through the processor's complete safety predicate. It is irreversible.
- Deletion requires a validated remote URL, a positive rewrite count, fresh clean reference verification, an unchanged SHA-256 content fingerprint, an active lifecycle, exact source identity, and a durable `deleting` intent.
- Orphans, ambiguity, unsupported references, timeout/disconnect, cancellation, and any failed gate retain the source.
- An uncertain upload is never retried automatically.
- Saved remote URLs are checkpointed before rewriting and reused after restart.
- Logs, UI, diagnostics, fixtures, and release assets contain no secrets, image bytes, or private absolute paths.

Documentation that changes user behavior or safety must update both `README.md` and `README.zh-CN.md` with equivalent information.

## Pull request checklist

- [ ] A failing regression/feature test was observed before implementation.
- [ ] `npm run check` succeeds.
- [ ] `npm run package` produces exactly the three documented assets.
- [ ] Deletion and retry invariants are unchanged or strengthened.
- [ ] Fixtures are synthetic and diagnostics are sanitized.
- [ ] English and Simplified Chinese documentation are aligned.
- [ ] The change and safety impact are described clearly.

## Maintainer release sequence

Use a stable SemVer tag without a `v` prefix:

```powershell
npm version <x.y.z> --no-git-tag-version
npm run check
git add package.json package-lock.json manifest.json versions.json CHANGELOG.md
git commit -m "chore: release <x.y.z>"
git tag -a <x.y.z> -m "PicGo Auto Uploader <x.y.z>"
git push origin main
git push origin <x.y.z>
```

`package.json` is the version source of truth. The version lifecycle updates `manifest.json` and preserves prior `versions.json` mappings. The tag workflow rejects mismatches and publishes only the audited `main.js`, `manifest.json`, and `styles.css`.
