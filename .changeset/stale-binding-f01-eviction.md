---
'@toon-protocol/client': patch
---

Evict a stale peer→channel binding when the connector refuses the claim drawn on it (toon-client#581).

**A refused claim now retires the binding that produced it.** #578/#580 stop a cached channel being resumed when its recorded counterparty disagrees with what the destination announces today. That check is a PREDICTION: it cannot see a record whose recorded counterparty happens to look current. A node that keeps its settlement address but loses its channel state — a wiped connector, a restored-from-backup box, a redeployed contract — passes it and then refuses every paid write with `F01 - claim rejected: names a channel this connector has no record of`. Both `rig` and the MCP daemon hit exactly that, and the only recovery was hand-editing `~/.toon-client` JSON.

The reject is the connector's own answer, so it now drives the recovery: `ToonClient.sendPaidPacket` (behind `publishEvent` and `sendSwapPacket`) calls the new `ChannelManager.evictBinding`, which supersedes the binding — archived, so any on-chain deposit stays reclaimable, and the channel stays tracked so close/settle still work — then re-resolves and retries the write ONCE. Re-resolution goes through the ordinary `ensureChannel` path, so it reuses an existing channel where one survives and never forces a fresh on-chain open.

Deliberately narrow, because a false positive costs a channel while a false negative costs one failed write: only the unknown-channel flavour of `F01` triggers it (a nonce-race `F01` names a HEALTHY channel and any mention of a nonce vetoes the match), only when the reject can be attributed to the channel just used, only on the auto-claim path, and never twice for one write.
