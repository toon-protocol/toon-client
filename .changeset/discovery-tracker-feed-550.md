---
"@toon-protocol/client": patch
"@toon-protocol/client-mcp": patch
---

Fix `TERMINATOR_UNRESOLVED` on every paid write: `discoveryTracker` (from `@toon-protocol/core`) was constructed on `start()` but nothing ever called its `processEvent()`, so `resolveTerminatorEndpoint` always saw zero discovered peers and failed closed. `start()` now opens a live relay subscription for kind:10032 announces — on `config.relayUrl` and every `knownPeers[].relayUrl`, deduped, empties skipped — and feeds each one into the tracker; `stop()` tears it down. A client configured with no relay at all still starts, with no subscription opened.

`toon-clientd` now threads its own resolved relay into `toonClientConfig.relayUrl` (previously pinned to `''`) so its embedded clients — the default one and every per-apex one — have a relay to feed that subscription from. Free reads keep routing through the daemon's own `RelaySubscription`, unchanged.
