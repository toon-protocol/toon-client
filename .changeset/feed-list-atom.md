---
'@toon-protocol/views': patch
---

Add a `feed-list` atom: a bounded, scannable timeline slice that respects MCP-app host rules (no in-iframe infinite scroll).

- Reuses `note-card` rows and adds a **"Load more"** footer that pages older notes via a free, de-duped `toon_query` (the host-blessed alternative to infinite scroll), plus an **"Open timeline"** that escalates to the host's fullscreen surface when one is available — and simply doesn't render on inline-only hosts.
- Wires the runtime so atoms receive their `bind`, a `loadMore` paginated-query seam, and a `surface` display-mode control (provided once per view via context, so atoms read it cheaply instead of each subscribing to the host).
- Adds a regression guard that `note-card`'s inline row caps at two actions (Reply + Like); Follow stays in the author popover.
