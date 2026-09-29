---
status: accepted
---

# x402 `batch-settlement` is the only payment path, with no opt-in

Connector ADR 0075 retired the `toon-channel` scheme: a connector now accepts only x402
`batch-settlement` vouchers and refuses anything else by name. This client follows that decision
rather than keeping `toon-channel` behind a flag (#692). The `TokenNetwork` and TOON-program channel
clients, balance-proof signing, nonces and `settlementTimeout` are deleted, not deprecated. The old
opt-in `batchSettlement` option is gone too, because there is nothing left to opt out to. This
shipped as a major version.

The wire decision is the connector's. What this record keeps are the client-side choices that
follow from it, and that a reader could otherwise "fix".

## Consequences

- **`client.channel` and `toon channel` keep their names and are remapped onto x402 channels.**
  This avoids a second, parallel surface. `close()` and `settle()` return one result per channel
  and walk every channel held with the node, archived ones included, because a replaced channel
  still holds a deposit.
- **A facilitator is defaulted only on Base Sepolia.** A deposit of real money relayed through a
  third party the caller never named is not this package's decision. On any other EVM network,
  `facilitatorUrl` is required.
- **A Solana channel is replaced, not topped up.** The connector sponsors opens and nothing else,
  so a top-up would need SOL. That would defeat the point of gasless onboarding.
- **The channel config is persisted before anything is sent.** The chain never returns an x402
  channel's config, and a Solana PDA cannot be re-derived without its salt and slot. A channel that
  was not recorded first is a deposit that cannot be left.
- **The watermark is rebuilt from `claim-state` rather than trusted blindly.** A lost watermark is
  floored at what the chain shows landed and then replaced by the connector's own figure. A refusal
  that names no figure makes the client ask before the next voucher. It never adopts more than it
  signed, except when its own record is gone.
