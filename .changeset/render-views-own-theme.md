---
"@toon-protocol/views": minor
---

Render the MCP app in TOON's own theme instead of adopting the host's. The
iframe entry (`app-entry.tsx`) previously called `useHostStyleVariables` and
`useHostFonts`, which let Claude Desktop's palette and fonts override the views
design tokens — so the in-chat render looked like generic chat chrome rather
than the jade-primary / cool-slate / Geist-Mono "ledger" theme shown in the
standalone views gallery. Drop both hooks so `globals.css` always wins.

The app still **follows the host's light/dark preference** — but by mirroring it
onto the views `.dark` class (via `app.getHostContext().theme` +
`onhostcontextchanged`) rather than adopting the host palette, so inside dark
Claude the views *dark* theme engages and matches the gallery's dark mode (with
an OS `prefers-color-scheme` fallback when the host reports no theme).

(Co-releases client-mcp via the fixed group so the baked app bundle is
republished.)
