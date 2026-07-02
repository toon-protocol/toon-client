---
'@toon-protocol/client-mcp': patch
---

Depend on `@toon-protocol/rig` (renamed from `@toon-protocol/git`; the SPA formerly named `@toon-protocol/rig` is now the private `@toon-protocol/rig-web`). No runtime behavior change — imports and the daemon git routes now resolve from the renamed package. (#247)
