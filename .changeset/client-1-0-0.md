---
'@toon-protocol/client': major
---

**1.0 — a pure TOON client.**

`@toon-protocol/client` now does one thing: it pays a TOON connector for HTTP
requests. You give it a destination and a request; it seals that request into an
ILP packet, attaches a signed claim on a payment channel you opened on chain, and
returns the app's HTTP response. It ships as a library and as the `toon` CLI.

**The paid-write API is now `send()`, and it is HTTP-shaped.** `publishEvent`
took a Nostr event; `send(destination, { method, target, headers, body })`
returns a `SendResult` you branch on — `fulfilled: true` carries the app's
status, headers and body; `fulfilled: false` carries the reject code and, on an
underpayment, the route's price. Rejects are returned, never thrown.

**Removed:** all Nostr and relay logic (event signing, relay subscriptions,
kind:10032 peer discovery, NIP-59 unwrapping, the render trust gradient,
kind:5094 blob storage), the rolling-swap client, the h402 paid-fetch engine,
serve-side job handling, and Mina — which the Rust connector refuses outright as
a settlement chain. Also removed: the `./render` subpath export, and the
`@toon-protocol/core` and `@toon-protocol/sdk` dependencies. Settlement is EVM
and Solana.

**Bootstrapping is one `GET`.** A connector's addresses, endpoints, sealing key,
settlement chains and route prices now come from its own self-description, which
this client reads from the `connector` URL you configure. There is no relay to
subscribe to and no peer list to seed.

**Solana claims sign a different message.** Per connector ADR 0053 the balance
proof is now 96 bytes and binds the settlement program id, so claims signed by
0.x are refused by both the connector and the on-chain program. Nothing to do
beyond upgrading; the client signs the new form.

**Key derivation moved, and your existing keys did not.** A mnemonic now derives
its EVM key at the standard `m/44'/60'/0'/0/0`, so the wallet can be imported
into MetaMask or a hardware wallet. Keystores written before 1.0 record no
derivation scheme and are read as `legacy` — the old `m/44'/1237'/0'/0/0` path —
so existing addresses, and the channels funded at them, do not move. Pass
`keyDerivation: 'legacy'` to derive the old way from a bare mnemonic.

**A route priced at zero takes no channel.** A connector states a free route rather than implying
one, and a free route runs no claim gate — so `send()` no longer opens a channel, signs a claim or
touches a chain to use one, and the result's `claim` is absent rather than zero-valued. That makes
a free route usable by a client holding no funds at all.
