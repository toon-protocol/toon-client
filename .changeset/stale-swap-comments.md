---
---

Comment-only — no published behaviour changes, so this changeset is deliberately
empty rather than bumping `@toon-protocol/client` for two comments.

Two comments still described code that toon-client#619 deleted along with
`packages/client-mcp` and `toon-plugin`: `mapIlpResponse`'s JSDoc credited
`streamSwap`'s packet counters for counting a forged FULFILL failed, and
`ci.yml`'s `solana-settlement-proof` job carried a "what this does not cover"
note pointing at `ClientRunner.settleSwapClaims` and toon-client#608. Neither
symbol exists in this repository any more.
