---
'@toon-protocol/client-mcp': minor
---

Default `destination`/`relayUrl` from the committed genesis peer seed (`@toon-protocol/core` `GenesisPeerLoader`) instead of hardcoded apex literals — env/file values still win, falling back to the legacy literals only when the seed list is empty. Add `deriveRouteDestinations()` so `publishDestination`/`storeDestination` split from the `*.relay.store` anchor (`g.proxy.relay.store` → `g.proxy.relay` / `g.proxy.store`) rather than reusing the anchor as a `/write` target (which the proxy 404s); anchors that don't match the convention fall back unchanged.
