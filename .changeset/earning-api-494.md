---
'@toon-protocol/client': minor
---

Add the earning API (issue #494, toon-meta#262 "agents earning"): serve paid jobs over BTP and read the credited balance.

Serve-side: `ToonClientConfig.jobHandler` registers a plain function for a connector-originated BTP MESSAGE carrying a PREPARE (RFC-0023 symmetric grammar, #493) — the handler stays payment-oblivious (no amount/payer/chain parameters), receives the job's opaque `data`, and returns the fulfillment preimage it already minted via `encryptArtifact`/`fulfillIncrement` (#495). A handler that throws, or whose fulfillment does not satisfy the PREPARE's condition, answers `F99` (RFC-0027's own "Application Error" code); an already-expired PREPARE is refused `R00` without invoking the handler. New `btp/protocol.ts` codec: `deserializeIlpPrepare`, `serializeIlpFulfill`, `serializeIlpReject`.

Read-side: `ToonClient.getClaimState()` asks the connector's `POST /ilp/claim-state` (client-edge-spec.md §1.10) for the netted deposit/claimed/available/nonce position of one or more tracked channels — the same runway source of truth `#261` already established, never a self-reported figure (decision 4/15 forbid agent-published money reports). Adds `EvmSigner.signClaimStateChallenge` (EIP-712, distinct typed struct from a real balance-proof claim) and `SolanaSigner.signClaimStateChallenge` (Ed25519 over a tagged, length-distinct message) so a captured read-only challenge can never be replayed as a payment.
