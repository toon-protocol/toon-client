---
'@toon-protocol/views': patch
---

Add surface-mode + feed-pagination capability to the view runtime (the foundation for fullscreen feeds/threads and "load more").

- `ViewBridge` gains optional, feature-detected display-mode methods (`availableDisplayModes`, `displayMode`, `requestDisplayMode`, `onHostContextChanged`), wired to the ext-apps `App` host context. The `onHostContextChanged` subscription chains over the existing handler so it never clobbers theme following.
- New `useDisplayMode` hook exposes `{ mode, available, canFullscreen, canPip, request }`, reactive to host-context changes and degrading to inline-only on hosts (and the mock bridge) without the capability.
- New `nextPageFilter`/`mergePage` helpers page a feed backward in time via a free `toon_query` (NIP-01 `until`), de-duping by id — the load-more primitive for the upcoming `feed-list` atom.
