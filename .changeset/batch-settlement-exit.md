---
'@toon-protocol/client': minor
---

A client can leave its x402 `batch-settlement` channels and take the unspent deposit back (connector ADR 0074, #691).

`client.batchSettlement` is present on a client created with `batchSettlement`. It has four methods:

- **`channels()`** lists every such channel held with the node.
- **`open()`** onboards now instead of on the first paid `send()`.
- **`close()`** starts leaving the live channel: `initiateWithdraw` of everything unclaimed on Base, or `request_close` on Solana.
- **`settle()`** takes back the unspent deposit of every channel whose window has passed: `finalizeWithdraw` on Base, or `seal` plus `withdraw_payer` on Solana.

Closing and settling are the payer's own transactions and cost native gas. Once a channel is closing, the next paid `send()` onboards a fresh one.

The payer honours `autoOpenChannel`. With it off, a packet that needs an open, a top-up or a replacement throws `ChannelNotOpenError`, and `open()` is how the channel gets made.

The CLI gains two global settings:

- `--batch-settlement` (`TOON_BATCH_SETTLEMENT=1`) switches to this scheme. Under it, `toon channel open|status|close|settle` act on the batch-settlement channel.
- `--facilitator URL` (`TOON_FACILITATOR`) names the facilitator.

The exit builders are exported too.
