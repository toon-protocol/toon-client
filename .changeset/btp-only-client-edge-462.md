---
'@toon-protocol/client': patch
'@toon-protocol/rig': patch
---

Fix a BTP-only client (no `connectorUrl`/`proxyUrl`) failing every paid write (issue #462, toon-meta#345). Since the sealed wire (ADR 0018/0020) made `GET /ilp/identity` and `GET /ilp/routes/price` mandatory over the HTTP client edge before any packet is formed, callers that supplied only `btpUrl` had been papering over `validateConfig`'s edge requirement with an inert `http://127.0.0.1:1` placeholder — which every paid write now dialled and failed to connect to.

- `applyDefaults` (`packages/client`) now derives a REAL client edge (`connectorUrl` + `connectorHttpEndpoint`) from `btpUrl` when neither `connectorUrl` nor `proxyUrl` is configured: connector PR #181 serves ILP-over-HTTP and BTP on the same port, so the BTP origin doubles as the identity/price/one-shot-write endpoint. `validateConfig` now accepts `btpUrl` as a third alternative to `connectorUrl`/`proxyUrl`.
- `client-mcp`'s daemon config and `rig`'s standalone-mode publisher no longer inject the `127.0.0.1:1` placeholder for a BTP-only config — only the genuinely uplink-less (free-read-only) case still does, since nothing there ever publishes to dial it.
- `rig`: extracted `connectorEdgeFields()` (exported from `standalone-mode.ts`) so the client-edge selection is independently unit-testable.
- Corrected `FeeRates.uploadFee`'s docstring (`packages/rig/src/publisher.ts`), which described the price as sourced only from `GET /ilp/routes/price` when rig's standalone publisher also legitimately reads it from an announce's `capabilities`.
