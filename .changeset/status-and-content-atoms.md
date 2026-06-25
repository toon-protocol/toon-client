---
"@toon-protocol/views": minor
"@toon-protocol/client-mcp": patch
---

Add a status dashboard + generic content atoms so the agent can render
non-event data (daemon status, write targets, balances, identity) instead of
falling back to plain text.

- New generic content primitives — `heading`, `text`, `stat`, `key-value`,
  `badge` — props-driven (no event kinds), so any structured data composes from
  the atom vocabulary.
- New `client-status` dashboard atom: reads live `toon_status` via the existing
  `readStatus()` seam and renders ready/bootstrapping state, uptime, settlement
  chain + fee, relay (url/connected/buffered/subscriptions), transport,
  per-chain readiness, and identity (npub + chain addresses); handles the
  loading/unavailable states gracefully.
- New example ViewSpecs (`client-status`, `info`) so the agent learns the
  render-first pattern for non-event surfaces.

`client-mcp` ships a refreshed app bundle that includes the new atoms.
