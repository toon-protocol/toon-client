---
'@toon-protocol/client-mcp': minor
---

Wire full v2 EIP-712 EVM claim verification into the daemon swap ingest AND settlement-build paths. Bumps `@toon-protocol/sdk` + `@toon-protocol/core` to `^3.0.0` (the published v2 EIP-712 packages).

The daemon's swap ingest now threads `toonClientConfig.tokenNetworks` (chain key → `RollingSwapChannel` / `verifyingContract`) into `ingestAndReveal`/`ingestReceivedClaims`, so received EVM claims are verified against the v2 domain-separated balance-proof digest (`chainId` + `verifyingContract`). Without a `tokenNetworks` entry for the target chain an EVM claim is rejected `MISSING_CHAIN_CONFIG`, fail-closed.

The settlement-build path (`settleSwapClaims` → `buildSwapSettlements`) now runs on the published v2 sdk and passes `verifySignatures: true` to `buildSettlementTx`: `buildSwapSettlements` threads `chainId` + `verifyingContract` (from `tokenNetworks`) into the sdk signer config, so the sdk verifies the stored watermark against the SAME v2 EIP-712 digest used at receipt time. Settle-time defense-in-depth re-verification over the store file is restored — a valid v2-signed claim now round-trips end to end.
