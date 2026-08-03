---
'@toon-protocol/client': minor
---

Add `ToonClient.sendTransfer()` (issue #491): a plain, non-custodial send of the
settlement token or native gas from the caller's own key to an arbitrary
address, on evm/solana/mina. `@toon-protocol/client` was built around payment
channels, not transfers — this is the missing primitive underneath
provisioning a buzz agent (toon-protocol/buzz#74): the owner's treasury has to
fund a freshly-derived agent address with USDC and native gas before that
address can open a channel.

Every send is confirmed by an OBSERVED balance delta at the destination, never
by the send call/transaction merely landing — the devnet faucet's Solana leg
has been seen returning success with a real transaction signature while
delivering 0 lamports (toon-protocol/connector#691); a send that trusted its
own receipt would report a funded agent that in fact holds nothing.

New typed errors distinguish preflight failures from delivery failures:
`InsufficientBalanceError`, `UnknownChainError`, `InvalidAddressError` (all
checked before anything is submitted), `TransferNotDeliveredError` (accepted
on-chain/by-node but the destination balance never moved), and
`TransferUnsupportedError` (a chain/asset combination not implemented yet —
currently the Mina settlement token; native MINA is unaffected).

The standalone `sendTransfer()` function and its config/result types are also
exported from the package root for callers that want to build a
`TransferConfig` outside a `ToonClient`.
