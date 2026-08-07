---
'@toon-protocol/client': patch
'@toon-protocol/client-mcp': patch
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

**Fix-up (issue #533, PR #531 review):** two follow-on defects in the above.

1. A discovered announce's `ilpAddresses` array can legitimately claim a
   prefix (e.g. a router announcing `g.toon`) that a DIFFERENT node — never
   discovered, or whose own more-specific announce simply expired — actually
   terminates (e.g. the store at `g.toon.ario`). The `.`-separated ANCESTOR
   match alone used to be enough to make that router a candidate terminator
   for a prefix it does not own. An ancestor (non-exact) match is now only
   trusted when the peer used the pre-Epic-7 legacy form (a single
   self-declared `ilpAddress`, no `ilpAddresses` array) — Epic-7's
   `ilpAddresses` lists every address a peer is reachable AT ("one per
   upstream peering"), a routing fact, not a namespace-ownership claim.
2. Once a discovery tracker exists, a destination none of its discovered
   peers claims now throws a distinct `TERMINATOR_UNRESOLVED` `ToonClientError`
   instead of silently falling back to the posting edge — refusing to
   publish beats sealing a payload to a key that cannot open it. This
   includes a tracker that has discovered zero peers: that is not evidence
   the posting edge terminates the destination, only the absence of evidence
   that anything does, and it is a live production window (not a
   theoretical one) since a started client always constructs a discovery
   tracker — a tracker reporting zero peers is exactly what the startup race
   looks like before the first announce lands. Only the no-tracker-at-all
   fallback, for a client that never wired up discovery, is unchanged: it is
   still the common single-node case this client has always supported, and
   carries no discovery signal at all to fail closed on.

`@toon-protocol/client-mcp` is bumped alongside `client` because it inlines
`client` at build time via a `devDependency` (tsup `noExternal`), and
changesets does not release a dependent through a `devDependency` — the same
gap that shipped 0.36.5's stale genesis seed and needed a second bump for
`#527`.
