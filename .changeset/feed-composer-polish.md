---
'@toon-protocol/views': patch
---

Polish the composer so it reads as part of the feed surface, not a pasted-in widget.

- Drop the opaque `bg-card` slab for a faint `bg-muted/20` fill that goes transparent on focus, with the jade focus ring defining the input — inheriting the host surface instead of painting a heavy box against the transparent feed.
- Hide the byte counter at rest (it's fee-relevant only once there's content), so the composer no longer shows a developer-y "0 bytes". The counter returns as soon as you type.

Affects both the free `composer` and the `pay-confirm` idle phase (shared `ComposerSurface`). Adds a `feed-list (+ composer)` panel to the dev gallery for visual iteration.

Also cap the `feed-list` inline render to a bounded slice (`INLINE_CAP = 6`) instead of rendering the whole bound feed. The host caps an inline card's height and scrolls the overflow, so an unbounded feed produced an internal scrollbar; "Load more" now first reveals already-loaded rows past the cap (free, instant) then fetches older pages, and fullscreen (where available) shows everything.
