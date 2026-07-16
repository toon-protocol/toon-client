---
"@toon-protocol/rig": minor
---

rig standalone: Solana funded-chain probe in settlement-chain selection.

- Rule 3 ("funded") of `selectSettlementChain` now probes announced `solana:*` chains alongside `evm:*` chains, in ANNOUNCE ORDER across both families — a wallet funded only on Solana automatically settles there instead of defaulting to an unfunded EVM chain. The first chain with a balance > 0 wins; when both families are funded, the peer's announce order breaks the tie. Probe errors and candidates whose RPC/token are underivable skip the chain, exactly as before. Rule 4 (default = first announced EVM chain) is unchanged.
- New `solanaTokenBalance` probe: one raw JSON-RPC `getTokenAccountsByOwner` POST (`{mint}` filter, `jsonParsed` encoding, amounts summed across the owner's token accounts, 5s timeout, injectable fetch) — same zero-heavy-deps style as `evmTokenBalance`; @solana/web3.js stays out of the pre-client-start path.
- The probed owner is the identity's own base58 Solana address, derived pre-client-start via `@toon-protocol/client`'s `deriveFullIdentity` (SLIP-0010 `m/44'/501'/{account}'/0'` — the same paths the embedded client settles with). Derivation only runs when a `solana:*` chain is actually announced and no explicit chain pins selection; when the Ed25519 derivation is unavailable, Solana chains are simply not probed.
- `SelectChainOptions` gains `solanaAddress?` and `probeSolanaBalance?` (injectable, mirroring `evmAddress`/`probeBalance`); `NetworkTopologyInputs` gains the matching `probeSolanaBalance?` test override.
