---
'@toon-protocol/client': minor
---

This adds the chain half of paying a connector from an x402 `batch-settlement` channel on Base and Solana (connector ADR 0074, #679). None of it is wired into `ToonClient` yet.

- **EVM, on the deployed `x402BatchSettlement`:**
  - `buildBatchChannelConfig` and `batchChannelId`, the channel config and its id;
  - `signBatchVoucher` and `batchVoucherDigest`, for vouchers;
  - `buildEip3009Deposit` and `buildPermit2Deposit`, the deposit authorizations;
  - `settleDeposit`, which hands a deposit to an x402 facilitator's `/settle`. The facilitator pays the gas. A refusal is thrown as the new `FacilitatorError`, which carries the facilitator's own `errorReason`.
- **Solana, on payment-channels (`CHNLx…`):**
  - the channel PDA;
  - `open` and `top_up` instructions;
  - `buildSponsoredOpen`, which compiles `[open, memo]` with the connector as fee payer and signs the payer's slot. It refuses any sponsor other than the receiving connector's, because a third-party sponsor sits in the `payee` seat and can seal the channel.
  - the 50-byte voucher, with `expiresAt` always 0;
  - `decodeSvmBatchChannel`, which reads the channel account.

The EVM half is checked against the published `@x402/evm` client, and its ERC-3009 deposit matches that client byte for byte. The Solana half is checked against fixtures from the payment-channels program's own generated client.

The wire half is not built, because the connector's vectors at `schema_version` 6 fix it and have not landed. That covers the voucher's claim JSON, choosing this channel from the greeting, and the channel store.
