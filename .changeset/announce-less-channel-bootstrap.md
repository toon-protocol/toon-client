---
'@toon-protocol/client': minor
'@toon-protocol/rig': minor
---

Rig defaults to the official Rust edge, and the client can bootstrap a
payment channel with no announce at all.

**Client — announce-less channel bootstrap (connector #617).** When a paid
write reaches a destination no announce or registration ever negotiated,
the client now asks the route itself: `ConnectorEdgeClient.getRouteTerms`
sends a claimless PREPARE and reads the x402 greeting, and a settling
connector's greeting carries the channel-opening facts (chain, counterparty
settlement address, TokenNetworkRegistry, resolved TokenNetwork, token,
decimals). `ToonClient` synthesizes the `PeerNegotiation` from those facts
and opens the channel exactly as an announced peer's would have been. A
greeting without settlement facts keeps the precise `PEER_NOT_NEGOTIATED`
error — now thrown as itself rather than wrapped in `PUBLISH_ERROR`.

**Rig — the official edge is the default uplink (connector #616).** With no
explicit entry (`rig entry <url>` / `rig entry sandbox` / `TOON_CLIENT_*`
env), paid writes now go to the official TOON relay implementation — the
Rust connector at `https://proxy.devnet.toonprotocol.dev/rust/ilp`, route
`g.toon.relay`. A live announce no longer places the uplink (it still
informs the destination anchor, routes, prices and bootstrap peers), and a
price floor from one fleet's announce no longer binds a write that targets
another fleet's edge.
