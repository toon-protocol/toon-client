---
'@toon-protocol/client': minor
---

Full v2 EIP-712 domain-separated balance-proof adoption on both the receive AND settlement-build EVM claim paths (refs toon-protocol/connector#324 finding #1). Bumps `@toon-protocol/sdk` + `@toon-protocol/core` to `^3.0.0` (the published v2 EIP-712 packages).

The v1 EVM claim digest bound neither `chainId` nor the settling contract, so a signer-signed claim could be replayed verbatim on another `(chain, deployment)` for the same tuple. This binds `chainId` + `verifyingContract` into every EVM claim digest via a standard EIP-712 typed-data domain (`name="RollingSwapChannel"`, `version="2"`), making a signature valid on exactly one `(chainId, contract)` pair and failing the v1↔v2 cutover closed.

- adds a client-local v2 digest module (`swap/evm-claim-digest.ts`: `evmClaimDigest`, `evmCooperativeCloseDigest`, `recoverEvmClaimSigner`, `verifyEvmClaimSignature` + pinned domain/typehash constants) as the client's byte-for-byte conformance anchor, pinned by the spec §4 golden vectors;
- threads `chainId` (parsed off the chain key) + `verifyingContract` (`tokenNetworks` param) into the receive-side EVM claim verification; an EVM claim missing either input is rejected `MISSING_CHAIN_CONFIG` (fail-closed). Solana/Mina keep the sdk `verifyAccumulatedClaim` path;
- the settlement-build path (`buildSwapSettlements` → sdk `buildSettlementTx`) now runs on the published v2 sdk, which verifies EVM claims against the same v2 EIP-712 digest. `buildSwapSettlements` threads `chainId` + `verifyingContract` (from `tokenNetworks`) into the sdk signer config, so a v2-signed received claim round-trips through `buildSettlementTx` with settle-time signature re-verification (defense-in-depth) fully restored.

Breaking: EVM received-claim verification AND settlement build now require `tokenNetworks` per chain key, and the wire digest is v2-only (a v1 signature never validates as v2). Depends on `@toon-protocol/sdk@^3` / `@toon-protocol/core@^3`.
