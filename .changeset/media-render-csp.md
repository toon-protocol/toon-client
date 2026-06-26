---
"@toon-protocol/client-mcp": patch
"@toon-protocol/views": patch
---

Render uploaded/feed media and surface the upload receipt.

- **client-mcp:** advertise the Arweave gateways in the app resource's
  `_meta.ui.csp` (`resourceDomains` + `connectDomains`) on both `resources/list`
  and `resources/read`, so the host iframe's `img-src`/`media-src`/`connect-src`
  stop blocking Arweave and media actually renders (toon-client#127).
- **views (media-uploader):** echo the publish receipt — show the uploaded
  image/video + the Arweave URL as a copyable link instead of just "completed".
- **views (feed):** move Follow off the per-note header into a click-to-reveal
  author profile; drop the no-op Reply action; top-anchor the spend-confirm
  prompt so it isn't centered off-screen in the tall host iframe.
