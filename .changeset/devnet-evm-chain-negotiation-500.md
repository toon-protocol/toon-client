---
'@toon-protocol/client': patch
---

Fix `network: 'devnet'` never negotiating EVM (issue #500): the devnet preset names its EVM chain in the family-qualified form (`evm:base:84532`, from `@toon-protocol/core`'s `resolveClientNetwork`), but the live devnet apex's `kind:10032` announce uses the unqualified form (`evm:84532`). Exact-string chain matching in `ToonClient`'s lightweight bootstrap-fallback negotiation never intersected the two sets, so it silently skipped EVM and negotiated `solana:devnet` instead — a chain nobody asked for, surfacing several layers later as an unrelated "empty Solana balance".

`matchNegotiatedChain` now compares chains by numeric chain id (`evm:base:84532` and `evm:84532` name the same chain; only the id disambiguates on-chain) instead of exact string equality, and returns the peer's own chain string so peer-side settlement maps still resolve correctly. When no common chain exists at all, it now throws `CHAIN_NOT_SUPPORTED` naming both the client's and the peer's supported chains, instead of silently falling back to a different chain.
