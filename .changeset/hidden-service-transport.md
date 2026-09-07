---
'@toon-protocol/client': minor
---

Dial a hidden service through a SOCKS5h proxy, and prove the address never gets
resolved locally.

Config validation could already refuse a misconfigured hidden-service connector;
nothing could yet reach one. `createHiddenServiceTransport(socksProxy)` turns a
single `socks5h://` URL into the three objects that this client's three
consumers each insist on, because no one object serves all three: the client
edge goes through `fetch`, which in Node is undici and takes a **dispatcher** —
it will not accept an `http.Agent`; chain RPC goes through viem, which calls the
*global* `fetch` and offers no seam but `http(url, { fetchOptions })` carrying
that same dispatcher; and the BTP carriage goes through `ws`, which is
`node:http` underneath and takes an `http.Agent` and nothing else. So one SOCKS
connection primitive is wrapped three ways, and the SOCKS5 handshake itself
stays the `socks` package's job. `fetch` returns ordinary global `Response`
objects, not undici's look-alike, because callers do compare against the global
class.

The connect timeout defaults to 120 s rather than the `socks` library's 30 s. A
cold introduction-point circuit routinely takes longer than 30 s, and a
too-short connect timeout reports "slow" as "unreachable" — an error
indistinguishable from a wrong address.

The privacy claim is that a `.anyone` hostname is never resolved locally, and a
mocked transport cannot falsify that. So the tests run against a real minimal
SOCKS5 server that records every CONNECT and distinguishes a request for a
*name* from a request for an *address*: a fetch round trip, a POST carrying its
body and headers, a websocket round trip, the viem-style dispatcher path, and a
refusal — not a hang — when the proxy cannot reach the destination. Every one of
them asserts the destination arrived at the proxy as a name. A client that
resolved locally would record an address, and could not accidentally pass.

The factory is Node-only, so it ships as its own entry point,
`@toon-protocol/client/hidden-service`. The library barrel exports only its
types: re-exporting the factory would drag `node:module` into every browser
bundle of this package. `undici` and `socks` join `ws` as optional dependencies,
loaded through guarded dynamic `require`s and marked external, so a consumer who
never touches a hidden service neither installs them nor bundles a second HTTP
stack.

`undici` is pinned to `^7`, and the major is load-bearing rather than
incidental. Node's global `fetch` hands the dispatcher a handler that its *own*
bundled undici defines, and that handler changed shape: Node 22 passes the old
`onConnect`/`onHeaders` one, Node 26 the new `onRequestStart` one. undici 7
accepts both; undici 8 dropped the old shape, and under it every request through
the dispatcher fails on Node 22 with `invalid onRequestStart method`.
