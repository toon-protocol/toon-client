# toon-client

TOON Protocol consumer side — @toon-protocol/client (pay-to-write Nostr client), @toon-protocol/client-mcp (agent daemon + MCP), and the rig forge-UI + toon-plugin.

> Extracted from the TOON monorepo with full git history preserved. npm publishing is done by CI (changesets + `pnpm`, authed by the org `NPM_TOKEN` secret). Docker image-publish workflows (where applicable) are a follow-up carved from the monorepo `publish-townhouse-images.yml`.

## Getting started with Devbox

[Devbox](https://github.com/jetify-com/devbox) gives you a reproducible shell with the exact Node and pnpm versions pinned in `devbox.json` / `devbox.lock` — no manual version management required.

```sh
# install devbox (once, system-wide)
curl -fsSL https://get.jetify.com/devbox | bash

# enter the pinned dev shell — node@22 + pnpm@8.15.0 (via corepack) are on PATH
devbox shell

# then work as normal
pnpm install
pnpm -r build
pnpm -r test
```

Devbox reads the `packageManager` field in `package.json` and activates pnpm automatically via Corepack — no separate `devbox add pnpm` step needed.
