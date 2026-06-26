---
"@toon-protocol/views": patch
---

Resolve feed note avatars. A feed bind queries `kinds:[1]` only, so `NoteCard` could never join the author's kind:0 from its own events and every note fell back to the placeholder avatar. Add a runtime-wired `resolveProfile` seam (a lazy, session-cached free read for an author's kind:0, mirroring the existing `readStatus` seam so atoms still never touch the bridge); `NoteCard` now pulls the author's profile on demand and shows their display name + picture, while authors with no kind:0 still degrade to the deterministic placeholder.
