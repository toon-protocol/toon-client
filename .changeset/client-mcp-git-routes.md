---
'@toon-protocol/client-mcp': minor
---

Publish the daemon `/git` routes so `rig push` / `rig fetch` / `rig clone` can
run through a live `toon-clientd`.

The git-over-HTTP routes (`packages/client-mcp/src/daemon/git-routes.ts`) that
let the `rig` CLI reuse the daemon's funded identity + payment channel were on
`main` but never got a release bump — so the published `0.15.0` predates them.
Against that daemon the CLI aborts with "toon-clientd … is too old to handle git
operations (missing /git routes)", and `npm i -g @toon-protocol/client-mcp@latest`
is a no-op because latest *is* the routes-less build.

This cuts the release that actually carries the routes, so the upgrade path the
CLI recommends works. No API surface changes for MCP tools; purely additive
daemon HTTP routes (bundled into `dist`, so no dependency coordination needed).
