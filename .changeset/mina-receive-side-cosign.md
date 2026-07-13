---
'@toon-protocol/client': minor
'@toon-protocol/client-mcp': minor
---

Mina receive-side swap settlement: co-signed `claimFromChannel` (#357)

Redeem swapped-in `mina:*` claims on-chain, replacing the `SUBMISSION_UNSUPPORTED`
fail-closed that #352 shipped. `POST /swap/settle` / `toon_swap_settle` now route
Mina bundles through a receive-side co-sign path instead of refusing them.

- `buildMinaCoSignedClaim` (client) assembles a dual-party `claimFromChannel`
  claim from a verified Mina bundle: reads the on-chain channel state via plain
  GraphQL (no o1js), resolves the participant A/B ordering against the stored
  `channelHash`, conserves balances against `depositTotal`, and produces the
  recipient's Pallas-Schnorr co-signature over `[commitment, nonce, channelHash]`
  with `mina-signer`.
- `submitMinaSettlement` drives the o1js `claimFromChannel` proof + broadcast
  through an injectable submitter (default: a lazy o1js + `@toon-protocol/mina-zkapp`
  settler, so the non-Mina path never loads the WASM circuit runtime).
- Wired into `ToonClient.settleSwapBundle` and the daemon `settleSwapClaims` seam.

The on-chain claim is dual-party, so it still needs the maker's
payment-channel-commitment-form co-signature (the swap-wire claim only carries the
maker's `balanceProofFieldsMina` signature — a different message). Absent one,
settlement fails closed with `MINA_MAKER_COSIGN_REQUIRED` after assembling the
recipient's half. Operators can inject the maker `{ r, s }` via
`swapMinaMakerSignatures` until it flows over the swap wire.

Part of toon-protocol/toon-meta#145.
