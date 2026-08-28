---
'@toon-protocol/client': patch
'@toon-protocol/client-mcp': patch
---

Stage 8b of [toon-meta#411](https://github.com/toon-protocol/toon-meta/issues/411): fix client guidance surfaces that still described the legacy swap protocol Stage 4 (toon-client#598) removed.

Docs-only, no behavior change. `SKILL.md`, `tool-reference.md`, the `toon_swap` MCP tool description, server `instructions`, and `control-api.ts` JSDoc already described the rolling RFQ-then-fills session correctly — those needed no change. Three stragglers did:

- `toon-plugin/skills/toon-client/references/tool-reference.md` — the `toon_swap` row still named the legacy `NIP-59 gift-wrapped kind:20032` wrap; now describes the rolling kind:20033/20034 RFQ session and the loud `rolling_unavailable` failure.
- `packages/client/README.md` — two spots recommended `streamSwap()` from `@toon-protocol/sdk` as the higher-level swap API. Nothing in this repo imports it any more (Stage 4 deleted the last call site); the actual rolling-session primitives (`sendRollingRfq`, `handleRollingAdvance`) are exported from `@toon-protocol/client` itself.
- `packages/client-mcp/scripts/README.md` — pointed at `packages/sdk/scripts/swap.mjs`/`swap-mina.mjs`, which built the legacy kind:20032 rumor; those scripts were removed with the legacy sdk API (toon#211). Replaced with a pointer at the daemon's `/swap` endpoint.

Closes toon-client#599.
