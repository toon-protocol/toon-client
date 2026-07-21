---
"@toon-protocol/rig": minor
---

Add `rig chain` — choose which chain (and therefore which USDC token) settles
paid `rig` writes. Each supported chain has its own USDC (EVM/Base Sepolia,
Solana devnet, Mina devnet), and settlement selection was previously only
possible via the `TOON_CLIENT_CHAIN` env var or hand-editing
`~/.toon-client/config.json`. The new command persists the choice to the config
`chain` field (a read-merge-write that preserves every other field):

- `rig chain` — show the current settlement-chain preference and which USDC it
  spends (or that selection is automatic when unset).
- `rig chain set <evm|sol|mina>` — pin the chain/USDC (`sol`/`eth` aliases and a
  full id like `evm:base:84532` are accepted).
- `rig chain unset` — clear the pin, reverting to automatic selection.

Free (local config only; never touches the relay or a chain). Warns when
`TOON_CLIENT_CHAIN` or a `supportedChains` array would take precedence over the
written value, and `--json` emits a machine-readable envelope.
