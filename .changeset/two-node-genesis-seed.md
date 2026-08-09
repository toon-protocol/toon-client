---
'@toon-protocol/client': patch
'@toon-protocol/client-mcp': patch
---

Take up `@toon-protocol/core@3.3.0`'s reseeded genesis peers so a fresh
install bootstraps against both surviving devnet nodes and regains store
access (issue #536, toon-meta#310).

The devnet is moving to two nodes: the relay (`g.toon.relay`) and the store
(`g.toon.ario`) are separate connectors, and `@toon-protocol/core@3.3.0`'s
genesis seed carries both as separate entries. `@toon-protocol/sdk` is
bumped to `^3.1.7` alongside it (a dependency of core's release).

**The apex is still running**, and still prices both routes — verified live
2026-08-09: `GET /ilp/routes/price` against
`https://proxy.devnet.toonprotocol.dev` returns `g.toon.relay` at 1 and
`g.toon.ario` at 1002, the second being the forwarding markup over the
store's own price. Retiring it is toon-meta#313, which has not happened.
What IS true today is that the two leaf connectors do not forward for each
other yet: the relay's uplink returns `no route this connector serves
matches 'g.toon.ario'`. Under the two-node target they will carry for each
other for a fee (toon-meta#310), and until that peering exists a client
whose only uplink is the relay cannot reach the store.

`client-mcp`'s `resolveConfig` used to take only the seed's first entry and
derive BOTH the publish and store destinations from it via the retired
apex's `<base>.relay.store` anchor-splitting convention. Against the new
seed that produced `storeDestination: 'g.toon.relay'` — the relay's own
address, which the store's connector does not terminate (confirmed live:
`GET /ilp/routes/price?destination=g.toon.relay` 404s against the store
box). Store uploads would 404 even once a client actually held a channel
with the store, silently defeating the reseed. Fixed: an EXPLICIT
`destination` (custom/legacy proxy topologies) still goes through the
anchor-splitting convention unchanged; the default (fresh-install) path now
reads the store's own genesis entry (`ilpAddress` ending in `.ario`)
directly instead of deriving it from the relay's address.

Rebuilt `client-mcp`'s bundle (tsup `noExternal` inlines `core`/`sdk`/the
workspace `rig` at build time, so a `devDependency` bump alone never reaches
the shipped artifact — the same gap as the 0.36.5/#527 incident) and
confirmed both genesis pubkeys (`30fdd01d…` relay, `499cdd71c7…` store) are
now present in `dist/`.

`@toon-protocol/rig` is bumped to the same core range (it bundles into
`client-mcp` too) but ships no changeset of its own — private, workspace-only,
matching prior core bumps (#523, #528).
