---
"@toon-protocol/client": patch
---

Fix BTP/HTTP-ILP clients defaulting `peerId` to the literal string `"client"` when `btpPeerId` is unset — every client collided under the same connector `SessionRegistry` key, making a bound provider unaddressable (connector#736/#743). Both `initializeHttpMode` call sites now default to the client's own `ilpInfo.ilpAddress` instead, with an explicit `config.btpPeerId` still taking precedence.
