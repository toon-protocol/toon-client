---
'@toon-protocol/client-mcp': patch
'@toon-protocol/views': patch
---

Surface the real media-upload error instead of a generic "Upload failed." The
`media-uploader` atom now renders the underlying error string from the action
outcome (degrading to a generic message only when none is present), and the
daemon's `uploadMedia` labels which of the two legs failed — the Arweave blob
upload (`store` destination) vs. the post-upload kind:20/1063 reference-event
publish (`relay` destination) — so the failing leg is diagnosable from the UI
without a behavioral change to the upload itself (#148).
