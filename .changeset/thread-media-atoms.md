---
'@toon-protocol/views': patch
---

Add three composed atoms: `thread-view`, `media-gallery`, and `live-ticker`.

- **`thread-view`** — a focused conversation reconstructed from NIP-10 `e`/`p` thread tags over the bound notes. Inline it shows the focused note, its single direct parent (context), and a bounded slice of up to three direct replies (reusing `note-card` rows), plus a "View full thread (N)" affordance that escalates to the host's fullscreen surface when one is available. Fullscreen renders the whole reply tree with indentation capped at four levels; deeper chains collapse to a "continue thread →" button that re-roots them at the margin.
- **`media-gallery`** — an Album-style responsive grid of media events (NIP-68/71/94 + NIP-92 `imeta`), one tile per event with gateway-fallback loading and guaranteed alt text; tapping a tile opens an in-component lightbox (full media via the shared embed) with prev/next paging.
- **`live-ticker`** — a compact new-posts/mentions ticker for Picture-in-Picture. It feature-detects PiP: when `surface.canPip` it offers a "Go live" affordance (`surface.request('pip')`), otherwise it degrades to an inline snapshot plus a "Refresh" button that re-queries the base filter via the free `loadMore` seam. The item list is an `aria-live="polite"` region.

All three are registered in both the pure catalog and the React registry (kept in sync by `registry.test.tsx`).
