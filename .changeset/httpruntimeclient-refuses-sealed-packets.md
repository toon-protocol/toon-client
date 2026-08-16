---
'@toon-protocol/client': patch
---

`HttpRuntimeClient` refuses a sealed packet instead of silently stripping its execution condition (toon-client#588).

`sendIlpPacket` omitted `executionCondition` and `expiresAt` from its parameter type entirely. TypeScript's method-parameter **bivariance** let that satisfy `IlpClient` anyway, so a sealed, condition-bearing packet routed through this transport compiled cleanly and went on the wire with its condition dropped — a swap leg that believes it is hash-locked and is not, visible only at runtime.

Carrying the fields was considered and rejected. This transport does not serialize a PREPARE at all: it POSTs `{destination, amount, data}` as JSON to the connector's `/admin/ilp/send`, and the connector mints the PREPARE on the far side, so there is no field on that wire for either value. Even if the admin body grew them, the endpoint's response is `{accepted, data, code, message}` with no `fulfillment`, so the `sha256(fulfillment) == condition` check that MAKES a sender-chosen condition meaningful — the one `mapIlpResponse` runs on both real transports — could never run here. "Carried" would still mean "unverified": the same lie with more code.

The parameters are now named in the signature via the shared `IlpSendParams`, so bivariance is no longer load-bearing, and a packet that requires them is refused with a `ValidationError` **before any request is made** — so a refused packet costs nothing and spends no claim. Conditions arriving in either representation are normalized through `resolveExecutionCondition` (#586) rather than a third convention.

An absent or all-zero `executionCondition` is the legacy unverified class and is unaffected: ordinary publish/upload writes behave byte-for-byte as before.
