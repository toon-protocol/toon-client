---
'@toon-protocol/client': patch
---

Paying from x402 `batch-settlement` channels now survives lost answers, refusals and concurrency.

- **Refusals read the node's watermark.** An underpayment refusal names how far the voucher advanced it, so the next voucher is priced from the node's own figure. Before, the same voucher was signed again and refused forever.
- **"Goes backwards"** moves the count up to everything ever signed.
- **A definite refusal no longer undercounts.** It gives its charge back only if no later voucher already superseded it. Before, two concurrent sends could drop the count below what the node held.
- **Deposits are recorded before they leave.** A facilitator deposit or sponsored open is written down as pending first. If the answer is lost, the next use reads the chain: it keeps a channel that landed and forgets one that did not. Before, a deposit that landed behind a timeout was stranded under a channel id nobody could recompute.
- **One channel per first send.** Concurrent first sends now open a single channel.
- **`open()` reuses** the channel already open.
- **Top-ups.**
  - `client.batchSettlement.deposit(amount)` and `toon channel deposit --batch-settlement` top up a Base channel by hand.
  - A lost watermark is rebuilt from what the chain shows landed.
- **Exit covers every channel.** `close()` covers every open channel with the node, including archived ones. `settle()` settles each channel independently, treats a channel the chain already cleaned up as settled, and takes back a Solana channel the node sealed first.
  - Both now return one result per channel. The CLI exits non-zero when any channel fails.
- **`SponsorRefusedError`** carries the endpoint's HTTP `status`.
- **`VoucherOutcome`** carries the reject's own text. `readVoucherRefusal` replaces `voucherRefusalIsNotAdvancing`.
