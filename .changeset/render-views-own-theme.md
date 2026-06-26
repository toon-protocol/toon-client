---
"@toon-protocol/views": minor
---

Render the MCP app in TOON's own theme instead of adopting the host's. The
iframe entry (`app-entry.tsx`) previously called `useHostStyleVariables` and
`useHostFonts`, which let Claude Desktop's palette and fonts override the views
design tokens — so the in-chat render looked like generic chat chrome rather
than the jade-primary / cool-slate / Geist-Mono "ledger" theme shown in the
standalone views gallery. Drop both hooks so `globals.css` always wins and the
in-chat app matches the gallery. (Co-releases client-mcp via the fixed group so
the baked app bundle is republished.)
