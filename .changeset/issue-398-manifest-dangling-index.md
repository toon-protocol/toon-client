---
"@toon-protocol/rig": patch
---

Fix `rig site publish` emitting a manifest `index` pointing at a path that isn't in the site's files (e.g. no `index.html`), which made the site root 404 in a way indistinguishable from ArNS propagation lag. The manifest builder now omits `index` when the path is absent; `rig site publish` already warned and supported `--index <path>`.
