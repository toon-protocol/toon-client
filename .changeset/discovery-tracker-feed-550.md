---
"@toon-protocol/client": patch
---

Fix `TERMINATOR_UNRESOLVED` on every paid write: `discoveryTracker` (from `@toon-protocol/core`) was constructed on `start()` but nothing ever called its `processEvent()`, so `resolveTerminatorEndpoint` always saw zero discovered peers and failed closed. `start()` now opens a live relay subscription for kind:10032 announces and feeds each one into the tracker; `stop()` tears it down.
