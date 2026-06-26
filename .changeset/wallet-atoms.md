---
"@toon-protocol/views": patch
"@toon-protocol/client-mcp": patch
"@toon-protocol/client": patch
---

Add wallet + loading/placeholder atoms to the MCP UI.

- Loading atoms (`skeleton`, `loading`, `progress-steps`) the agent can render
  immediately while it works out the real journey.
- `wallet-overview` (per-chain address with copy-to-share + on-chain balance
  enrichment + devnet faucet) and `channel-list` (live tracked channels with
  available/deposit balance), backed by new read seams.
- New free-read tools `toon_channels` (now enriched with `depositTotal` +
  `availableBalance`) and `toon_balances`, plus the `toon_fund_wallet` faucet
  action wired into the apps surface. Client exposes `getChannelDepositTotal`.
