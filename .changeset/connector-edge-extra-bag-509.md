---
"@toon-protocol/client": minor
---

Surface the x402 `accepts[0].extra` bag — starting with `session_lease_ttl_ms` (connector#722) — on `ConnectorRouteTerms` too, matching the posture #506/#507 established for `Http402Client`. `ConnectorEdgeClient.getRouteTerms`/`parseConnectorRouteTerms` is the parser ordinary channel bootstrap (`publishEvent`/`openChannel`/`adoptChannel`) actually negotiates through, so `session_lease_ttl_ms` is now readable via `ToonClient.getLastConnectorRouteTerms()` without a caller having to issue a separate `h402Fetch` probe purely to populate a cache. `extra` is an open bag: unknown keys survive, and it is `undefined` — not a default — when the peer sends none. Existing `settlement`/`settlements` extraction (connector#632) is unchanged.
