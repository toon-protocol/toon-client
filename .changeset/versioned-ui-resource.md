---
'@toon-protocol/client-mcp': patch
---

Cache-bust the `ui://toon/app` resource by versioning its URI with a hash of the bundle. Hosts (Claude Desktop) prefetch and cache the UI template keyed by its URI and do not re-fetch it across server restarts — so a rebuilt bundle was never picked up and the iframe stayed stale indefinitely. The server now derives `ui://toon/app?v=<bundle-hash>` at startup and uses it for `resources/list`, `resources/read`, and `toon_render`'s `_meta.ui.resourceUri`; every rebuild yields a new URI the host has never cached (forcing a fresh fetch), while an unchanged bundle keeps the same URI. `resources/read` also accepts the bare base URI in case a host strips the query.
