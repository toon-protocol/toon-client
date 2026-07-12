---
'@toon-protocol/client-mcp': minor
'@toon-protocol/views': patch
'@toon-protocol/client': patch
---

Migrate to `@toon-protocol/sdk` ^2.0.0 — the `mill`→`swap` vocabulary rename
(`millSignerAddress`→`swapSignerAddress`, `millPubkey`→`swapPubkey`,
`millIlpAddress`→`swapIlpAddress`; toon commit `af4cd24`). Rolling-swap
prerequisite (toon-protocol/toon-meta#145).

- `ClientRunner.swap` now calls `streamSwap` with the renamed params and reads
  `swapSignerAddress` directly off accumulated claims (the old
  mill→swap translation shim is gone).
- **Deploy ordering:** the rename has NO wire back-compat. A pre-rename
  (sdk <2.0.0) swap peer emits `millSignerAddress` in its FULFILL settlement
  metadata, which sdk ≥2's `decodeFulfillMetadata` silently drops — the swap
  "succeeds" but its claims fail later in `buildSettlementTx` with
  `MISSING_SETTLEMENT_METADATA`. Upgrade swap peers (mills) together with
  this client (see toon-protocol/swap#45).
- New early alarm: `SwapResponse.warning` is set at swap time when accepted
  claims are missing `swapSignerAddress`, instead of failing silently until
  settlement.
