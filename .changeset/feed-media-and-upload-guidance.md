---
"@toon-protocol/views": patch
"@toon-protocol/client-mcp": patch
---

- Feed shows media inline: `buildFeedFilter` now includes NIP-68/94 media kinds
  (20/21/22/1063) alongside kind:1, so pictures/video render interleaved with
  notes (kindAuto → media-embed), newest-first.
- Upload guidance: the MCP server `instructions` now forcefully direct the agent
  to render the media-uploader on any upload intent (don't ask for a file/URL or
  recount history).
- media-uploader handles ANY file, not just media: the picker accepts any type by
  default (optional `accept` prop to restrict), the publish kind is chosen from
  the file MIME (image→20, video→21, else→NIP-94 1063), and the receipt shows a
  preview for images/video and a file row + Arweave link for everything else.
