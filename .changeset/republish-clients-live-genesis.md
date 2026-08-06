---
'@toon-protocol/client-mcp': patch
'@toon-protocol/client': patch
---

Resolve `@toon-protocol/core` at `^3.2.0` so shipped clients bootstrap against the live devnet apex.

`client-mcp` inlines the genesis peer seed at build time, so the published
`0.36.5` bundle carried `core@3.1.4`'s retired values — `3f12da6d…` (the
decommissioned TypeScript connector's nostr key), `g.proxy`, and the root-path
BTP endpoint. `ToonClient`'s bootstrap filter is author-pinned, so it discarded
the live announce from the current announcer and could not discover the apex at
all. Raising the range to `^3.2.0` (in `client`, `client-mcp` and the workspace
`rig`) makes the build bake `30fdd01d…` / `g.toon` / `…/ilp/btp` instead.

`client` itself does not inline the seed — it reads it from `core` at runtime —
but its range is raised too so the corrected seed is an explicit requirement
rather than something a consumer's resolution happens to satisfy.
