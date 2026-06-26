---
"@toon-protocol/views": minor
---

Polish the MCP feed render to match the gallery and surface engagement:

- Frame the app view in a rounded, bordered panel on a faintly tinted page,
  capped to a reading width and centered (was an edge-to-edge square slab).
- Surface per-note **reply / like / follow** in `feedView` — and thread feed-node
  actions through the `kindAuto` render path (`NodeView → EventAtom →
  NativeEvent`), which previously hard-coded `actions={{}}` so engagement never
  appeared in feeds. Like/follow are `spendy` (fee-confirm) paid writes.
- Rich-text note bodies: `#hashtags`, `@`/`npub` mentions and URLs lift into the
  jade accent (URLs are real links), built as React nodes (no HTML injection).
- Compact the empty composer, and give placeholder avatars a subtle ring.
