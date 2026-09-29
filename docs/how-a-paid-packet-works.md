# How a paid packet works

`send()` does all of this for you. It is spelled out because every step shows up in what comes
back, and because each piece is exported for anyone forming a packet by hand.

A packet is an **OER envelope, gift-wrapped to the identity of the connector that terminates the
destination**, carrying a **signed voucher** that pays for it. The answer's fulfilment is **derived
from the secret inside that wrap**, so the sender can check a delivery end to end without anything
on the packet committing to it. Nothing on the wire is HTTP text.

## The packet is ILPv4's semantics in TOON's encoding

The three type bytes, the remaining field order and meanings, and the `F`/`T`/`R` reject taxonomy
are RFC 0027's. **The bytes are not**, deliberately, and never have been. It diverges in exactly
four places:

1. **No outer type-length wrapper.** The type byte is followed by the fields inline, not by a
   `VarOctetString`.
2. **`amount` is a `VarUInt`**, not a fixed 8-byte `UInt64`.
3. **`expiresAt` is a 19-byte GeneralizedTime**, `YYYYMMDDHHMMSS.fffZ`, not RFC 0027's 17-byte
   Interledger Timestamp.
4. **There is no `executionCondition`.** A one-byte `greeting` flag sits where RFC 0027's 32-byte
   condition would be — connector ADR 0069, which removed the field rather than shrinking it. The
   fourth is not an encoding quirk like the first three: it drops a field the RFC requires.

