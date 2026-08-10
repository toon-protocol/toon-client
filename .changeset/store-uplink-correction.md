---
'@toon-protocol/client-mcp': patch
---

Actually open a second uplink to the store connector, instead of just
renaming a destination string on the relay's uplink (issue #536 correction).

The `two-node-genesis-seed` changeset (#538) fixed `storeDestination` to
read the store's own genesis address (`g.toon.ario`) but kept routing every
write — publish AND upload — through the single default apex's client,
which only ever connects to the relay's connector. Confirmed live: the
relay's uplink answers `no route this connector serves matches
'g.toon.ario'` for that destination, so every store upload still 404'd —
the destination string changed, but nothing gave the client an actual route
to it.

`resolveConfig` now also derives a `storeBtpUrl` from the genesis STORE
peer's own `btpEndpoint` (env override `TOON_CLIENT_STORE_BTP_URL`), and
`ClientRunner` auto-registers a SECOND config-seeded apex from it — built
the same way a `toon_add_apex`-discovered apex is, so its settlement
negotiation is read live off the store's own `kind:10032` announcement and
its packets reach the store's own connector (confirmed live: the derived
apex gets its OWN 402 challenge with the store's own settlement address and
its own flat price, distinct from the relay's). Blob uploads
(`toon_upload`), git object uploads, and the store route-price lookup now
go through this store apex by default; publishes and kind:1-equivalent
writes stay on the relay apex, unchanged. An explicit `btpUrl` on a request
still pins both legs to one named apex (back-compat with the existing
manual multi-apex flow), and a config with no `storeBtpUrl` (custom/legacy
single-connector topologies, and every existing test) falls back to the old
single-apex behavior exactly.

Verified live against the real devnet fleet with a fresh (no explicit
`destination`) config: both apexes bootstrap and report `ready` from
`GET /targets`, each negotiated independently off its own connector's
`kind:10032` announcement, and `POST /git/estimate` prices a real local
repo's upload through the store apex's own live price (1000 — the store's
direct rate, not the apex-forwarding markup of 1002 seen when routed
through the shared proxy). A fully-paid store upload was not reachable in
this pass: the devnet faucet's ETH drip is now structurally disabled
(`"reason": "ETH drip disabled (amount 0)"`, confirmed live), so a
freshly-funded wallet has no gas to open its first on-chain channel — the
attempt fails with a clear `insufficient_gas` error at the channel-open
step, not a routing error. That is an environment/faucet limitation outside
this fix, not a defect in the routing this change makes.
