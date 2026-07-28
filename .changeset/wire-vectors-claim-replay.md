---
'@toon-protocol/client': patch
---

Refresh the vendored cross-repo wire vectors to connector `main` (#588), and
replay the new `claim` section against `signing/evm-signer.ts`.

The drift check added in toon-client#454 fired for the first time: connector#588
added a `claim` section to `vectors/wire-vectors.json`. The vendored copy and its
provenance now pin connector `425a8abb72e982f43955c35d9c0cf50fd5a2d55e`.

`claim` is the EIP-712 `BalanceProof` of connector ADR 0024 — the same struct and
the same per-channel `TokenNetwork` domain that `EvmSigner.signBalanceProof`
already signs on the client edge — so it is replayed, not carried unreplayed:
this client reproduces the published digest and the published 65-byte signature
byte-for-byte.

The harness can no longer ignore a section it does not understand. `load.ts`
exports a closed `WIRE_VECTOR_SECTIONS` list, and the suite fails if the vendored
file carries a section outside it, or one that is neither declared replayed nor
declared deliberately-not-yet-replayed.

Test-only: nothing under `src/wire/vectors/` is reachable from `src/index.ts`, so
the published surface is unchanged.
