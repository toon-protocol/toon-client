---
'@toon-protocol/client-mcp': minor
'@toon-protocol/views': minor
---

Rename the `toon_upload_media` MCP tool to `toon_upload` and generalize it from media-only to any blob.

The tool still does the spendy two-step upload (base64 bytes → Arweave via the kind:5094 store/DVM over `POST /store`, then sign+publish a referencing event), but its description and naming no longer imply media: the reference event `kind` defaults to 1063 (NIP-94; 20=picture, 21/22=video, 1=note w/ NIP-92 imeta) and can be set to suit any blob type. Callers using the old `toon_upload_media` name must switch to `toon_upload`.
