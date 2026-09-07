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
