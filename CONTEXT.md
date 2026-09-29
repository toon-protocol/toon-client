# TOON Client

The payer. This package seals an HTTP request into a packet addressed to a route, attaches a
signed voucher on an x402 `batch-settlement` channel the user opened on chain, and returns the
app's HTTP response. It never validates a claim — that is the connector's job, and only the
connector's.

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
addresses, sealing key, x402 channel terms (`batchSettlements`), routes, endpoints. It replaces peer discovery entirely.
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

**Payment channel**:
An x402 `batch-settlement` channel: a deposit the payer locks on chain, payable one way to one
connector — x402's contract on Base, solana-foundation's `payment-channels` program on Solana. The
only kind of channel there is (connector ADR 0075).
_Avoid_: toon-channel, TokenNetwork channel

**Claim**:
What a packet carries as its payment, in the `ILP-Payment-Channel-Claim` header or BTP's
`payment-channel-claim` entry. Every claim is a **voucher**; the connector refuses anything else.
_Avoid_: Payment, receipt, proof

**Voucher**:
A signed statement of a channel's cumulative total. It has no nonce, so a connector orders
vouchers by amount alone, and each one supersedes the last.
_Avoid_: Balance proof

**Facilitator**:
An x402 service that submits a payer-authorized Base deposit and pays its gas, so opening a
channel costs the payer no native gas. On Solana the connector itself sponsors the open instead.
_Avoid_: Relayer, onboarder (except as the devnet deployment's name)

**Watermark**:
The cumulative amount a channel's latest voucher reached. The payer keeps one; the connector keeps
its own, which decides, and reports it through `claim-state`.
_Avoid_: Nonce, balance

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

**Hidden payer**:
A client that sends every byte (client edge, BTP socket and each chain's RPC) through a SOCKS5h
proxy to hide its *own* address, whatever the connector is. Configured by a `socksProxy` beside a
clearnet connector (TOON_Network#167).
_Avoid_: Anonymous client, private payer
