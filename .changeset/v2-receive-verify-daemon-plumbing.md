---
'@toon-protocol/client-mcp': minor
---

Wire the v2 EIP-712 receive-side EVM claim verification into the daemon swap ingest path.

The daemon's swap ingest now threads `toonClientConfig.tokenNetworks` (chain key → `RollingSwapChannel` / `verifyingContract`) into `ingestAndReveal`/`ingestReceivedClaims`, so received EVM claims are verified against the client's v2 domain-separated balance-proof digest (`chainId` + `verifyingContract`). Without a `tokenNetworks` entry for the target chain an EVM claim is rejected `MISSING_CHAIN_CONFIG`, fail-closed.

The settlement-build path (`settleSwapClaims` → `buildSwapSettlements`) now passes `verifySignatures: false` to the sdk's `buildSettlementTx`: the stored watermark was already verified against the v2 digest at receipt time, and the sdk's settle-time re-verify is v1-only and would reject a valid v2 signature. The sdk is used only to build the settlement calldata; the receive-side verify is authoritative.

Follow-up: adopt a published v2 `@toon-protocol/sdk` in the settlement-build/submit path (thread `chainId`/`verifyingContract` through `buildSettlementTx`) to restore settle-time defense-in-depth re-verification.
