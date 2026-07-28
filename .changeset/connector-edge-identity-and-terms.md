---
'@toon-protocol/client': minor
---

Ask the terminating connector for its identity and its terms (toon-client#447).

Adds `ConnectorEdgeClient` — `GET /ilp/identity` (the uncompressed secp256k1 key
a packet's payload must be sealed to, per ADR 0018) and
`GET /ilp/routes/price?destination=` (client-edge-spec §1.7), with per-endpoint
identity caching and a distinguishable refusal for every malformed answer. A
`404` from the price endpoint answers `null` (no locally-terminated route)
rather than throwing, so it is never confused with a transport failure.

Also fixes `parseX402Body` against the terms the shipped connector actually
emits: the ILP address, endpoint and price live under `extra`, and
`httpEndpoint` is relative (`"/ilp"`) and is now resolved against the URL that
answered `402`. Both are additive — no existing export changes signature.
