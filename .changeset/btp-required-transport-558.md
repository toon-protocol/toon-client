---
"@toon-protocol/client": patch
---

Fix `publishEvent`/`sendSwapPacket`/`sendPayment` posting a paid write over HTTP-ILP to a terminating connector whose kind:10032 announce declares `requiredTransport: "btp"`, which the connector rejects with `402 Payment Required`. The `requiredTransport` field is read directly off the raw announce content (the installed `@toon-protocol/core`'s `parseIlpPeerInfo` drops it, the same gap `notice` hit) via a new `DiscoverySubscription.requiredTransportFor`. When the resolved terminator for a destination requires BTP, the paid-write transport now routes over the client's BTP uplink exclusively, throwing a clear `BTP_REQUIRED` error instead of retrying HTTP when no BTP uplink is configured at all.
