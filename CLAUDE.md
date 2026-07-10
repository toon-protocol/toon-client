# toon-client

The TOON Protocol **consumer side**: `@toon-protocol/client` (pay-to-write Nostr client — one-mnemonic multi-chain identity, payment-channel lifecycle, balance-proof signing, free reads), `@toon-protocol/client-mcp` (the `toon-clientd` daemon + `toon-mcp` MCP server letting Claude agents act as a TOON client), `rig` — a drop-in `git` wrapper CLI (`rig push|issue|pr|comment`, `@toon-protocol/rig`) that publishes repo state as NIP-34 Nostr events with objects on Arweave, and `rig-web` (`@toon-protocol/rig-web`) — the separate browser-only frontend that interprets those same TOON events into a **decentralized control plane** (it speaks the NIP-34 git vocabulary backed by Arweave today, so it presents as a read-only git forge, but it is not a GitHub clone). Ships the `toon-plugin/` (the `toon-client` skill + `toon-mcp`).

Part of the **TOON Protocol** — pay-to-write Nostr over Interledger (ILP), split into per-team repos. The client signs a payment-channel claim and sends a TOON-encoded event over BTP to an apex; it reads free over Nostr WS.

## Build & test
```
pnpm install
pnpm -r build
pnpm -r test
```

## Shared skills, docs & project context → toon-protocol/toon-meta
Cross-cutting agent skills, docs, and the canonical project context live in **[toon-protocol/toon-meta](https://github.com/toon-protocol/toon-meta)**. Load the shared skills:
```
/plugin marketplace add toon-protocol/toon-meta
/plugin install toon-skills@toon-meta
```
The product-specific **`toon-client` skill ships in this repo's `toon-plugin/`** (not in toon-meta). Canonical rules: `toon-meta` → `_bmad-output/project-context.md`.

## Cross-repo dependencies
- Consumes `@toon-protocol/{core,sdk}` from **npm** (pinned semver); `client`/`client-mcp`/`rig` are co-located workspace packages.
- The ILP payment engine is the separate **[toon-protocol/connector](https://github.com/toon-protocol/connector)** repo. **Payment-claim validation lives ONLY in the connector — never re-implement it here.**

## Publishing
CI publishes via **changesets + `pnpm`** using the org `NPM_TOKEN` secret. **Never run `npm publish`** (it ships unresolved `workspace:*`).
