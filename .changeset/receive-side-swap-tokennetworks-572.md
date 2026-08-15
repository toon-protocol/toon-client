---
"@toon-protocol/client": patch
---

Fix receive-side swap-claim verification sourcing `tokenNetworks` from local daemon config instead of the maker's own kind:10032 announce (issue #572, found during the toon-meta#394 T6 devnet proof).

`ingestReceivedClaims`'s v2 EIP-712 verification needs a `(chainId, verifyingContract)` map to reconstruct the claim's domain, and it previously came ONLY from the local `tokenNetworks` config passed in by the caller. Live consequences: a daemon whose config names its own relay's TokenNetwork (the natural default) rejected every maker claim `SIGNER_MISMATCH`; one daemon could not verify claims from two makers with different `RollingSwapChannel` deployments; and the maker's own advertised `tokenNetworks` (advertised precisely so a client can reconstruct the domain, swap#102/toon-meta#394 T2) was never consumed.

- `ToonClient.getDiscoveredPeerInfo(pubkey)` (new, public) resolves a discovered kind:10032 announce by Nostr pubkey regardless of peering status — a swap maker is a payment destination, not necessarily a connector peer.
- `ingestReceivedClaims` now PINS the `verifyingContract` it verified an EVM claim against onto the persisted `ReceivedClaimEntry` (pin-on-first-use). `buildSwapSettlements` prefers that pinned value over the `tokenNetworks` config at settle time, so a daemon holding claims from two makers with different deployments settles each against the contract it actually verified with, even across a config drift / restart.
- `buildSwapSettlements` now lowercases the resolved `verifyingContract`/TokenNetwork address before handing it to the sdk's settlement-tx builder, which requires a strict `0x` + 40 lowercase-hex `contractAddress` — the receive-side verifier itself already accepted either case, so a checksummed config/announce address used to build successfully but fail to settle.

The `client-mcp` daemon (`ClientRunner.swap`) now resolves the verification `tokenNetworks` map as the swap maker's own announce (base) merged with the daemon's configured `tokenNetworks` layered on top as an explicit operator override, rather than config alone.
