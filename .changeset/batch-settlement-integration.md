---
'@toon-protocol/client': patch
---

x402 `batch-settlement` now has two opt-in integration suites.

- **`batch-settlement-exit`** runs against x402's real contract on `anvil` and the real `payment-channels` program on `solana-test-validator`. On each chain it opens a channel, closes it, and gets the whole deposit back. The Solana channel is opened with this client's sponsored open.
- **`batch-settlement-devnet`** deposits through the devnet's x402 facilitator from a wallet that holds no ETH.
