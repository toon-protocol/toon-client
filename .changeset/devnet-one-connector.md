---
'@toon-protocol/client': minor
---

The devnet is one connector now, at `https://toonprotocol.dev`. `DEVNET.store`, `DEVNET.gas`, `DEVNET.relay` and `DEVNET.ephemeral` all point at it (they pointed at `proxy.ario`, `proxy.gas` and `proxy.relay.devnet.toonprotocol.dev`), and the new `DEVNET.connector` names it directly; the CLI falls back to it when no connector is given. One channel with it pays every devnet route, and `g.toon.relay.store` / `g.toon.relay.gas` are no longer forwarded, so they need no `sealTo` and cost the same as `g.toon.store` / `g.toon.gas`. The relay's Nostr websocket is `wss://relay.toonprotocol.dev`. The docs name `g.toon.store` explicitly in the paid examples, because the connector lists `g.toon.relay` first and that is where a send with no destination goes.
