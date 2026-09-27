---
'@toon-protocol/client': minor
---

This adds a channel store for x402 `batch-settlement` channels (connector ADR 0074, #688).

- **`BatchChannelManager`** keeps each channel's full config, deposit and cumulative voucher amount in the existing `ChannelStore`, under its own `batch|…` binding keys.
  - Nothing is derived from the config: a voucher names its channel, and on EVM the contract never gives the config back.
  - A newer channel to the same connector archives the older binding instead of overwriting it.
  - The amount is persisted before a voucher is signed.
  - A voucher whose fate is unknown stays counted. Only a definite refusal gives its charge back.
- **`ChannelBinding.batchSettlement`** carries that config.
- **Chain readers:**
  - `readEvmBatchChannel` returns `channels(id)` and `pendingWithdrawals(id)`;
  - `getSvmBatchChannel` returns the channel account.

  What they show as landed is a floor under the connector's watermark, which `recoverFromChain` adopts.

The connector's `claim-state` does not yet answer for a voucher channel, so a lost store can only be recovered to that floor (toon-protocol/connector#1364).
