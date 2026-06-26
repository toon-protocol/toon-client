---
"@toon-protocol/client": patch
"@toon-protocol/client-mcp": patch
"@toon-protocol/views": patch
---

Channel withdraw (close → wait → settle) — release collateral from a channel.

- Client: `OnChainChannelClient.closeChannel`/`settleChannel` (EVM live; reads the
  `channels()` view for the authoritative `closedAt`+`settlementTimeout`).
  `ChannelManager` persists `closedAt`/`settleableAt`/`settledAt` (resumed on
  restart; `signBalanceProof` no longer clobbers them) + `getChannelCloseState`.
  `ToonClient.closeChannel`/`settleChannel` — the settle time guard: never settle
  before `settleableAt` (unix seconds), throwing a retryable error otherwise.
  Solana/Mina close+settle are follow-ups.
- Daemon: `POST /channels/{close,settle}` (settle-too-early → HTTP 425 retryable),
  `toon_channel_close`/`toon_channel_settle` MCP tools; `toon_channels` now carries
  `closeState`/`settleableAt`.
- Views: `withdraw-flow` atom — a stepper (Close → Wait → Settle) with a live
  countdown to `settleableAt` and a Settle button gated until the grace period
  elapses; reuses the `progress-steps` stepper.
