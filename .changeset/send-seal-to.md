---
'@toon-protocol/client': patch
---

`toon send --seal-to <url|key>` passes `SendOptions.sealTo` through, so the CLI can pay a route the addressed connector only forwards.
