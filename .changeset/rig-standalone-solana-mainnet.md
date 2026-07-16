---
"@toon-protocol/rig": minor
---

rig standalone: Solana + mainnet settlement support in the embedded-client paid path.

- Solana channel parameters (`rpcUrl`/`programId`/`tokenMint`) are now derived per chain with the same `explicit config > kind:10032 announce > preset` precedence EVM already gets, and fed to the embedded client as `solanaChannel`. The announce's chain-keyed `tokenNetworks` map carries the payment-channel program id and `preferredTokens` the SPL mint. Core's client network presets cover the public clusters (deployed public-devnet program; mainnet-beta RPC + Circle USDC once the program is announced/configured). A Solana chain in play whose parameters are underivable fails fast with an actionable `SolanaChannelUnderivableError` (selected chain) or is dropped from the advertised list with a warning (listed chain) — never the embedded client's late "Solana channel config not provided".
- EVM mainnet chains (`evm:base:8453`, `evm:42161`, …) resolve RPC + Circle USDC from core presets by numeric chain id; the TokenNetwork comes from the announce or explicit config (fail-fast otherwise), locked by tests.
- A configured EVM chain spelling that names the same numeric chain id as an announced chain (config `evm:base:31337` vs announced `evm:31337`) is now aligned to the announced spelling before negotiation — chain negotiation matches identifiers exactly, so the mismatch previously stranded the EVM chain and negotiation silently fell through to an unopenable chain. Chain-keyed maps are re-keyed and pruned to the advertised list (the client validates `chainRpcUrls` keys ⊆ `supportedChains`).
- Announce discovery is no longer skipped for "fully explicit" configs whose listed `solana:*` chain lacks explicit channel parameters — the announce is a needed parameter source. Devnet-zone self-hosted chains (announce zone or a `*.devnet.toonprotocol.dev` RPC host) never take public-cluster preset addresses (the zone's Solana program id is regenerated per redeploy).

Verified live against the deployed devnet: a first `rig push` from a fresh identity now aligns `evm:base:31337` → `evm:31337`, negotiates EVM, opens the channel on-chain, and publishes (previously died with "Solana channel config not provided").
