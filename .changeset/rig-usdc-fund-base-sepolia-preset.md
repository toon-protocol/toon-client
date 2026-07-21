---
"@toon-protocol/client": patch
"@toon-protocol/rig": patch
---

Point `rig` at the current public devnet/testnet infra instead of dead or stale
defaults.

- `rig fund` now funds **USDC only** (assuming the wallet already holds gas) via
  the USDC-only faucet legs (`/api/base-sepolia/request`,
  `/api/solana/usdc-request`, `/api/mina/usdc-request`) instead of the
  deprecated local-anvil `/api/request` leg, and accepts a positional chain so
  `rig fund sol | mina | evm | all` works alongside `--chain` (`sol` aliases
  `solana`).
- Fix `rig balance` / channel settlement resolving the **wrong Base Sepolia
  token**: the `@toon-protocol/core` `base-sepolia` (`evm:84532`) preset still
  carries the retired e2e deployment (18-decimal USDC, old TokenNetwork), so the
  announce-fallback path read the wrong token at the wrong decimals. Corrected
  the fallback to the current public addresses in both the rig resolution layer
  and the client SDK (`applyNetworkPresets`), pending an upstream core bump.
- Harden the dead-local `ws://localhost:7100` relay fallbacks to the public
  devnet relay `wss://relay-ws.devnet.toonprotocol.dev` (explicit config still
  wins).
