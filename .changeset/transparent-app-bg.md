---
"@toon-protocol/views": patch
---

Render the MCP app on a transparent page so the host's own (rounded) message
container shows through, instead of an opaque slab with square corners boxing the
view in. Drops the bg-tinted framed panel — keeps only inset padding + a
reading-width cap; the atoms are self-framing rounded cards. The standalone
gallery is unaffected (it keeps globals.css's body paint; the app overrides it in
`main.tsx`).
