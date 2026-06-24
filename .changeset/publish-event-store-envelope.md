---
"@toon-protocol/client": patch
"@toon-protocol/client-mcp": patch
---

Fix `ToonClient.publishEvent` to send the HTTP `POST /write` store envelope on the payment-proxy path.

The deployed connector is a payment-proxy that terminates paid writes as HTTP-in-ILP: it decodes the ILP PREPARE `data` as a literal HTTP/1.1 request and reverse-proxies it to the relay store's `POST /write`. `publishEvent` previously sent the bare TOON-encoded event as `data`, which has no request-line, so the proxy rejected every paid write with `F01 - Invalid HTTP envelope: malformed request-line`. The high-level `publishEvent` / daemon `/publish` / `uploadMedia` / blob-storage paths (which all funnel through `publishEvent`) were therefore broken against the live store.

`publishEvent` now wraps the signed event in a `POST /write HTTP/1.1` envelope carrying `{"event": <signed event object>}` as the JSON body (the shape the store's `/write` handler verifies and stores). A shared `buildStoreWriteEnvelope` helper is exported from `@toon-protocol/client`. The TOON encoding is still used to price the write; `sendSwapPacket` (Mill swaps, a raw-TOON contract) is intentionally left unwrapped.

Also fixes the `client-mcp` `e2e/devnet.ts` apex destination: `g.proxy` F02s ("No route"); the routable store address is `g.proxy.relay.store`.
