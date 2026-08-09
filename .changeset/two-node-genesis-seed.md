---
'@toon-protocol/client': patch
'@toon-protocol/client-mcp': patch
---

Take up `@toon-protocol/core@3.3.0`'s reseeded genesis peers so a fresh
install bootstraps against both surviving devnet nodes and regains store
access (issue #536, toon-meta#310).

The devnet apex is retired: the relay (`g.toon.relay`) and store
(`g.toon.ario`) are now two independent connectors with no forwarding
between them (verified live — each returns `no route` for the other's
address). `@toon-protocol/core@3.3.0`'s genesis seed carries both as
separate entries; `@toon-protocol/sdk` is bumped to `^3.1.7` alongside it
(a dependency of core's release).

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
