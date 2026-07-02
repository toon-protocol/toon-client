---
'@toon-protocol/rig': minor
---

Persist the peer→channel mapping so standalone rig reuses payment channels across invocations (#262). Paid commands now record the channel they lazily open in `TOON_CLIENT_HOME/rig-channels.json` (keyed by identity pubkey + peer destination + chain + tokenNetwork) and RESUME it on the next run — `trackChannel` rehydrates the cumulative-claim watermark from the client's `channels.json` — instead of opening (and funding) a fresh on-chain channel per CLI invocation. A corrupt map file refuses the paid operation before anything is opened. New free command: `rig channel list [--json]` shows recorded holdings (peer, chain, channel id, deposit, cumulative claimed, withdraw status).
