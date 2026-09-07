---
'@toon-protocol/client': patch
---

Fix a packet expiring at the same instant the client stops waiting for it.

A packet's expiry was `now + timeoutMs` — the very moment the client's own request
aborts. The two numbers were the same, and on clearnet nothing showed, because both
are far longer than a round trip. They are not the same thing, though, and the
difference is money. A late answer arrived to a client that had stopped listening,
against a packet that had just expired, *after* a claim had been signed for it: paid,
with no verdict. The expiry is also stamped when the packet is built, so any time
spent getting the bytes onto a slow carriage is spent out of the packet's own life
before the connector has seen a byte.

Packet expiry now sits `PACKET_EXPIRY_HEADROOM_MS` (15 s, exported) beyond the client
timeout, so the client is always the first of the two to give up: whatever it stops
waiting for is still, briefly, a live packet the connector can answer and this client
can reconcile. An explicitly supplied `expiresAt` is untouched — neither extended nor
clamped, because a caller who names a deadline has one.

This is a latent bug on every carriage, and it affects every payer — including everyone
who will never send a packet anywhere but clearnet. Nothing on the wire changes: no new
packet fields, and no change to sealing, claims or pricing.
