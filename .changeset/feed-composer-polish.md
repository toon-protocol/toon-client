---
'@toon-protocol/views': patch
---

Polish the composer so it reads as part of the feed surface, not a pasted-in widget.

- Drop the opaque `bg-card` slab for a faint `bg-muted/20` fill that goes transparent on focus, with the jade focus ring defining the input — inheriting the host surface instead of painting a heavy box against the transparent feed.
- Hide the byte counter at rest (it's fee-relevant only once there's content), so the composer no longer shows a developer-y "0 bytes". The counter returns as soon as you type.

Affects both the free `composer` and the `pay-confirm` idle phase (shared `ComposerSurface`). Adds a `feed-list (+ composer)` panel to the dev gallery for visual iteration.

Also make `feed-list` PAGINATED instead of scroll/append. Claude Desktop gives the app a fixed-height iframe and scrolls the overflow rather than growing to content (verified live: it reports no `maxHeight` and does not size to the page), so any append-style feed grew into an internal scrollbar. feed-list now shows one bounded page (`PAGE_SIZE = 5`) with Newer/Older buttons that REPLACE the page — the rendered height stays roughly constant, so there is no internal scroll. Older pages are fetched on demand via a free `toon_query` (NIP-01 `until`); already-fetched pages page back instantly. The dev gallery's mock bridge advertises a fullscreen surface so other atoms' display-mode affordances can still be exercised.
