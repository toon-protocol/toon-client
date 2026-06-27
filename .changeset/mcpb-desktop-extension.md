---
'@toon-protocol/client-mcp': patch
---

Package the client-mcp server as a Claude Desktop extension (`.mcpb`) and build it automatically on every publish. The same server that ships to Claude Code via the plugin now installs one-click on Claude Desktop (Settings → Extensions). Build locally with `pnpm --filter @toon-protocol/client-mcp mcpb`.
