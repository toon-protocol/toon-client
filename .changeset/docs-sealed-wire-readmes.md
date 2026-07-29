---
'@toon-protocol/client': patch
'@toon-protocol/client-mcp': patch
'@toon-protocol/rig': patch
---

Documentation only: bring the READMEs in line with the sealed wire (#447–#452).

- `packages/client/README.md` gains **How a paid write works (the sealed wire)** —
  ask the terminating connector for its identity (`GET /ilp/identity`), ask the route
  for its price (`GET /ilp/routes/price`), seal an OER envelope carrying a shared
  secret, mint the condition as `deriveCondition(deriveFulfillment(secret))`, send,
  and open the answer with the same secret. Records that a reject raised short of the
  termination is necessarily plaintext and therefore distinguishable from one the
  destination sealed, and lists what went away with the plaintext path.
- `docs/api-reference.md`: `publishEvent`'s documented result was still the
  pre-sealed-wire shape (a `fulfillment` field that no longer exists, no `response` /
  `refusedBy` / `code`, no `ilpAmount` / `proxyPath` options). Adds `getRoutePrice`.
- Both note that the HTTP client edge is now required even when packets travel over
  BTP, since identity and price are read over HTTP — the same note lands in
  `packages/client-mcp/README.md`, whose config example only ever showed `btpUrl`.
- `packages/rig/README.md`: what a write costs is now flat per route (from the
  kind:10032 announce's `capabilities`), not per byte; `rig clone` is documented as
  the free, identity-less read it is, including that it leaves `toon.owner`,
  `toon.repoid` and the relay as `origin` preconfigured; the relay is read from the
  git remote URL (`git remote set-url origin ws://…`); and `TOON_GENESIS_PEERS` is
  documented as load-bearing when pointing rig at anything other than the devnet.
- `src/wire/vectors/README.md`: sharpens when `vectors:refresh` is the right move and
  what the drift job actually covers.
