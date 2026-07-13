---
"@toon-protocol/client": patch
---

De-duplicate `publishEvent`'s inline claim-resolution branch into the shared `resolveClaimForDestination` helper already used by `sendSwapPacket`.
