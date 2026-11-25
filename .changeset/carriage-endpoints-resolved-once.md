---
'@toon-protocol/client': major
---

Carriage endpoints are resolved in one place, and a paid packet never goes to a guessed URL. When the connector publishes no `httpEndpoint` and no HTTP override is set, there is no HTTP fallback beneath BTP (the invented `${connector}/ilp` is gone). Removed: `HttpIlpClient.upgradeToBtp`, `httpEndpointToBtpUrl`, `HttpIlpClientConfig.createWebSocket` and `BtpRuntimeClient.sendClaimMessage`.
