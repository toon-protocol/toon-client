---
"@toon-protocol/client": patch
"@toon-protocol/client-mcp": patch
---

Fix the wallet falsely showing "No channels open yet" on funded channels, and
make rendered TOON views render-first with no preflight ceremony.

- **`GET /channels` 500 → wallet "No channels open yet".** `getChannels()`
  called `apex.client.getSettleableAt(channelId)`, but `ToonClient` never got the
  public passthrough when it was added to `ChannelManager` (#181) — it only used
  `this.channelManager.getSettleableAt` internally. The wallet atom renders the
  failed fetch as empty, so funded, actively-paying channels showed as none.
  Added the passthrough, plus a compile-time conformance guard
  (`toon-client-conformance.ts`) asserting `ToonClient` satisfies the daemon's
  `ToonClientLike` surface — the channel-tool tests use a mock client, which is
  why this gap shipped green.
- **Resumed channels showed 0 deposit / 0 available.** Persisted channel state
  omits the on-chain deposit, so after a daemon restart `depositTotal` was `0`
  and the wallet showed 0 spendable on a funded channel. The daemon now re-reads
  the participant's on-chain `deposit` (new `participants` accessor on the
  TokenNetwork ABI + `ToonClient.rehydrateChannelDeposit`) when resuming an EVM
  apex channel, so `available = deposit − cumulative` is correct again.
- **Render-first, zero ceremony.** The server `instructions` and the
  `toon_status` / `toon_identity` tool descriptions now state that a read-only
  render goes straight `toon_atoms` → `toon_render` — no status/identity/balance
  preflight, no tool-call narration. SKILL.md's "always start with `toon_status`"
  is reframed to lazy/render-first.
