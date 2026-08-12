---
'@toon-protocol/client': patch
---

Take up `@toon-protocol/core@3.3.0`'s reseeded genesis peers (and
`@toon-protocol/sdk@^3.1.7` alongside it) so a client bootstraps against both
surviving devnet nodes — the relay (`g.toon.relay`) and the store
(`g.toon.ario`) — rather than the single retired-apex entry (issue #536,
toon-meta#310).

`@toon-protocol/client` itself only takes up the new seed; consumers that read
`GenesisPeerLoader` now see two entries instead of one, with the store's own
`ilpAddress` and `btpEndpoint` available for a store-bound connection.

The daemon-side routing work that consumes the second entry — deriving
`storeBtpUrl` from the store peer's own `btpEndpoint` and auto-registering a
second uplink so blob/git uploads and the store route-price lookup reach the
store's own connector — lands in `@toon-protocol/client-mcp`, which is no
longer npm-published (retired in #549); it ships in the desktop bundle and
carries no changeset of its own. `@toon-protocol/rig` is bumped to the same
core range for the same reason (private, workspace-only).
