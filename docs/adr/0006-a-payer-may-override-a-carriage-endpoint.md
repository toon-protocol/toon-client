---
status: accepted
---

# A payer may override a carriage endpoint; it never falls back to one

A connector publishes the **carriage endpoints** its packets are sent to (`httpEndpoint`,
`btpEndpoint`) in its self-description, and the client sends every packet there. A connector that
publishes an absolute endpoint the payer cannot reach (a docker network name, `localhost`, a
tunnel) cannot be paid, even though its client edge answers. So `ToonClient.create` accepts
`carriageEndpoints: { http?, btp? }`, and the CLI `--http-endpoint` / `--btp-endpoint`. Each value
replaces the published endpoint of that carriage only. The self-description, prices, claim state and
seal key are still read from the client edge, and the route's `requiredTransport` still decides
which carriage is used; an override only counts as "this carriage has an endpoint".

## Considered options

- **Fall back to the client edge when a published endpoint is unreachable.** Rejected: the client
  would silently send packets somewhere the operator did not publish, and a failure to reach the
  published endpoint is ambiguous (down, or merely unreachable from here). A payer who knows better
  says so explicitly.
- **Derive one carriage's URL from the other's override.** Rejected: the two carriages share a port
  only by convention, not by contract.

## Consequences

Overrides are validated when the client is created (absolute; `http:`/`https:` for `http`,
`ws:`/`wss:` for `btp`) and pass the same hidden-service reachability check as a published endpoint.
A network failure on an overridden carriage names both URLs.
