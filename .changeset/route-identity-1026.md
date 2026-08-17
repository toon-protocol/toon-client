---
'@toon-protocol/client': minor
---

Seal to the connector that terminates the destination, not the edge that answers (connector #1026). `ConnectorEdgeClient.getIdentity(endpoint, { destination })` now asks `GET /ilp/identity?destination=` and, when the connector answers a `routeIdentity` — the terminating connector's own signed statement over `(prefix, key)`, relayed by a forwarding edge — verifies it against the key it names and seals to that key. `ToonClient.publishEvent` and `Http402Client` both ask for the destination. A statement that does not verify or does not cover the destination is refused (`ROUTE_IDENTITY_INVALID`), never fallen back from; a connector that offers none answers exactly as before. New `wire/route-identity.ts` is the byte-for-byte twin of the Rust `connector_signer::route_identity`, pinned by a Rust-signed vector.
