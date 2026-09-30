---
'@toon-protocol/client': minor
---

Adopt connector wire vectors schema 8: an EVM voucher's cumulative amount is a `uint128`, so `signBatchVoucher` now accepts any amount up to 2^128-1 and signs, serialises and compares it exactly. A Solana voucher is still capped at `u64`.
