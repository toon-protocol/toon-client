---
"@toon-protocol/client": patch
---

Fix `publishEvent`/`sendSwapPacket`/`sendPayment` still getting `402 Payment Required` on a live devnet relay whose kind:10032 announce carries NO `requiredTransport` field at all — #559's guard reads only the announce, and the field turns out to appear only in the connector's `402` response, once a write has already been posted over HTTP-ILP. `HttpIlpClient` now recognizes a `402` whose x402 challenge `accepts[].extra.requiredTransport` (or the entry's top level) is `"btp"` and throws a new `Http402RequiresBtpError` instead of a generic transport error; `ToonClient` retries that one write over its BTP uplink when one is configured, or throws the same `BTP_REQUIRED` error the announce-based guard already throws when it is not. The announce-based guard from #559 is untouched and still fires first when a connector does announce the field.
