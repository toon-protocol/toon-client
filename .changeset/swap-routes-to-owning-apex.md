---
'@toon-protocol/client': patch
'@toon-protocol/client-mcp': patch
---

Route a swap to the apex that OWNS its destination — every swap against a registered non-default apex failed locally with `No negotiation metadata for peer "g.toon.swap.maker"`.

The daemon runs one `ToonClient` per apex, and a `toon_add_apex` target's settlement facts are injected into THAT client alone, under the peer id `resolvePeerId` returns for its destination (`g.toon.swap.maker` → `maker`). `swap()` selected its client by `btpUrl` only, so a request that did not restate the maker's BTP URL streamed on the config-seeded apex instead — a client that has never negotiated with the maker. `resolvePeerId` then throws `PEER_NOT_FOUND`, `peerIdForClaim` falls back to the raw destination as the claim key, nothing is ever registered under a full ILP address, and every packet dies before it is sent. Reproduced live on devnet 2026-08-16 against `g.toon.swap.maker` at `wss://proxy.relay.devnet.toonprotocol.dev/swap/ilp/btp`.

An explicit `btpUrl` still wins and is still the only selector on the wire (#579). With none, the swap now goes to the registered apex whose own ILP address is `destination` or its longest prefix, so the destination and the peer id its negotiation is registered under agree and the lookup hits on identity instead of riding the raw-destination fallback. When no registered apex claims the destination the default apex is used exactly as before.

`PEER_NOT_NEGOTIATED` also stops being a dead end when that fallback IS in play: the error now says the peer id is really the destination, that no negotiation is ever registered under a full ILP address, and which peers this client did negotiate.
