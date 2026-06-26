---
'@toon-protocol/client': patch
'@toon-protocol/client-mcp': patch
---

Make the daemon faucet request timeout chain-aware. The Mina faucet settles much
slower than EVM/Solana and routinely takes longer than the flat 30s HTTP budget
to respond even though the drip succeeds server-side, so `toon_fund_wallet({chain:"mina"})`
reported `Faucet request timed out after 30000ms` on a request that actually
funded the wallet. `fundWallet` now defaults to 30s for evm/solana and 120s for
mina (`defaultFaucetTimeout`), and the daemon accepts an explicit override via
`faucetTimeoutMs` / the `TOON_CLIENT_FAUCET_TIMEOUT_MS` env var.
