---
"@toon-protocol/client-mcp": patch
---

Make the wallet card actually show balances (follow-up to #194 / #186).

#194 fixed the wallet UI and the daemon-side flakiness, but balances still
rendered blank because the tool results carried no `structuredContent`:

- **`toon_balances` / `toon_channels` returned text only.** The MCP-app iframe
  bridge surfaces *only* a tool's `structuredContent` as the data atoms read, so
  the `readBalances` / `readChannels` seams got `undefined` → `wallet-overview`
  showed addresses but no balance/USDC and no error (an empty read is
  indistinguishable from a real zero), and deposit/withdraw/publish receipts came
  back blank. Centralized the fix in the `ok()` tool-result helper so it mirrors
  object payloads into `structuredContent` (text unchanged; fixes the whole
  class at once). Tests now assert `structuredContent`, the contract the
  text-only tests missed.
- **Balance read no longer long-spins.** On-chain reads can be slow on devnet
  RPCs; the balance read is now capped at 12s (vs the 35s default) via a
  per-request timeout override, so the card resolves — or shows its Retry state —
  in a few seconds instead of spinning.
