---
'@toon-protocol/client-mcp': patch
---

Split the daemon's write destination so relay publishes and store uploads route to the correct backend. Adds resolved `publishDestination` (relay writes → `POST /write`) and `storeDestination` (kind:5094 blob → `POST /store`) config fields — plus `TOON_CLIENT_PUBLISH_DESTINATION` / `TOON_CLIENT_STORE_DESTINATION` env overrides — each falling back to `destination` for backward-compat. `publish` (and `uploadMedia`'s NIP-94 reference event) default to `publishDestination`; the blob defaults to `storeDestination`, so uploads work via the default apex without the caller hand-passing a store `btpUrl`. An explicit per-call `destination` still wins; settlement is unchanged (pure ILP routing on the pre-signed apex claim).
