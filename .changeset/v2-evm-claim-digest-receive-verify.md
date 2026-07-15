---
'@toon-protocol/client': minor
---

v2 EIP-712 domain-separated balance-proof digest on the received-EVM-claim verify path (refs toon-protocol/connector#324 finding #1)

The v1 EVM claim digest bound neither `chainId` nor the settling contract, so a signer-signed claim could be replayed verbatim on another `(chain, deployment)` for the same tuple. This threads `chainId` + `verifyingContract` into the client's own EVM recompute/verify via a standard EIP-712 typed-data domain (`name="RollingSwapChannel"`, `version="2"`), making a signature valid on exactly one `(chainId, contract)` pair and failing the v1↔v2 cutover closed.

- adds a client-local v2 digest module (`swap/evm-claim-digest.ts`: `evmClaimDigest`, `evmCooperativeCloseDigest`, `recoverEvmClaimSigner`, `verifyEvmClaimSignature` + pinned domain/typehash constants) as the client's byte-for-byte conformance anchor until a v2 core/sdk ships, pinned by the spec §4 golden vectors;
- threads `chainId` (parsed off the chain key) + `verifyingContract` (new `tokenNetworks` param) into the receive-side EVM claim verification; an EVM claim missing either input is rejected `MISSING_CHAIN_CONFIG` (fail-closed). Solana/Mina keep the sdk `verifyAccumulatedClaim` path.

Breaking: EVM received-claim verification now requires `tokenNetworks` per chain key.

Note: the submit/build path (`buildSettlementTx`) still delegates to `@toon-protocol/sdk` (v1) and only produces v2 digests once a v2 sdk is published, so a v2-signed received claim does not yet fully round-trip through `buildSettlementTx`. The sdk delegation is a follow-up.
