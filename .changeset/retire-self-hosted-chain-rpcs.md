---
'@toon-protocol/rig': patch
---

Stop resolving the retired self-hosted devnet chain RPCs in rig standalone. The TOON devnet's self-hosted chain boxes (`evm-rpc.devnet.toonprotocol.dev`, `solana-rpc.devnet.toonprotocol.dev`) are retired (2026-07-19); the devnet now settles on public networks (Base Sepolia `evm:84532`, public `solana:devnet`, `mina:devnet`). The devnet-zone RPC table and the `zoneSelfHosted` guard — which suppressed the public `solana:devnet` core preset for announces under `*.devnet.toonprotocol.dev` — are removed, so core public presets apply everywhere. Precedence is unchanged: explicit config > announce > core preset.
