---
'@toon-protocol/client': minor
'@toon-protocol/client-mcp': minor
---

Rolling swap: receive-side claim ingestion, verification, and settlement (#352, part of toon-meta#145).

The client now VERIFIES every chain-B claim a swap returns instead of accepting it blind: signature against the maker's advertised/pinned `swapSignerAddress` (sdk 2.x `verifyAccumulatedClaim`), chain/recipient consistency, and nonce/cumulative monotonicity against a durably persisted per-`(chain, channelId)` watermark (`received-claims.json`, beside the channel store — survives daemon restarts). A claim that fails verification is never counted as value received: it is rejected loudly and result-shaped (per-claim `verificationError`, `SwapResponse.warning`, `accepted: false` when nothing verified). Legacy no-metadata swaps keep the existing #349 warning path unchanged.

New settlement drive: `GET /swap/claims` lists persisted watermarks; `POST /swap/settle` (MCP: `toon_swap_claims` / `toon_swap_settle`) builds ONE on-chain close per channel from the final watermark via sdk `buildSettlementTx` (claims re-verified at settle time) and submits it on EVM when `chainRpcUrls[chain]` is configured — the env-gated seam; Solana/Mina return the built tx unsubmitted (Mina receive-side co-sign is an explicit follow-up). `@toon-protocol/client` exports the pipeline (`ingestReceivedClaims`, `buildSwapSettlements`, `submitEvmSettlement`, `JsonFileReceivedClaimStore`) and `ToonClient.settleSwapBundle`. sdk/core bumped to ^2.1.0; ILP transports accept core 2.1's ISO-string `expiresAt`.
