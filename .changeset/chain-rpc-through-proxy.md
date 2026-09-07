---
'@toon-protocol/client': minor
---

Chain RPC rides the connector's proxy.

When a client is configured with a `socksProxy`, chain RPC now travels through it too — not just
the packets. Reaching a connector inside the overlay while reading chain state on clearnet would
announce the payer's settlement address, from the payer's own IP, timed either side of every paid
request; that leak defeats the only threat model in which a hidden service is worth its latency.
EVM reads and writes join the overlay through an undici dispatcher in viem's `fetchOptions`, and
Solana's JSON-RPC through an injected `fetch`, so channel opens, deposits, closes, settles, wallet
balance reads and wallet transfers are all proxied on both chains.

`proxyRpc: false` opts chain RPC back out, for a payer running their own node on loopback. A
clearnet client is unchanged in every respect. Recorded as ADR 0002.
