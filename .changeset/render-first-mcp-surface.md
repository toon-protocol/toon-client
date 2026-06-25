---
"@toon-protocol/client-mcp": minor
---

Move the render-first policy onto the MCP server itself so it reaches every host — including claude.ai chat, which never loads the Claude Code plugin skill and only sees tool descriptions + the server `instructions` field.

- `toon_render` description rewritten to claim the PRIMARY display surface for all TOON data, explicitly beating generic HTML/SVG/chart/widget tools, naming the trigger verbs (see/show/open/view/browse/render/compose), and mandating an atoms-first flow.
- Server `instructions` set on the `Server` options in `mcp.ts` (returned in the `initialize` result) with a condensed render-first policy.
- Read/status tools (`toon_status`, `toon_query`, `toon_channels`, `toon_targets`, `toon_read`) gained a one-line nudge to display results via `toon_render` rather than a generic widget or plain text.
- `toon_atoms` strengthened to an imperative precursor: REQUIRED first call before any `toon_render`; never guess atom ids/kinds.

Descriptions/instructions only — no tool behavior, params, handlers, or ViewSpec validation changed. Complements the Claude Code skill render-first policy (PR #110).
