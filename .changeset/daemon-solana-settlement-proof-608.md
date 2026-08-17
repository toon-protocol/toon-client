---
---

CI/test only — no published behaviour changes, so this changeset is
deliberately empty rather than bumping `@toon-protocol/client-mcp`.

toon-client#605/#610 proved the client LIBRARY redeems a Solana claim
against a real `solana-test-validator`. Neither exercised the DAEMON:
`ClientRunner.settleSwapClaims` (`packages/client-mcp/src/daemon/client-runner.ts`)
is what actually runs in production, and does four things the library proof
cannot reach — reads `solanaProgramId` from
`config.toonClientConfig.solanaChannel.programId`, delegates through
`identityClient.settleSwapBundle` rather than calling
`submitSolanaSettlement` directly, writes the `settledNonce`/`settleTxHash`
watermark so a replay reports `ALREADY_SETTLED` before the chain has to, and
surfaces a `SolanaSettlementError` code (e.g. `RECIPIENT_MISMATCH`) verbatim
instead of collapsing every failure to `SUBMISSION_FAILED`.

`packages/client-mcp/src/__integration__/daemon-solana-settle.integration.test.ts`
proves all four against a real validator running the real vendored
payment-channel program, driving a real `ClientRunner` + real `ToonClient`
(no mocked `settleSwapBundle`), and reads the on-chain channel account back
to require `nonce_a`/`transferred_amount_a` actually moved — twice: once to
prove a real redemption landed, once to prove a second call on the same
watermark sends nothing.

Wired into `.github/workflows/ci.yml`'s `solana-settlement-proof` job
alongside the client-level proof, reusing the CLI install and
`CLIENT_REQUIRE_SOLANA=1` gate already there — its own port pair
(18699/18698) is distinct from every other Solana validator this repo or its
siblings spin up. That job now also builds `@toon-protocol/client`, which
this suite imports as a package (`@toon-protocol/client`'s `exports` map
resolves through `dist/`, unlike the client-level suite's relative-source
imports).

`packages/client-mcp/package.json` gains `@noble/curves`/`@noble/hashes` as
devDependencies (claim signing + PDA derivation in the new suite only — not
bundled, not published) and a new `tsconfig.integration.json` so the suite
typechecks (mirroring `packages/client`'s own).