So an off-the-shelf ILPv4 encoder does not produce a packet this edge accepts. The bytes are
pinned by the connector's committed wire vectors, which this client replays as its own
conformance suite — see [development.md](development.md#wire-vectors).

```text
PREPARE  0x0c ‖ VarUInt(amount) ‖ expiresAt(19) ‖ greeting(1)
              ‖ VarOctetString(destination) ‖ VarOctetString(data)
FULFILL  0x0d ‖ fulfilment(32) ‖ VarOctetString(data)
REJECT   0x0e ‖ code(3) ‖ VarOctetString(triggeredBy)
              ‖ VarOctetString(message) ‖ VarOctetString(data)
```

Canonical `VarUInt`, and no trailing bytes: a packet with either is refused rather than read
leniently.

## Step 1 — ask the connector who it is

A packet cannot be formed without the terminating connector's public key, and there is no default
to fall back on: sealing to the wrong key is a confidentiality failure that merely *presents* as
an undeliverable packet. A connector answers when asked and never announces, so the key is read
straight off the client edge you are already sending to.

```ts
const description = await client.describe();
description.edgeIdentity?.publicKey;   // '0x04…', uncompressed secp256k1, 65 bytes
description.batchSettlements;          // per chain, the x402 channel terms a payment is made under
description.routes;                    // prefix, price and — where the route pins one — its carriage
description.requiredTransport;         // the node-wide summary, set only when its own addresses agree
```

One free `GET /ilp` carries all of it, and `describe()` caches it per client; pass
`{ fresh: true }` to re-read. A key of the wrong length, without the `0x04` tag, or not `0x`-hex
is refused rather than carried forward — there is no best-effort reading of a public key. An
unreachable edge raises `NetworkError` instead, so "will not seal to that" and "could not ask"
are never confused.

## Step 2 — ask the route what it costs

There is no per-byte rate to multiply. A price is **flat per handler** — one handler, one price,
and an app that wants to charge differently exposes more handlers — so the route table *is* the
price list, and only the connector can state it.

```ts
const price = await client.price('g.toon.store'); // 1000n base units (0.001 USDC), or null
```

`null` means the connector serves no route matching that destination. That is an answer, not a
failure, and it is distinct from the `NetworkError` an unreachable edge raises; `send()` raises
`RouteNotPricedError` on it before any packet exists. This is the same longest-prefix lookup the
claim gate charges against, so it cannot quote a price a real request would not be charged.

To learn what a path *beyond* this connector costs, send a probe: a packet sent in the
expectation that it will be refused, so the refusal can state the cost.

```ts
const { accumulatedCost } = await client.probe('g.toon.store');
```

A probe traverses for free, so it is accepted only from a sender the connector recognizes by a
payment channel, and only within a rate limit. It is never delivered to a route the connector
terminates: free traversal does not also buy the work.

## Step 3 — seal the envelope and keep what opens the answer

`sealExchange` produces the wrap, the secret and the fulfilment to expect in one call, because
getting any of them separately wrong is silent: opening the answer with the wrong secret fails, and
checking a delivery against the wrong preimage throws away a packet that was genuine — and paid for.

```ts
import { sealExchange } from '@toon-protocol/client';

const exchange = sealExchange(
  {
    method: 'POST',
    target: '',                                   // '' and '/' both address the handler itself
    headers: [['content-type', 'application/json']],
    body: new TextEncoder().encode(JSON.stringify({ hello: 'world' })),
  },
  description.edgeIdentity.publicKey
);

exchange.data;          // Uint8Array — the gift wrap, to carry as the PREPARE's `data`
exchange.sharedSecret;  // Uint8Array(32) — keep it; nothing else opens the answer
exchange.fulfillment;   // Uint8Array — the preimage the connector will return
```

**The envelope**, inside the wrap:

```text
0x01 ‖ method ‖ target ‖ VarUInt(headerCount) ‖ headerCount × (name, value) ‖ body
```

It is a description of an HTTP message, not an HTTP message: the app is handed ordinary HTTP, but
nothing on the wire is text to be parsed. `target` is resolved strictly *beneath* the route's own
configured handler path and can never replace it — `''` and `'/'` both address the handler, and
an absolute path, a `..` segment, a scheme, an authority or a percent-encoded equivalent of any
of those is refused `F00` before the app is called. That is what keeps "one handler, one price"
true in the presence of a sender-chosen target.

**The gift wrap**, around it:

```text
request   0x01 ‖ ephemeralPublicKey(65) ‖ nonce(12)
               ‖ ChaCha20-Poly1305(sharedSecret(32) ‖ envelope)
response  0x02 ‖ nonce(12) ‖ ciphertext
```

Keys are HKDF-SHA256 with no salt, over the ECDH X coordinate for the request
(`toon-giftwrap-request`), and over the shared secret for the response
(`toon-giftwrap-response`) and the fulfilment (`toon-giftwrap-fulfillment`).

**There is no execution condition.** The PREPARE used to carry a 32-byte `executionCondition`;
connector ADR 0069 removed it from the wire, leaving a one-byte `greeting` flag in its place. The
field was invariant across every hop and distinctive per packet — a perfect key for two hops to
join their logs on — while buying no hop anything, since a hop is paid on arrival and a
termination's own check was a tautology over the secret it had just opened.

What replaces it is the check that was always the only one worth making, and is now the **only
fulfilment check made anywhere on the path**: the sender compares what came back against the
fulfilment its own secret derives.

```ts
import { deriveFulfillment } from '@toon-protocol/client';

deriveFulfillment(exchange.sharedSecret); // === exchange.fulfillment
```

Pass it to a transport as `expectedFulfillment` and a FULFILL carrying anything else is returned as
a failed packet, never retried. `ToonClient.send` does this for you.

The terminating connector opens the wrap, recovers the same secret and derives the same preimage —
**the app behind the route supplies nothing and holds no key**, which is what keeps "any HTTP
service can be an app" true. Never reuse a secret for a second packet.

## Step 4 — attach the voucher that pays for it

The packet carries the voucher that pays for it, rather than the payment trailing behind. Nothing
is ever owed between packets, so there is no window for either side to walk away inside.

Every claim is an x402 `batch-settlement` **voucher** (connector ADRs 0074, 0075): a JSON object
naming the channel and its new cumulative total, signed by the channel's voucher signer. The EVM
vector's shape, signature shortened:

```json
{
  "blockchain": "evm",
  "channelConfig": { "payer": "0x…", "payerAuthorizer": "0x…", "receiver": "0x…",
                     "receiverAuthorizer": "0x…", "salt": "0x…", "token": "0x…",
                     "withdrawDelay": 86400 },
  "channelId": "0x…",
  "maxClaimableAmount": "5000",
  "messageId": "…",
  "scheme": "batch-settlement",
  "senderId": "0x…",
  "signature": "0x…",
  "timestamp": "2030-01-01T00:00:00.000Z",
  "version": "1.0"
}
```

`maxClaimableAmount` is **cumulative**, not per-packet: each voucher supersedes the last, so a lost
voucher costs nothing and a replayed one gains nothing. There is no nonce — the connector orders
vouchers by amount alone. On Base the signature is EIP-712 under x402's own domain; on Solana it is
Ed25519 over a fixed-layout message naming the channel account and the amount, and the claim names
the channel account as `channelId`. A route priced at zero carries no voucher at all.

The exact bytes of both are pinned by the vectors' `claim_voucher` section, not by this page.

Where it rides:

| Carriage | How the voucher travels |
| --- | --- |
| HTTP | header `ILP-Payment-Channel-Claim: base64(JSON)` |
| BTP | a protocolData entry named `payment-channel-claim`, raw UTF-8 JSON, no base64 layer |

`senderId` rides the wire but carries **no authority**: the connector checks the signature against
the voucher signer the channel itself records on chain. A voucher has no say in what it is checked
against.

## Step 5 — the connector's gate

The connector — and only the connector — validates the voucher. This client never re-implements
that check. What a payer needs to know of it:

- **It must advance.** The cumulative amount must exceed the connector's watermark for the channel
  by at least the route's price. One that does not is refused, and the refusal's message says how
  far it advanced — which is how this client re-prices its next voucher.
- **It must verify** against the channel's recorded voucher signer.
- **It must be covered.** The cumulative amount must not exceed what the channel holds. Over it,
  the packet is refused with cost `0`; top the channel up and send again.
- **A `toon-channel` claim is refused outright.** That scheme was retired by connector ADR 0075.

Each failure has its own code. [errors.md](errors.md) maps every one to what you do about it.

## Step 6 — the answer, opened with the same secret

Whatever comes back — a FULFILL or a REJECT — is read by one function, which needs the secret from
step 3 and nothing else:

```ts
import { readExchangeOutcome, envelopeHeader } from '@toon-protocol/client';

const outcome = readExchangeOutcome(sent, payload, exchange.sharedSecret);

switch (outcome.kind) {
  case 'answered':
    outcome.response.status;                          // any status; a non-2xx is still paid
    outcome.response.headers;                         // readonly [name, value][]
    outcome.response.body;                            // Uint8Array
    envelopeHeader(outcome.response, 'content-type'); // case-insensitive lookup
    break;
  case 'destination-refused':  // provable: only the termination could have sealed this
    outcome.code, outcome.message, outcome.detail;
    break;
  case 'path-refused':         // unauthenticated by construction — a hint, not a verdict
    outcome.code, outcome.message;
    break;
}
```

`send()` returns this as `SendResult`: `fulfilled: true` with the opened response, or
`fulfilled: false` with `refusedBy` set to `'destination'`, `'path'` or `'edge'`.

A FULFILL that is not a readable sealed response throws `SealedResponseError`, whose `kind` is
`'not-sealed'`, `'unopenable'` or `'malformed-envelope'`. Value moved, so bytes that are none of
those mean a broken counterparty rather than an outcome to invent.

**A reject raised short of the termination is plaintext, and that is distinguishable.** Only the
terminating connector holds the shared secret, so only it can seal a refusal; a hop refusing for
no route, expiry or a cap shares no secret and cannot seal anything. A reject whose `data`
actually *opens* under this packet's secret is therefore proof the destination said no. The
converse does not hold: an unsealed reject identifies nobody, because a termination that never
recovered the secret also answers in plaintext. Sealed identifies the destination; unsealed
identifies nobody.

## What rides beside the packet

`accumulatedCost` is not part of the packet encoding. It travels alongside, and only on a REJECT:

| Carriage | Where |
| --- | --- |
| HTTP | response header `toon-accumulated-cost`, decimal `uint64` |
| BTP | protocolData entry `toon-accumulated-cost`, decimal UTF-8 text |

It is one figure — every hop's flat fee, plus the price of the route that terminated — never a
breakdown and never a fee-versus-price split. It is `0` when nothing was traversed and nothing
terminated. The one refusal that reports a non-zero figure without doing any work is an
**underpayment**, where it is the route's price: the cheapest way to learn what a route costs,
since the refusal's whole subject is the figure you did not cover.

The connector also states, to the app and to nobody else, what it verified: `X-TOON-Payer`,
`X-TOON-Amount` and `X-TOON-Chain`, taken from your voucher. Your own spelling of those three
header names inside the sealed envelope is removed on every delivery.

## The two carriages

Both carry the same packets through the same gate; a request that arrived over BTP is
indistinguishable downstream from one that arrived over HTTP.

- **ILP-over-HTTP** — `POST /ilp`, body `application/octet-stream`. One-shot and stateless. An
  ILP-level outcome is always HTTP `200`; a non-2xx is a transport failure and never carries a
  packet body.
- **BTP** — `GET /ilp/btp`, websocket upgrade, binary frames:

  ```text
  frame  = type(u8) requestId(u32) body
  body   = pdCount(u8) pd* ilpLen(u32) ilpPacket        ; MESSAGE(6) / RESPONSE(1)
  pd     = nameLen(u8) name contentType(u16) dataLen(u32) data
  ```

  The session opens with an `auth` entry (`{ peerId, secret }`) answered by an empty RESPONSE.
  When this client already holds a channel with the node, the entry also carries a
  `channelChallenge` — the signed voucher claim-state challenge — binding the session to that
  channel (the vectors' `client_auth_channel_challenge`). Responses may arrive out of order;
  correlate by `requestId`.

Choose BTP when streaming many paid requests over one session. A route may also insist on one carriage, in which case
the other answers with the route's terms and `requiredTransport` naming the one it wants.

## Conformance

`src/wire/` is held to the connector's committed cross-repo vectors, vendored under
`packages/client/src/wire/vectors/` and SHA-256 pinned: reproducing those bytes is what
conformance means here. Prose describing the wire — including this page — is not normative. See
[development.md](development.md#wire-vectors) for how to refresh and check them.
