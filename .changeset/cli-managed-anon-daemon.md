---
'@toon-protocol/client': minor
---

`toon` starts its own `anon` daemon for a `.anyone` connector

Point the CLI at a hidden-service connector with neither `--socks` nor `TOON_SOCKS` and it now
downloads a pinned, checksummed `anon` release, spawns it, proxies through it, and stops it when
the command ends. Every step is announced on stderr, so `--json` output stays exactly one
parseable document. The release is pinned to the stable `live` channel with a per-platform
sha256; an asset with no pinned hash refuses to download rather than downloading unverified, and
the binary is cached by version so only the first run pays for it.

The library still does none of this, deliberately: `@toon-protocol/client` accepts a `socksProxy`
and nothing more. See `docs/adr/0001-managed-anon-daemon-lives-in-the-cli.md`.
