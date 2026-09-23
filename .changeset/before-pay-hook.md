---
'@toon-protocol/client': minor
---

`SendOptions` gains `beforePay`, a synchronous last look that runs **after the route's price is resolved and before anything is signed**: returning a string refuses the send with a new `BeforePayRefusedError` carrying that reason, returning nothing lets it proceed, and a throw from the callback propagates unchanged.

A paid route bills for an *answer*, and a refusal is an answer. The connector collects the route's price before the app behind it has seen the request at all, so a body the app was always going to reject is still charged in full and nothing is refunded — on 2026-09-23 a tenant sent one wrongly-enveloped request to a paid route and paid a whole lease interval to be told it was malformed (TOON_Network#115). This client stays the payer and only the payer: it learns nothing about any app's body shapes, and gains instead the one check a caller cannot write for itself.

Checking before calling `send()` is not the same check. The price is resolved inside `send()` — a metered route charges by the size of the *sealed* payload, which does not exist until the request has been sealed — and only there is the refusal guaranteed to precede `signBalanceProof`, which advances and persists the channel's watermark before the packet leaves and whose rollback deliberately does not restore the nonce. A signed claim is a bearer instrument; there is no unsigning one.

The hook is called exactly once per `send()`, including on the bounded stale-channel retry, because it is a decision about the request rather than about an attempt at it. It runs on a free (zero-priced) route too: money is not the only thing a wrong request spends. Nothing changes for a caller that does not pass it.
