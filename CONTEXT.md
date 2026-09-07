# TOON Client

The payer. This package seals an HTTP request into a packet addressed to a route, attaches a
signed claim on a payment channel the user opened on chain, and returns the app's HTTP response.
It never validates a claim — that is the connector's job, and only the connector's.

## Language

### The nodes

**Connector**:
A paid reverse proxy that fronts an ordinary HTTP app, charges a flat price per route, and hands
that app a request that was already paid for.
_Avoid_: Proxy, relay, gateway, node

**Route**:
An ILP address prefix a connector serves, with a price attached. Longest matching prefix wins.
_Avoid_: Endpoint, path

**Self-description**:
The single document a connector answers a free, unauthenticated `GET` on its client edge with —
addresses, sealing key, settlement terms, routes, endpoints. It replaces peer discovery entirely.
_Avoid_: Manifest, greeting, announcement, discovery

**Client edge**:
The URL a payer configures and dials to reach a connector.
_Avoid_: Base URL, API endpoint

### The wire

**Packet**:
A sealed request addressed to a route, carrying ILPv4 semantics in TOON's own encoding.
_Avoid_: Message, envelope, frame

**Carriage**:
The transport a packet rides: `http` (`POST /ilp`) or `btp` (a WebSocket session). A connector may
insist on one.
_Avoid_: Transport, protocol, channel

**Claim**:
A signed balance proof on a payment channel, attached to a packet as its payment.
_Avoid_: Payment, receipt, voucher, proof

**Refusal**:
A connector's rejection of a packet. It is *returned*, never thrown — anything this client throws
happened before the packet went out, or on chain.
_Avoid_: Error, rejection, failure

### Reachability

**Hidden service**:
A connector reachable only inside an anonymity overlay, by an address the public DNS cannot
resolve and no CA can certify. Abbreviated **HS**.
_Avoid_: Onion service, dark node, private connector

**HS address**:
A `<label>.anyone` hostname routed by the `anon` daemon of the [Anyone
Protocol](https://github.com/anyone-protocol). The `.anon` TLD is *not* one: `anon` treats it as a
clearnet name and fails. `.onion` is not one either — that is Tor, which this client does not dial.
_Avoid_: Onion address, .anon address, hidden address

**Clearnet**:
The ordinary, publicly-resolvable internet — everything that is not reached through the overlay.
_Avoid_: Public internet, mainnet, the open web

**SOCKS5h proxy**:
The local port an `anon` daemon listens on, through which every HS byte travels. The trailing `h`
is load-bearing: it means the *proxy* resolves the hostname, so an HS address never leaks into a
local DNS query.
_Avoid_: SOCKS proxy, socks5, the proxy
