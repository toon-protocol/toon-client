# toon-client

TOON Protocol consumer side — `@toon-protocol/client` (pay-to-write Nostr client), `@toon-protocol/client-mcp` (agent daemon + MCP), the `rig` CLI (`@toon-protocol/rig`, Git-to-TOON write path), and the `toon-plugin`.

**Start here:** [packages/rig/README.md](packages/rig/README.md) — install the `rig` CLI, fund a wallet from the faucet, and push to the live devnet; it includes the canonical "Devnet reference (public chains)" (endpoints, faucet routes, settlement contracts).

**The wire:** a paid write is an OER envelope sealed to the connector that terminates its destination, under a condition derived from the secret inside that seal — see [How a paid write works](packages/client/README.md#how-a-paid-write-works-the-sealed-wire). The wire itself is defined by the Rust connector, not by prose here: this repo replays its committed cross-repo vectors, vendored and SHA-256 pinned at [packages/client/src/wire/vectors/](packages/client/src/wire/vectors/README.md), with a CI job that fails when they drift from connector `main`.

`rig-web` is a browser-only frontend that **interprets TOON events** — it subscribes to a relay (free reads), decodes the events delivered as packets, and fetches git objects from Arweave. It speaks the NIP-34 git vocabulary today, so it presents as a read-only git forge, but it is **not** a GitHub clone: the state lives as paid, permanent events on TOON rather than on an origin server, which makes the Rig a **decentralized control plane** with the git view as its first surface. It now lives in the [`toon-protocol/rig`](https://github.com/toon-protocol/rig) repo and is served at https://toon-protocol.github.io/rig/; this repo only keeps a [permanent redirect stub](.github/rig-web-redirect/index.html) at its old Pages URL because already-published Arweave rig pointers embed that URL forever. See [toon-meta/docs/rig-guide.md](https://github.com/toon-protocol/toon-meta/blob/main/docs/rig-guide.md).

> Extracted from the TOON monorepo with full git history preserved. npm publishing is done by CI (changesets + `pnpm`, authed by the org `NPM_TOKEN` secret). Docker image-publish workflows (where applicable) are a follow-up carved from the monorepo `publish-relay-images.yml`.

## Getting started with Devbox

[Devbox](https://github.com/jetify-com/devbox) pins a reproducible local
toolchain — Node `22` and pnpm `8.15.9` — so `pnpm build`, `pnpm test`, and
`pnpm lint` run in a shell without touching your system packages.

Devbox's pnpm still trails the repo's `packageManager` pin (`pnpm@9.12.3`,
matching the committed lockfileVersion 9): the Nix `pnpm_8` package hasn't
been bumped yet (tracked as a follow-up), so `devbox run build` installs with
`--no-frozen-lockfile` to bridge that version gap.

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
