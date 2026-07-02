---
'@toon-protocol/rig': minor
---

Real network bootstrap for standalone paid commands (#264, closing out #260's bootstrap root causes): rig now upgrades to `@toon-protocol/core` ^2.0.1 (live devnet genesis seed) and resolves the payment topology from the network instead of hand-fed constants, in strict `explicit config > live kind:10032 announce > genesis seed` order.

- **Announce discovery**: paid commands discover the payment peer's kind:10032 `IlpPeerInfo` announce on the relay-origin (the relay resolved via `rig remote`). The announce supplies the uplink (`httpEndpoint`/`btpEndpoint`), the channel anchor (`ilpAddress`), the publish/store ILP routes (`routes` map — replacing the #228-era `<base>.relay.store` derivation as the default), and the peer's `supportedChains`/`settlementAddresses`.
- **tokenNetwork fallback** (#260): per-chain TokenNetwork/token/RPC parameters the announce omits are derived — explicit config > announce > canonical devnet endpoint table > core's deterministic chain presets (matched by chain id) — and back-filled into the client's peer negotiation before the channel opens. A selected EVM chain whose TokenNetwork stays underivable fails with a clear error naming the announce, chain, and relay.
- **Settlement-chain selection** (#260): explicit config (`TOON_CLIENT_CHAIN`/`chain`/`supportedChains`) > the chain of a live persisted #262 channel > the first announced EVM chain where the wallet holds tokens > the first announced EVM chain, with a printed rationale. The `network` preset field is no longer forwarded to the embedded client (its preset-first chain ordering steered devnet writes to the unfunded public Solana preset).

Out of the box, `rig init` + `rig remote add origin <relay>` + a faucet-funded identity now completes a paid `rig push` on devnet with no destination/anchor/tokenNetwork/chain configuration.
