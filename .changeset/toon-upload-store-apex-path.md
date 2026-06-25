---
'@toon-protocol/client-mcp': patch
'@toon-protocol/views': patch
---

Fix `toon_upload` against a discovered store/DVM apex (e.g. `g.proxy.store`), which failed at several independent points on the payment path:

- **No route to destination (F02):** `deriveApexClientConfig` now derives a per-apex `proxyUrl` from the apex `btpUrl`, so paid packets POST to the discovered apex's connector instead of the default (relay) connector, which has no route to the store's ILP prefix.
- **Wrong apex for the ref event:** `uploadMedia` now publishes the NIP-94 reference event through the default (relay) apex rather than the upload's `btpUrl`, since a store/DVM apex only serves `POST /store`.
- **ar.io gateway:** media URLs and the views CSP default to `https://ar-io.dev` (the canonical gateway) so uploaded media renders; `arweave.net` is retained in the CSP for back-compat.
