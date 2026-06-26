# toon-client

TOON Protocol consumer side — `@toon-protocol/client` (pay-to-write Nostr client), `@toon-protocol/client-mcp` (agent daemon + MCP), and `rig` + the `toon-plugin`.

`rig` (`@toon-protocol/rig`) is a browser-only frontend that **interprets TOON events** — it subscribes to a relay (free reads), decodes the events delivered as packets, and fetches git objects from Arweave. It speaks the NIP-34 git vocabulary today, so it presents as a read-only git forge, but it is **not** a GitHub clone: the state lives as paid, permanent events on TOON rather than on an origin server, which makes the Rig a **decentralized control plane** with the git view as its first surface. See [toon-meta/docs/rig-guide.md](https://github.com/toon-protocol/toon-meta/blob/main/docs/rig-guide.md).

> Extracted from the TOON monorepo with full git history preserved. npm publishing is done by CI (changesets + `pnpm`, authed by the org `NPM_TOKEN` secret). Docker image-publish workflows (where applicable) are a follow-up carved from the monorepo `publish-relay-images.yml`.

## Getting started with Devbox

[Devbox](https://github.com/jetify-com/devbox) pins the local toolchain to the exact
versions CI uses — Node `22` and pnpm `8.15.9` — so `pnpm build`,
`pnpm test`, and `pnpm lint` run in a reproducible shell without touching your system
packages.

**Prerequisites:** [Install devbox](https://www.jetify.com/devbox/docs/installing_devbox/) (one-liner).

```bash
# Enter the pinned shell (downloads packages on first run via Nix)
devbox shell

# Inside the devbox shell, all tools are on PATH:
node --version    # v22.x
pnpm --version    # 8.15.9

# Run the standard targets (defined as devbox scripts)
devbox run build  # pnpm install --no-frozen-lockfile && pnpm build
devbox run lint
devbox run test
```

`.devbox/` (the Nix symlink/cache dir) is gitignored; `devbox.json` and `devbox.lock`
are committed.
