# @toon-protocol/rig-web

The Rig — a browser-only SPA that renders TOON Protocol events (NIP-34 git vocabulary first: repos, refs, issues, PRs) from a relay over WebSocket, with git objects fetched from Arweave gateways. No backend, no accounts, no servers.

## Development

```bash
pnpm dev                                          # connects to ws://localhost:7100
VITE_DEFAULT_RELAY=wss://relay.example pnpm dev   # override the default relay
```

## Relay resolution order

1. URL hash — the canonical shareable form is `#relay=wss://relay.example`
   (gateway-safe, no server-side rewrites). The app uses `HashRouter`, which
   owns the fragment, so boot code rewrites the bare form in place to the
   router-safe equivalent `#/?relay=wss://relay.example` (also accepted
   directly) before the router mounts; the config reader then matches
   `[?&]relay=` inside the fragment.
2. Query param — `?relay=…` (legacy)
3. Build-time default — `VITE_DEFAULT_RELAY` baked into the bundle

## Production build

```bash
# From the repo root (workspace deps must be built first):
VITE_DEFAULT_RELAY=wss://relay-ws.devnet.toonprotocol.dev \
  pnpm --filter @toon-protocol/rig-web... build
```

Output is a plain static directory in `packages/rig-web/dist/` (~2.2 MB, ~22 files). The app uses `HashRouter` and a relative Vite `base`, so it serves correctly from any sub-path — a project Pages site, an object-store prefix, or an Arweave path manifest — with no server-side rewrites.

## Deploying

### GitHub Pages (centralized interim)

The current standing deployment is GitHub Pages, serving the devnet-pointed build:

- **URL:** <https://toon-protocol.github.io/toon-client/>

Deploys are automatic: [`.github/workflows/deploy-rig-web.yml`](../../.github/workflows/deploy-rig-web.yml)
builds and publishes `dist/` via GitHub's Pages Actions build (`actions/configure-pages` +
`actions/deploy-pages`) on every push to `main` that touches `packages/rig-web/**`,
`packages/arweave/**`, or `packages/views/**` — the live UI tracks `main` automatically, no
manual deploy step required. To redeploy without a code change, run the workflow manually via
`workflow_dispatch`.

Point at any relay without rebuilding via the hash: `…/toon-client/#relay=wss://relay.example`
(boot code rewrites this to the router-safe `#/?relay=…`, which also works directly — see
[Relay resolution order](#relay-resolution-order)).

### Arweave (permanent, decentralized — currently blocked)

The target model: upload every `dist/` file as an Arweave data item, then upload a
[path manifest](https://specs.ar.io/#/en/manifests/1.0.0) (`application/x.arweave-manifest+json`)
mapping paths → txids with `index: index.html`, so one URL serves the whole app:

```
https://ar-io.dev/<manifest-txid>/#relay=wss://relay-ws.devnet.toonprotocol.dev
```

Two things block this today (as of 2026-07):

1. **ArDrive Turbo free tier caps single files at 105 KiB** (`freeUploadLimitBytes: 107520`;
   larger files answer with an x402 demand for Base-mainnet USDC). Four build outputs
   irreducibly exceed it — the shiki oniguruma wasm chunk (~622 KB), the main bundle's
   react-dom portion, and the TypeScript/JavaScript grammar chunks (~200 KB each) are
   single Rollup modules that `manualChunks` cannot split.
2. **The TOON store path is single-packet only on the client side.** The devnet store
   (kind:5094 DVM behind the payment proxy) verifiably forwards `Content-Type` to the
   gateway and works for small blobs via `toon_upload` / `rig push`, but no client-side
   chunked-upload driver exists yet (the server-side `ChunkManager` accepts up to 50 MB),
   and the store's own Turbo signer defaults to the same ≤105 KiB free tier unless the
   box sets `STORE_ARWEAVE_JWK_B64` to a funded wallet.

Unblocking either — a funded Turbo JWK (whole build ≈ $0.06 at current pricing) or a
chunked store client + funded store wallet — makes the permanent deploy a small script:
upload each file with its correct `Content-Type` tag, collect txids, upload the manifest,
serve from any gateway.

#### ArNS name — a stable URL instead of a changing manifest txId (additive, opt-in)

A raw manifest txId is unreadable and **changes on every redeploy**, so there is no stable
permanent URL even once the upload unblocks. [ArNS](https://ar.io) (the ar.io Name System)
fixes this: a registered name resolves at every gateway as `https://<name>.<gateway>/`,
serving whatever txId the name's ANT record points at. Since ar.io's Solana migration (June
2026) names are owned by a **Solana wallet** via [`@ar.io/sdk`](https://docs.ar.io) (prices in
mARIO, $ARIO base units).

`src/web/arns-deploy.ts` implements this as a **self-contained, additive** step, independent
of the two blockers above (it can be built and tested today against any small manifest):

- **One-time** — buy a name: `quoteBuyName()` (getTokenCost) then `buyName()` (buyRecord).
  Buying spawns an ANT owned by the deploy wallet.
- **Every redeploy** — `runArnsRedeployStep({ manifestTxId, ant })` points the name at the new
  manifest via `setBaseNameRecord`. It is **opt-in**: a no-op unless `RIG_ARNS_NAME` is set, so
  the existing flow is undisturbed.

Result — stable, human-readable, gateway-agnostic; the `#relay=` fragment (see
[Relay resolution order](#relay-resolution-order)) still works, so it stays relay-configurable
with no rebuild:

```
https://<name>.<any ar.io gateway>/#relay=wss://relay-ws.devnet.toonprotocol.dev
```

Config (env): `RIG_ARNS_NAME` (enables the step), `RIG_ARNS_TYPE` (`lease`|`permabuy`),
`RIG_ARNS_YEARS`, `RIG_ARNS_TTL_SECONDS`, `RIG_ARNS_GATEWAY`, `RIG_ARNS_RELAY`,
`RIG_ARNS_PROCESS_ID` (registry; default mainnet), `RIG_ARNS_WALLET` (the org deploy-identity
wallet that owns the name). The `@ar.io/sdk` clients are **injected**, so all money-moving
paths are unit-tested against mocks only — no real registry call, no funds spent.
