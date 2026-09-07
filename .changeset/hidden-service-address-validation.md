---
'@toon-protocol/client': minor
---

Refuse a misconfigured hidden-service connector at construction, in a message
that names the fix.

A connector can be deployed as an Anyone Protocol hidden service, addressed as
`<label>.anyone`. Pointing this client at one used to fail — but only after
`fetch` had asked the operating system where that host lived, putting the
address into a plaintext DNS query. The naive attempt leaked the one thing the
address exists to withhold, and then failed anyway. So every check below now
runs in `resolveConfig`, before a single byte or lookup leaves the process, and
costs nothing rather than a signed claim.

`ToonClientConfig` gains `socksProxy` — a `socks5h://` URL naming a running
`anon` daemon's SOCKS port — and `proxyRpc` (default `true`), which records
whether chain RPC should ride that same proxy. Resolution stays synchronous and
browser-safe: it validates and records, and builds nothing.

- A `.anyone` connector with no `socksProxy` is refused, naming the proxy to set
  and that the `toon` CLI can start a daemon for you.
- A `socksProxy` against a clearnet connector is refused too. Nothing would ride
  it, and the payer would believe they were anonymous when they were not.
- `socks5://` is refused in favour of `socks5h://`. The `h` is what makes the
  *proxy* resolve the hostname; without it the client resolves locally first,
  which is the leak this feature exists to close.
- `.anon` is refused with the corrected `.anyone` address in the message. The
  daemon treats that TLD as clearnet and fails far from the typo.
- `.onion` is refused plainly: this client dials the Anyone Protocol, not Tor,
  and there is no flag that changes it.
- Plain `http://` is accepted for a hidden-service host, because no CA can
  certify one and the overlay authenticates the endpoint itself.
- The per-packet timeout defaults to 120 s for a hidden-service connector rather
  than the clearnet 30 s, since a cold circuit can take tens of seconds before
  the connector has seen a byte.

The `.anyone` pattern and `socks5h://` parsing are now one pure, browser-safe
module exported from the package root, so config validation, endpoint checking
and the CLI all agree on what an address is.
