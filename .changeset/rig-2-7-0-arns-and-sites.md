---
"@toon-protocol/rig": minor
---

rig: ArNS naming verbs + pushed repos as permaweb sites.

- `rig name buy/set/status` (#367): ArNS naming verbs owned and paid by the rig mnemonic's Solana key (no new key material). estimate→confirm→execute + strict `--json` + `--yes`; `@ar.io/sdk` is an optional, lazily-imported dependency; `status` is a free registry read. Fee output states payment is mARIO on Solana via the ar.io registry, not ILP.
- `rig site publish` / `rig site url` (#368): build and serve an ar.io path manifest per ref so a pushed repo doubles as a permaweb site, with `--spa`/`--fallback`/`--gateway`/`--force-reupload`. Per-file `Content-Type` is now derived from the blob path on kind:5094 blob uploads (previously hardcoded to `application/octet-stream`).

All money-moving paths are estimate→confirm→execute and were mock-tested only — no funds spent by this release.
