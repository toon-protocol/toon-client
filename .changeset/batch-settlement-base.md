---
'@toon-protocol/client': minor
---

`ToonClient` can pay from an x402 `batch-settlement` channel on Base, onboarding with no ETH (connector ADR 0074, #689).

Opt in with `batchSettlement: { facilitatorUrl, deposit?, depositMethod? }`. When the node's `GET /ilp` offers `batch-settlement` on the client's chain:

1. The first paid `send()` deposits through the x402 facilitator, which pays the gas. That deposit creates the channel.
2. Every paid packet then carries a voucher instead of a `toon-channel` claim.
3. When the deposit cannot cover the next voucher, the client tops the channel up the same way.

A node that offers no such channel is paid over `toon-channel` exactly as before.

How a voucher's fate moves the watermark:

- A voucher lost to a transport error stays counted. It may have been banked, and the next voucher exceeds it either way.
- A refusal gives the charge back, unless it says the connector already holds the amount.

`ClaimSummary` gains `scheme: 'batch-settlement'` for such a packet. `BatchSettlementPayer` is the same machinery, exported for use without a client.
