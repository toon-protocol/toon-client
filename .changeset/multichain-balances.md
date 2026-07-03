---
'@toon-protocol/client': minor
'@toon-protocol/rig': minor
---

`rig balance`: full multi-chain wallet view — native coin + USDC across EVM, Solana, and Mina (#299)

`rig balance` previously showed a single number: USDC on the EVM settlement
chain (and, on the unstarted embedded client, Solana/Mina never appeared at all
because their keys only derive during a client start). It now renders a per-chain
block for every chain the identity is configured for — the native coin
(ETH / SOL / MINA) AND USDC — with the wallet address per chain. A chain with no
configured token still shows its native balance; an unreachable RPC degrades to a
per-chain `unreadable (RPC unreachable)` notice without failing the other chains
(each chain is read independently, in parallel). The command stays FREE (RPC +
local state reads only) and `--json` grows to
`{ chain, chainKey, address, native, tokens[] }[]`.

`@toon-protocol/client` gains `ToonClient.getWalletBalances()` — the comprehensive
multi-chain reader (native + tokens grouped per chain) — plus native readers
(`readEvmNativeBalance`, `readSolanaNativeBalance`) and a pure grouped reader
(`readWalletBalances`), all exported. The existing settlement-scoped
`getBalances()` is unchanged (payment-channel settlement semantics depend on it).
`getWalletBalances()` derives the Solana/Mina addresses from the mnemonic on
demand, so it reports every configured chain even on an unstarted client.

Follow-up: the daemon/MCP `toon_balances` path still uses `getBalances()`; it can
adopt the richer `getWalletBalances()` view separately (touches the views atoms).
