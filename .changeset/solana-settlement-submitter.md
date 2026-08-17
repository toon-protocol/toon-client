---
'@toon-protocol/client': minor
---

Receive-side Solana settlement actually settles (toon-client#604).

Two things blocked it, neither of them the encoding defect fixed upstream in
toon#214 (the SDK's Solana bundle could not execute at all). Both are now closed,
and the result is proven against a real validator rather than asserted.

**1. The `programId` came from an EVM-only config map.** `buildSwapSettlements`
resolved the Solana settlement `programId` from `tokenNetworks[chain]` — the
leg-A `TokenNetwork` map, documented as EVM-only, and the same wrong-source
mistake toon-client#583 fixed for the EVM branch. No maker publishes a
`tokenNetworks["solana:*"]`, so Solana settlement was **unconfigurable**, and a
`TokenNetwork` address would have been the wrong contract if anyone had
configured one. The source is now `solanaProgramId` — threaded by the daemon from
`ToonClientConfig.solanaChannel.programId`, the payment-channel program that owns
the claim's channel PDA and the one this client opened the channel on — with an
entry's own pinned `verifyingContract` still winning, exactly as for EVM.
`tokenNetworks` is no longer read by the settlement builder on any chain; it stays
on the params interface, deprecated, so the guard tests that assert passing it
changes nothing keep compiling.

**2. There was no submitter.** Both submission seams refused the bundle outright
(`SUBMISSION_UNSUPPORTED` in the daemon, "EVM only today" in `ToonClient`). New
`swap/solana-settlement.ts` provides:

- `buildSolanaSettlementTransaction` — **pure**: patches a live blockhash into
  the SDK's compiled Message via the SDK's own `patchSolanaRecentBlockhash`,
  signs the *patched* bytes (signing the placeholder and swapping the blockhash in
  afterwards would sign bytes that are not the ones broadcast), and serializes
  `short_vec(1) || signature(64) || message`. The redemption needs exactly ONE
  signature — the recipient's, which is also the fee payer — so this client
  redeems unilaterally, with no maker co-sign and no proving step.
- `submitSolanaSettlement` — the two network calls plus a confirmation wait that
  **fails on a transaction that confirmed with an execution error**. A reverted
  redemption moved nothing, and reporting it as submitted would recreate the
  silent gap this closes.
- `decodeSolanaSettlementClaimAmounts` — reads `(nonce, transferredAmount)` back
  out of the program's own instruction data, so a test can state what a
  transaction claims to do without trusting the bundle's summary fields.

It deliberately does **not** re-derive the message: the account list, instruction
data, precompile offsets and signed 48-byte balance proof are all the SDK's,
verified against the deployed program. Rebuilding any of it here would recreate
the signer/verifier drift toon#214 fixed. `ToonClient.settleSwapBundle` gains a
Solana branch reading `solanaChannel.rpcUrl` (the node the channel PDA lives on)
with `chainRpcUrls` as fallback, and the daemon's Solana branch now shares the
Mina one, surfacing each chain's stable error code (`NO_RPC_CONFIGURED`,
`NO_SIGNER`, `RECIPIENT_MISMATCH`, …) instead of flattening every failure to
`SUBMISSION_FAILED`.

A `RECIPIENT_MISMATCH` guard fails **locally** when the configured Solana key is
not the claim recipient: on chain that same mismatch is a bare signature-
verification failure that names nothing.

**Dependency bump.** `@toon-protocol/core ^3.4.0 → ^3.5.0` and
`@toon-protocol/sdk ^3.1.8 → ^3.3.0` (client, client-mcp; core also in rig), with
the lockfile moved — it pinned `sdk 3.1.8`, so the range bump was load-bearing.
Until this bump the receive-side verify checked the legacy
`balanceProofHashSolana` digest that **no program verifies**, so a correctly
signed, redeemable Solana claim would have been rejected at receipt while an
unredeemable one was accepted — exactly backwards. This also closes the split
where CI's `build` job (`--frozen-lockfile`) and its `Devbox Environment
Validation` job (`--no-frozen-lockfile`) compiled against different SDKs with
different Solana digest semantics.

**Tests that asserted the old encoding are fixed, not deleted.** The Solana
fixture in `received-claims.test.ts` signed the legacy digest; it now signs
`balanceProofMessageSolana`. Left as it was, it asserted that the client accepts
an unredeemable claim. Two of its cases went red on the bump, which is what a
tripwire is for.

**Proof.** `packages/client/src/__integration__/solana-settlement-redeem.integration.test.ts`
boots a real `solana-test-validator` with the real native payment-channel program
(vendored from connector `e9bfadad`, 109,416 bytes, sha256-asserted at boot,
loaded at genesis at connector's own `LOCAL_TEST_PROGRAM_ID`) and a real 178-byte
`ChannelState` at its correctly-derived PDA, then runs the **client's** whole
pipeline — `ingestReceivedClaims` → `buildSwapSettlements` →
`submitSolanaSettlement` — and reads the channel account back off chain. Observed:
`nonce_a 0 → 1, transferred_amount_a 0 → 250000`, then a second claim to
`2 / 500000`. Plus the negatives that make the pass mean something: a replayed
nonce refused by the program with state untouched, a legacy-digest claim refused
by the receive-side verify and — forced past it with the signature spliced into
the precompile instruction — by the chain, and a non-recipient signer refused
before broadcast.

The suite SKIPS when `solana-test-validator` is not on PATH, and
`CLIENT_REQUIRE_SOLANA=1` turns absence into a hard failure so a CI job can never
report success having run nothing. **It is not wired into CI**, which has no
validator: the 11 unit tests in `swap/solana-settlement.test.ts` cover the submit
path's control flow and refusals there, and they are explicitly not a substitute —
bytes that look right are how toon#214 survived for months.
