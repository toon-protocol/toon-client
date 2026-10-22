---
status: accepted
---

# A payer may override a carriage endpoint; it never falls back to one

Under connector ADR 0050 the self-description is the source of truth, and the client sends every
packet to the carriage endpoint it publishes. A connector that publishes an absolute endpoint the
payer cannot reach (a docker network name behind `docker run -p`, `localhost`, a tunnel, a port
forward, a wrong `[node]`) is therefore unpayable, even though its client edge answers (#753). A
connector that publishes a relative endpoint already works everywhere, so this only bites a payer
who cannot get the operator to fix it. For that payer, `ToonClient.create` takes an explicit
**carriage endpoint override**, `carriageEndpoints: { http?, btp? }`, and the CLI takes it as
`--http-endpoint` / `--btp-endpoint` (`TOON_HTTP_ENDPOINT` / `TOON_BTP_ENDPOINT`). An override
replaces the published URL for its carriage and nothing else. The self-description stays the truth
everywhere the payer did not say otherwise.

## Considered options

- **Wontfix under ADR 0050**, leaving the payer to rewrite URLs in an injected `fetch` /
  `createWebSocket`. Rejected: the payer rarely controls the connector, and that workaround is
  possible but obscure and has to be built separately for each carriage.
- **Automatic fallback** to the client edge's origin when the published endpoint cannot be
  reached. Rejected: it is implicit, it sends paid packets to an address the operator never
  published, and it turns one wrong endpoint into a slow failure followed by a silent retry.
- **A single `endpoint`** from which the BTP URL is derived. Rejected: it cannot express a
  connector that serves BTP on a different host or path.

## Consequences

- An override moves only where packets go. The self-description, route prices, claim state and
  the seal key are still read from the client edge.
- An override counts as an available endpoint when the carriage is chosen, but `requiredTransport`
  still decides which carriage that is. An override never makes a route accept a carriage it
  refuses, and an override that goes unused is not an error.
- The HTTP override also applies to the HTTP fallback under a BTP session.
- Overrides must be absolute, with a scheme that matches the carriage (`http(s):` / `ws(s):`).
  A relative override is a `ConfigError`, because a relative published endpoint already means "on
  the client edge".
- The hidden-service reachability check applies to an override exactly as it does to a published
  endpoint. Mixing a clearnet override with a `.anyone` client edge, or the reverse, is allowed.
- A failure on an overridden carriage names both the override and the published endpoint.
