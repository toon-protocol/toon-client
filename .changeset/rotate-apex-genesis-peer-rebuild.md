---
'@toon-protocol/client-mcp': patch
'@toon-protocol/client': patch
'@toon-protocol/rig': patch
---

Rebuild against `@toon-protocol/core@3.1.4` so the bundled devnet genesis peer
carries the apex's rotated announce identity.

`core` is bundled into `client-mcp`'s published bundle at build time, so a
dependency bump alone does not reach users — the package has to be rebuilt and
republished for the new genesis pubkey to ship. This release does that.
