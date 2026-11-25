---
'@toon-protocol/client': major
---

One carriage module delivers a packet, with or without a voucher, and returns one of four outcomes: answered, refused, greeting or unknown. Greetings are returned, not thrown: `PaymentRequiredError` and `TransportRequiredError` are removed from the public interface and nothing throws them (`send()` returns `code: 'PAYMENT_REQUIRED'` / `'TRANSPORT_REQUIRED'` as before, and a node that publishes no endpoint for the carriage a route needs now returns `TRANSPORT_REQUIRED` rather than throwing). A greeting over BTP now carries `code: 'PAYMENT_REQUIRED'` or `'TRANSPORT_REQUIRED'` instead of the wire's `F06`/`F02`. `HttpIlpClient` returns a `402` carrying terms as a refusal with `paymentRequired` set and no `code`, and `selectTransport` returns `{ kind: 'unavailable' }` instead of throwing. Removed: the `IlpClient`, `ClaimSendingTransport`, `OrderedBtpSession` and `PaidWriteTransport` interfaces.
