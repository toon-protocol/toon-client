# toon-client

One package plus a CLI. `@toon-protocol/client` pays for an HTTP request, per request, in
stablecoin: it seals the request into a packet addressed to a route, attaches a signed claim on a
payment channel the user opened on chain, and returns the app's HTTP response. It ships as a
library and as the `toon` command.

A **connector** is a paid reverse proxy — it fronts an ordinary HTTP app, charges a flat price per
route, and hands that app a request that was already paid for. This repository is the payer, and
only the payer.

## Layout

```text
packages/client/src/
  client/     ToonClient, config, send(), errors      connector/  the client edge
  ilp/ http/ btp/   the two carriages and their port  wire/       envelope, gift wrap, vectors
  channel/    lifecycle, store, per-chain clients     signing/    balance proofs
  keys/       derivation + keystore                   wallet/     balances, transfers, faucet
  jobs/       NIP-90 job events + the ArNS ceremony   cli/        the `toon` command
```

## Build & test

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
pnpm typecheck
```

Test tiers, and the vectors, are in [docs/development.md](docs/development.md).

## The wire is the connector's

The normative contract is the Rust connector's client-edge spec and its **committed wire
vectors**, vendored here at `packages/client/src/wire/vectors/` and replayed as this package's own
conformance suite. Prose in this repository — including its docs — is not normative. Where the two
disagree, the vectors are right.

- **Payment-claim validation lives ONLY in the connector — never re-implement it here.**
- The packet is ILPv4 semantics in TOON's own encoding, and is not byte-compatible with RFC 0027.
- A refusal is **returned**, never thrown. Anything this client throws happened before the packet
  went out, or on chain.

The ILP payment engine, the connector itself, and the protocol documents are the separate
**[toon-protocol/connector](https://github.com/toon-protocol/connector)** repository.

## Dependencies

No `@toon-protocol/core` and no `@toon-protocol/sdk` — this package has no TOON-protocol runtime
dependencies at all. Its dependencies are `viem`, the `@noble`/`@scure` primitives, and optional
`ws` for the websocket carriage in Node.

## Docs

`README.md` is the front door and stays short. Everything else is in `docs/`:
getting-started, api, cli, channels, how-a-paid-packet-works, devnet, errors, troubleshooting,
development. `docs/devnet.md` is the only place the full address table lives.

## Shared skills, docs & project context → toon-protocol/toon-meta
Cross-cutting agent skills, docs, and the canonical project context live in **[toon-protocol/toon-meta](https://github.com/toon-protocol/toon-meta)**. Load the shared skills:
```bash
/plugin marketplace add toon-protocol/toon-meta
/plugin install toon-skills@toon-meta
```
Canonical rules: `toon-meta` → `_bmad-output/project-context.md`.

## Publishing
CI publishes via **changesets + `pnpm`** using the org `NPM_TOKEN` secret. **Never run `npm publish`** (it ships unresolved `workspace:*`).
