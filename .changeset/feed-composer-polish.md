---
'@toon-protocol/views': patch
---

Polish the composer so it reads as part of the feed surface, not a pasted-in widget.

- Drop the opaque `bg-card` slab for a faint `bg-muted/20` fill that goes transparent on focus, with the jade focus ring defining the input — inheriting the host surface instead of painting a heavy box against the transparent feed.
- Hide the byte counter at rest (it's fee-relevant only once there's content), so the composer no longer shows a developer-y "0 bytes". The counter returns as soon as you type.

Affects both the free `composer` and the `pay-confirm` idle phase (shared `ComposerSurface`). Adds a `feed-list (+ composer)` panel to the dev gallery for visual iteration.

Also rework `feed-list` for fixed-height hosts. Claude Desktop gives the app a fixed-height iframe and scrolls the overflow (verified: it reports no `maxHeight` and does not grow to content), so a long inline feed always scrolled internally — and the "Open timeline" escalation was buried at the bottom of that scroll, so it was undiscoverable. Now:

- The inline view is a short preview (`INLINE_CAP = 4`); "Load more" reveals already-loaded rows past the cap (free, instant) then fetches older pages.
- "Open timeline" is anchored in a header ABOVE the notes (with a post count), so it's reachable without scrolling. It only appears where the host advertises a fullscreen surface; fullscreen renders the full timeline (a real scroll container).
- The dev gallery's mock bridge now advertises a fullscreen surface so the feed/thread "Open timeline" affordance and the mode switch can be exercised.
