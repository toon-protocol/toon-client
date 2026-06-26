---
"@toon-protocol/client": patch
"@toon-protocol/client-mcp": patch
"@toon-protocol/views": patch
---

Add channel deposit (`toon_channel_deposit`) — deposit additional on-chain
collateral into an open payment channel.

- Client: `OnChainChannelClient.depositToChannel(channelId, amount, { currentDeposit })`
  with the EVM path live (approve if the allowance is short, then `setTotalDeposit`
  with `current + delta` — the contract takes the cumulative total, not a delta).
  Solana/Mina throw a clear not-yet-supported error (follow-up). `ChannelManager`
  gains `setDepositTotal`; `ToonClient.depositToChannel` reads the current tracked
  deposit, deposits, and updates the tracked total.
- Daemon: `POST /channels/deposit`, `ControlClient.depositToChannel`, and the
  `toon_channel_deposit` MCP tool (routes to the apex tracking the channel).
- Views: `deposit-form` atom (channel picker + amount + spendy signed deposit +
  receipt) and the `toon_channel_deposit` write tool on the apps surface.
