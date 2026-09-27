---
'@toon-protocol/client': minor
---

This adds the voucher as it rides the wire (connector ADR 0074 decision 4, #686). None of it is wired into `ToonClient` yet.

- **`evmVoucherClaim` and `solanaVoucherClaim`** build a client-edge claim under `scheme: "batch-settlement"`. It rides exactly where a `toon-channel` claim rides, and the two carriages serialize it unchanged. Built from the vectors' fields, each reproduces the connector's `claim_voucher` JSON byte for byte. The EVM claim carries its `channelConfig` on every voucher, because the connector needs it on the first voucher it sees for a channel.
- **`nextVoucherAmount`** picks the next cumulative amount: exactly what has been signed so far plus the charge. On a free route it returns nothing, because a voucher that does not advance the watermark is refused. It is replayed against the vectors' `amount_only_watermark` cases.
