---
'@toon-protocol/client': minor
'@toon-protocol/client-mcp': patch
---

Resume the EVM payment channel across restarts instead of opening (and funding)
a new one every time (toon-client#489).

`ChannelManager` only knew a peer's channel **in memory**, so a restarted
process re-entered the lazy-open path and called `TokenNetwork.openChannel`
again — which mints a fresh `bytes32` per call, stranding the previous
channel's collateral. Solana never showed the bug only because its channel id
is a deterministic PDA: the re-open re-derived the SAME channel and
`trackChannel` rehydrated the watermark from the store. Live measurement runs
burned ~20 USDC of collateral per run in abandoned EVM channels (~560 USDC
across 28) while the Solana runs reused 16 channels across 12 runs with zero
new opens.

`channelStorePath` now persists a peer→channel **binding** (which on-chain
channel this identity holds with a peer, per chain + token network) in a
sibling file — `channels.json` → `channels.peers.json`; the watermark file
keeps its existing schema. `ensureChannel` consults it before opening
anything on-chain and re-attaches to the recorded channel **with its
nonce/cumulative watermark**, so claims continue above the last one the
connector saw. A binding whose watermark is missing is a hard
`ChannelResumeError` rather than a silent nonce reset (which would have every
later claim rejected); a channel already in the withdraw flow is not resumed.
`ChannelManager` also keys channels per peer AND chain AND token network, so a
peer settled with on two chains no longer hands back the wrong chain's channel.

New API: `ToonClient.adoptChannel(destination, channelId)` binds an
already-open channel for hosts that persisted the id themselves (the MCP
daemon's apex-channel store, rig's channel map) — tracking alone left the
lazy-open path unaware, so their first paid write after a restart still opened
a second channel. `OnChainChannelClient.adoptChannel()` re-seeds the on-chain
context so a resumed channel can also be deposited into and closed.
`InMemoryChannelStore` is exported for tests and short-lived processes.

Also hardens the EVM open against a **stale-read RPC**: `https://sepolia.base.org`
is a load balancer whose replicas can serve state predating a confirmed
`openChannel`, making the follow-up `setTotalDeposit` revert
`InvalidChannelState()` (`0xf806e9d9`) and leaving an uncollateralized channel.
The opener now polls the channel back before depositing, retries that specific
revert, and otherwise fails with an actionable `StaleRpcReadError` naming a
consistent endpoint (`https://base-sepolia-rpc.publicnode.com`, which core's
`base-sepolia` preset already carries). Tunable via
`OnChainChannelClientConfig.readConsistency`.

`@toon-protocol/client-mcp`: the daemon's resume path now calls
`client.adoptChannel()` after re-tracking its saved apex channel.
