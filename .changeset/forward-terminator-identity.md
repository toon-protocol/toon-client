---
'@toon-protocol/client': patch
---

Resolve a connector's identity by the destination it TERMINATES, not by whatever endpoint the client happens to be posting to (issue #526).

`ToonClient.publishEvent` used to fetch `GET /ilp/identity` from the posting
edge and seal the packet to that key. That is correct only when the posting
edge also terminates the destination, which stops holding for a forwarded
ILP prefix — the client paid, then was rejected `F01 gift wrap could not be
opened` at the real terminator, since the payload was sealed to the wrong
key.

`ToonClient` now resolves `destination` against every peer discovered via
kind:10032 (not just direct peers — a forwarded prefix's terminator need not
be one), matching against `ilpAddresses`/`ilpAddress` with the longest
(most-specific) claim winning and ties broken toward the address's primary
announcer. It then fetches identity from that announce's `httpEndpoint`.
Falls back to the posting edge when nothing discovered claims the
destination, preserving existing behavior for a destination the posting node
terminates itself.
