---
'@toon-protocol/client': patch
---

Re-pin the devnet Solana mock-USDC mint in the client test fixtures.

`xyc5J8MgKFiEN13PnfftdXxUzYH34FEvw1LCrFwN7in` is retired — it is still on chain
with its supply, but its mint authority is lost, so nobody can mint it. The live
devnet settlement token is `34eSxY7qxQ4GzyhDJ8GpUcTz1WWzruGbJbR8q6TtxfQU`
(connector#1212), which `packages/client/src/presets.ts` already carries; only the
fixtures still described the dead world. Fixtures only — no shipped behaviour changes.
