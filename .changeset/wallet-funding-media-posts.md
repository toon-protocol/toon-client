---
"@toon-protocol/client-mcp": minor
"@toon-protocol/views": minor
"@toon-protocol/client": patch
---

Wallet balance correctness (#199/#200), async funding, UI auto-refresh, and media posts.

- Balances: fast-fail with correct error attribution instead of a 35s control-plane hang; always emit wrapped `structuredContent`; the views seam validates the wire contract (no silent blank); read the settlement chain (not the preset-first chain) and from an identity-level client (works with no apex).
- Funding: async submit+poll `fund-wallet` with a `toon_fund_status` tool, a generous background faucet timeout, and a distinct `timeout` status so a slow-but-successful drip isn't reported as a failure.
- UI: rendered views auto-refresh after any write action; the Fund button resets once the balance updates.
- Media posts: captioned media uploader (compose → caption → publish) and an optional media/file attach on the default post composer (kind:1 with NIP-92 imeta, rendered inline); the dedicated uploader remains for upload-only.
