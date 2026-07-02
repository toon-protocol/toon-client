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
- Branch: `gh-pages` (orphan branch containing only `dist/` + `.nojekyll`)

Repeatable deploy:

```bash
VITE_DEFAULT_RELAY=wss://relay-ws.devnet.toonprotocol.dev \
  pnpm --filter @toon-protocol/rig-web... build
cd packages/rig-web/dist
touch .nojekyll
git init -b gh-pages && git add -A && git commit -m "deploy: rig-web"
git push --force https://github.com/toon-protocol/toon-client.git gh-pages:gh-pages
```

Pages picks up the branch automatically (already enabled on the repo). Point at any relay without rebuilding via the hash: `…/toon-client/#relay=wss://relay.example` (boot code rewrites this to the router-safe `#/?relay=…`, which also works directly — see [Relay resolution order](#relay-resolution-order)).

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
