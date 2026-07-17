---
'@toon-protocol/rig': minor
---

Fix the two #384 devnet e2e findings:

- **Zero-config chain negotiation**: the shipped devnet RPC endpoint table now
  matches EVM chains by numeric chain id, so an announce spelling the devnet
  chain `evm:anvil:31337` (the qualified `evm:{network}:{chainId}` key format)
  resolves the same zone RPC as `evm:31337`. A bare mnemonic + relay URL can
  balance-probe the announced EVM chain again instead of skipping it and
  falling through to an unusable `solana:devnet` pick that died at push time.
- **Identity precedence**: an env- or `.env`-sourced `RIG_MNEMONIC` now derives
  at account 0 regardless of the active `TOON_CLIENT_HOME` — a per-home
  config's `mnemonicAccountIndex` applies only when the phrase itself came
  from that shared state dir. The new `RIG_ACCOUNT_INDEX` environment variable
  overrides the account index for every source (malformed values fail fast).
