---
'@toon-protocol/client': patch
'@toon-protocol/client-mcp': patch
---

Tolerate the 2-part `evm:{chainId}` chain-key form some connectors advertise (e.g. `evm:31337`), not only the canonical 3-part `evm:{network}:{chainId}`.

`parseChainId` (`OnChainChannelClient`) and the chainId-from-chainKey parsing in `ToonClient` (peer negotiations + `getChainContext`), `client-mcp/config`, and `apex-discovery` now accept both forms. A mis-parsed 2-part key previously produced `chainId: 0`, which the store connector rejects ("Invalid chainId").
