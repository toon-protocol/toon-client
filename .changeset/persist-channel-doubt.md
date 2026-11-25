---
'@toon-protocol/client': patch
---

A batch-settlement channel whose watermark is in doubt stays in doubt across `toon-client` invocations: the doubt is persisted in the channel store, so the next command resyncs against `claim-state` before signing instead of being refused again.
