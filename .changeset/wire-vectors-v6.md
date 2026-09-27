---
'@toon-protocol/client': patch
---

The vendored wire vectors move to `schema_version` 6, and both new sections are replayed.

- **`claim_voucher`** is the x402 `batch-settlement` voucher from connector ADR 0074. The EVM channel id, digest and signature are reproduced byte for byte, and the Solana 50-byte message is rebuilt and its signature verified.
- **`charge`** is the metered route price. Replaying it exposed a bug: `chargeFor` did not saturate at `u64::MAX` as the connector does, so a route priced near the top of the range quoted an amount no claim can carry. It now saturates.
