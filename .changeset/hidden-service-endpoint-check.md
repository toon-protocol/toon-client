---
'@toon-protocol/client': minor
---

Refuse an endpoint a node advertises that this client has no way to dial.

A node's endpoints are its own strings, and a hidden-service node may publish
absolute `.anyone` ones. The connector URL the payer configured stays
authoritative for reachability — what a node advertises must never redirect a
payer somewhere they did not choose. But a carriage resolved from the
self-description can still point somewhere the configured transport cannot go,
and without a `socksProxy` such an address does not merely fail: the hostname
goes out in a plaintext DNS query first, which is exactly what a hidden service
exists to prevent.

Both the selected carriage's URL and the resolved HTTP endpoint beneath it are
now checked before anything dials, and a hidden-service endpoint on a client
with no `socksProxy` is refused with a `ConfigError` naming the missing proxy
and how to supply it — or to ask the operator for a clearnet endpoint. A client
that does have a proxy dials the published endpoint normally. The check refuses;
it never redirects.
