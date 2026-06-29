---
'@toon-protocol/client-mcp': patch
---

Add MCP tool annotations (`readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint`) to every tool so MCP-Apps hosts can auto-run free reads and gate paid/irreversible writes. Free reads are read-only (relay/chain readers flagged open-world); `toon_publish`/`toon_publish_unsigned`/`toon_upload`/`toon_swap` are destructive writes; `toon_channel_close` is destructive, `toon_open_channel` idempotent; config edits are reversible. A load-time guard keeps the matrix consistent with the UI-fireable `WRITE_TOOLS` set.
