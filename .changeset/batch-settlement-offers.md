---
'@toon-protocol/client': minor
---

This client now reads a connector's x402 `batch-settlement` offers (connector ADR 0074 decision 8, #687).

- **`NodeSelfDescription.batchSettlements`**: the terms `GET /ilp` publishes, one per chain the node has opted in to. It is an empty array for every node that has not.
- **`ParsedX402Challenge.batchSettlements`**: every well-formed `batch-settlement` entry in the greeting's `accepts[]`, beside the `toon-channel` entry, which parses exactly as before.
- **`chooseBatchSettlement`**: picks the node's terms on the chain the client pays from.
- **`offerFromTerms`**: prices those terms into the x402 offer a deposit or sponsored open is built from.

Choosing this scheme is always opt-in. An x402 channel is one-way, so a client that expects a payout stays on `toon-channel`.

The Solana offer also carries the connector's `sponsorEndpoint` and `minDeposit`.
