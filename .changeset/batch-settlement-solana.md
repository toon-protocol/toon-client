---
'@toon-protocol/client': minor
---

`ToonClient` can pay from an x402 `batch-settlement` channel on Solana, onboarding with no SOL (connector ADR 0074, #690).

With `batchSettlement` set, and a node whose `GET /ilp` offers `batch-settlement` on Solana:

1. **Checks.** The client confirms that the offer's `tokenProgram` is the mint's on-chain owner, and that the payer's token account exists and holds the deposit.
2. **Open.** It builds the payment-channels `open` with the node's own sponsor key as fee payer, `rent_payer` and `payee`, signs only the payer's slot, and posts it to the node's `sponsorEndpoint`. The node co-signs it, submits it, and pays the fee and the rent.
3. **Pay.** Vouchers are signed with the payer's key, the channel's `authorized_signer`.

Other behaviour:

- **Refusals.** The node's refusals arrive as the new `SponsorRefusedError`, carrying its own reason.
- **Deposit size.** The deposit is at least the node's `minDeposit`.
- **Top-up.** The node sponsors opens and nothing else, so a top-up would cost SOL. An exhausted channel is therefore replaced by a fresh sponsored one, and the old binding is archived.
- **Removed.** `acceptSponsorSignature` is gone. The sponsor endpoint submits the transaction itself and never hands back the co-signed bytes.
