---
"@toon-protocol/rig": minor
---

Auto-derive the Mina payment channel and per-chain RPC URLs from the peer
announce, so a fresh devnet client no longer needs to hand-write a `minaChannel`
block or a `chainRpcUrls` override in `~/.toon-client/config.json`.

Previously EVM and Solana settlement derived from the announce + core presets,
but Mina was the only chain that required explicit config, and RPC endpoints
came solely from the baked core presets — where the EVM default
(`sepolia.base.org`) is a stale-read load balancer that breaks
`openChannel`→`setTotalDeposit`, so a first-time client was effectively broken
on EVM channel-open until it manually overrode the RPC.

Now the client consumes two additive announce content fields — `minaTokenIds`
and `chainRpcUrls` — with precedence **explicit config > announce > core
preset**:

- `minaChannel` is derived when absent (zkAppAddress from the announced
  `tokenNetworks`, tokenId from the new `minaTokenIds`, graphqlUrl/networkId
  from the preset); an explicit `config.minaChannel` still wins verbatim.
- EVM/Solana/Mina RPC URLs resolve from the announce first, so the live
  deployment advertises working endpoints (e.g. the correct Base Sepolia RPC)
  instead of the client falling back to a stale/broken baked preset.

Announce-advertised **first**, with the core preset as a drift-proof fallback:
the deployment-specific values (zkApp, tokenId, RPC) are drift-prone, so the live
announce overrides when present. The corrected core preset (Mina zkApp + tokenId,
publicnode Base Sepolia RPC) is the baked fallback a fresh client resolves when
the announce carries nothing — so once this client picks up the corrected core
release, a fresh `rig fund && rig balance` works on all three chains **without**
waiting on a connector redeploy. Fully backward-compatible: old clients ignore
the new announce fields; the announce still wins over the preset when present.
