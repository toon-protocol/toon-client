---
"@toon-protocol/client": patch
"@toon-protocol/client-mcp": patch
---

Read live on-chain wallet balances (`toon_balances`).

Adds a read-only `WalletBalanceReader` (EVM ERC-20 `balanceOf` via viem; Solana
SPL via `getTokenAccountsByOwner`; native MINA via GraphQL) and
`ToonClient.getBalances()` — best-effort per chain, no signing or payment. Wires
it end-to-end through the daemon: `GET /balances`, `ControlClient.balances()`,
and the `toon_balances` MCP tool. The `wallet-overview` atom's balances now
resolve live (it already worked from the identity addresses).
