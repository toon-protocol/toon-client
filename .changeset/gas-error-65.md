---
"@toon-protocol/client": patch
"@toon-protocol/client-mcp": patch
---

Surface an actionable error when the one-time on-chain payment-channel OPEN reverts because the local settlement wallet has no native gas. The client now throws a tagged `ChannelFundingError` (remapped at the origin in `OnChainChannelClient.openEvmChannel`, covering both publish and upload paths) instead of leaking the raw viem "…exceeds the balance of the account" string; the daemon maps it to HTTP 402 `insufficient_gas` (retryable), and the MCP tools surface the "fund the wallet and retry" remedy verbatim instead of a misleading "still bootstrapping" hint. Per-write settlement is unaffected (it rides ILP-over-HTTP and never spends gas) — this only improves the message on the one-time channel-open funding step (toon-meta#65).
