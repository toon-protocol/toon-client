---
'@toon-protocol/client': patch
'@toon-protocol/rig': patch
---

fix(rig): `rig balance` shows all three chains (EVM / Solana / Mina)

`rig balance` previously showed only the EVM chain: the rig-embedded client
builds its config via `resolveNetworkTopology` (not `applyNetworkPresets`), so a
single-EVM-chain identity had no `solanaChannel`/`minaChannel`, and
`getWalletBalances` gated the Solana/Mina rows on those being set.

The wallet view now falls back to the named network's public RPC/GraphQL
(`resolveClientNetwork`) when no channel is configured, so all three chains
appear — the address is derived from the mnemonic and the balance reads `0` for
an account not yet on-chain. `getWalletBalances(fallback)` gains an optional
wallet-view-only fallback; it is threaded through the rig money seam and is
NEVER merged into settlement config, so chain negotiation is unaffected. Explicit
`config.solanaChannel`/`minaChannel` still win.

Also bounds each wallet-balance RPC/GraphQL request individually (viem `timeout`
for EVM; an `AbortSignal` for the Solana/Mina `fetch`, since Node's global fetch
has no default timeout). One intermittently-slow endpoint now degrades only its
own chain to `unreadable` instead of hanging the whole multi-chain read until the
caller's outer bound and hiding every chain's balance. Env override
`TOON_WALLET_RPC_TIMEOUT_MS` (default 8000; `0` disables).
