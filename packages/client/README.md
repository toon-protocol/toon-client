# @toon-protocol/client

The **client library** for TOON Protocol — _pay-to-write Nostr over Interledger (ILP)_. Use it to **pay for and publish** writes to a network of service nodes. **Reads are free; writes cost a signed EIP-712 payment-channel claim** against an on-chain deposit.

> **`client` vs `relay`.** This package (`@toon-protocol/client`) is what an _app or end user_ uses to **pay** and publish. It does **not** run any relay or node. The nodes are operated separately by **`@toon-protocol/relay`** (the operator product, which runs an _apex_ connector plus `relay` / `swap` / `store` children). Don't confuse the **client** (pays) with **`@toon-protocol/relay`** (operates a node cluster), or the **relay** child node (a single Nostr-WS node) with the full **relay** operator stack.

## Which call pays which node

Every write is an ILP packet carrying a signed payment-channel claim, and its payload is **sealed to the connector that terminates the destination** (see [How a paid write works](#how-a-paid-write-works-the-sealed-wire)). The client reaches all node types **through a relay apex** (`g.proxy`): the apex validates the claim, takes its fee, and forwards the packet to the destination node, which returns FULFILL (accepted) or REJECT. The method you call determines which node type you pay:

| Client call                       | Node type | What it does                                                                                                                                              |
| --------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client.publishEvent(event)`      | **relay** | Publish a Nostr event (e.g. `kind:1`) to the relay.                                                                                                       |
| `requestBlobStorage(client, …)`   | **store** | NIP-90 compute/storage. Builds and publishes a `kind:5094` event that uploads a blob to Arweave — the job request **is** the payment — and decodes the Arweave tx ID from the FULFILL response. |
| `client.sendSwapPacket(…)`        | **swap**  | Multi-chain token swap (low-level). Most callers use the higher-level `streamSwap()` from `@toon-protocol/sdk`, which is built on `sendSwapPacket`.       |

## What It Does

This client handles:

- **ILP Micropayments**: Pay to publish Nostr events (reads are free)
- **The sealed wire**: Every paid write is an OER envelope gift-wrapped to the terminating connector's identity key, under an execution condition derived from the secret inside that wrap — see [How a paid write works](#how-a-paid-write-works-the-sealed-wire)
- **Payment Channels**: Automatic on-chain channel creation with off-chain settlement via signed balance proofs
- **Unified Identity**: One Nostr key = one EVM address (both secp256k1, derived automatically) — or a single BIP-39 **mnemonic** to derive a full multi-chain identity
- **Multi-Chain Settlement**: Sign payment-channel claims on EVM (EIP-712), Solana (Ed25519), and Mina (Pallas) from one mnemonic. A relay apex validates the claim and redeems it on-chain on the matching chain (EVM/Solana credit the recipient; Mina redeems each claim on-chain with recipient credit-at-close deferred — see [Multi-Chain Settlement notes](#identity--multi-chain-settlement))
- **Multi-Hop Routing**: Publish to any destination address (`destination` / `destinationAddress`), not just your direct peer
- **Network Bootstrap**: Automatically discover and register with ILP peers via NIP-02 follow lists
- **TOON Encoding**: Native binary format for agent-friendly event encoding

## Installation

```bash
pnpm add @toon-protocol/client @toon-protocol/core @toon-protocol/relay nostr-tools

# Optional — only needed to derive/sign on Mina (Pallas):
pnpm add mina-signer
```

## Prerequisites

**Reading is free** — to subscribe/query you need nothing but this package. To **write (pay)** you need:

- **Node.js ≥ 20** — these packages are ESM.
- **A TOON apex to pay.** You don't run any node yourself; you connect to a running
  [`@toon-protocol/relay`](https://www.npmjs.com/package/@toon-protocol/relay) apex (or any
  TOON connector) and pay it. From its operator you need:
  - a **connector endpoint** — an HTTP `connectorUrl` (or `proxyUrl`), optionally plus a BTP
    WebSocket `btpUrl`. The HTTP client edge is **required even when packets travel over BTP**:
    the identity a payload is sealed to and the price of a route are read from `GET /ilp/identity`
    and `GET /ilp/routes/price` on it. Without one, `publishEvent` raises `NO_CONNECTOR_EDGE`
    before forming a packet;
  - a **settlement-chain RPC URL** and a **funded key** on that chain, so the client can open a
    payment channel and sign EIP-712 claims;
  - the **token** and **TokenNetwork** contract addresses that apex accepts on that chain (e.g. USDC).

These coordinates go straight into the [`ToonClient` config](#quick-start) below.

> **Local development (from a clone of this repo, not the npm package).** To try the client
> end-to-end against a throwaway local network — Anvil + two peer nodes + relays — see
> [`packages/client/tests/e2e/README.md`](tests/e2e/README.md) for the service topology and manual
> testing snippet. Its automated setup steps assume the monorepo's `scripts/sdk-e2e-infra.sh`
> wrapper and a `docker-compose-sdk-e2e.yml`, neither of which ships in this extracted repo; treat
> those steps as a reference for provisioning the equivalent infrastructure yourself.
>
> | Service          | Port  | Purpose                                             |
> | ---------------- | ----- | --------------------------------------------------- |
> | **Anvil**        | 18545 | Local EVM chain (chain ID 31337)                    |
> | **Peer 1 BLS**   | 19100 | Validates events, calculates pricing, stores events |
> | **Peer 1 Relay** | 19700 | WebSocket relay for peer discovery (kind:10032)     |
> | **Peer 2 BLS**   | 19110 | Validates events, calculates pricing, stores events |
> | **Peer 2 Relay** | 19710 | WebSocket relay for peer discovery (kind:10032)     |
>
> The Quick Start below is wired for this local stack (chain `evm:anvil:31337`, TokenNetwork
> `0xCafac3dD…052c`); swap in your apex's real coordinates for any other network.

---

## Quick Start

```typescript
import { ToonClient } from '@toon-protocol/client';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { encodeEventToToon, decodeEventFromToon } from '@toon-protocol/relay';

// 1. Generate identity — one key gives you both Nostr and EVM identities
const secretKey = generateSecretKey();
const pubkey = getPublicKey(secretKey);

// 2. Create client
const client = new ToonClient({
  connectorUrl: 'http://localhost:8080',
  secretKey,
  ilpInfo: {
    pubkey,
    ilpAddress: `g.toon.${pubkey.slice(0, 8)}`,
    btpEndpoint: 'ws://localhost:3000',
  },
  toonEncoder: encodeEventToToon,
  toonDecoder: decodeEventFromToon,
});

// 3. Start (bootstrap network, discover peers)
await client.start();

// Your EVM address is derived from the same key — no separate config needed
console.log(`EVM address: ${client.getEvmAddress()}`);

// 4. Publish event to relay via ILP payment
const event = finalizeEvent(
  { kind: 1, content: 'Hello from TOON!', tags: [], created_at: Math.floor(Date.now() / 1000) },
  secretKey,
);

const result = await client.publishEvent(event);
if (result.success) {
  console.log(`Published: ${result.eventId}`);
}

// 5. Clean up
await client.stop();
```

---

## How a paid write works (the sealed wire)

`publishEvent` does all of this for you. It is spelled out because every step shows up in
the result, and because each piece is exported for anyone forming a packet by hand.

A paid write used to be an HTTP/1.1 request as **text** in `Prepare.data`, under an all-zero
execution condition. Both are gone. A write is now an **OER envelope, gift-wrapped to the
identity of the connector that terminates the destination**, under a condition **derived from
the secret inside that wrap**. The rules come from the connector's ADRs — sealing
([0018](https://github.com/toon-protocol/connector/blob/main/docs/adr/0018-a-payload-is-sealed-to-the-terminating-connector.md)),
fulfilment derivation
([0019](https://github.com/toon-protocol/connector/blob/main/docs/adr/0019-a-terminating-connector-derives-the-fulfilment.md)),
flat pricing
([0020](https://github.com/toon-protocol/connector/blob/main/docs/adr/0020-a-price-is-flat-and-attaches-to-a-handler.md)),
vectors as the normative contract
([0021](https://github.com/toon-protocol/connector/blob/main/docs/adr/0021-vectors-are-normative-prose-is-not.md)),
and answering-but-not-announcing
([0022](https://github.com/toon-protocol/connector/blob/main/docs/adr/0022-a-connector-answers-it-does-not-announce.md)).

The ILP layer around it is unchanged: same `POST /ilp`, same PREPARE/FULFILL/REJECT, same
`ILP-Payment-Channel-Claim` header, same channels and watermarks. Only `data` and the
condition changed.

### 1. Ask the connector who it is

A packet cannot be formed without the terminating connector's public key, and there is no
default to fall back on: sealing to the wrong key is a **confidentiality** failure that merely
_presents_ as an undeliverable packet. A connector answers when asked and never announces, so
the key is read straight off its client edge — the same origin the client `POST`s `/ilp` to.

```typescript
import { ConnectorEdgeClient } from '@toon-protocol/client';

const edge = new ConnectorEdgeClient(); // { fetch?, timeout? }

// GET /ilp/identity — cached per endpoint; 'http://apex/ilp' and 'http://apex' are the same edge
const identity = await edge.getIdentity('http://localhost:8080');
identity.publicKey; // Uint8Array, exactly 65 bytes, SEC1-uncompressed secp256k1 (leading 0x04)
identity.keyId; // opaque to this client
```

A key of the wrong length, without the `0x04` tag, or not `0x`-hex is refused with a
`ConnectorEdgeError` (`IDENTITY_KEY_LENGTH`, `IDENTITY_KEY_NOT_UNCOMPRESSED`,
`IDENTITY_KEY_NOT_HEX`) rather than carried forward — there is no best-effort reading of a
public key. An unreachable edge throws `NetworkError` instead, so "will not seal to that" and
"could not ask" are never confused. Rotation is a deliberate event, so nothing expires on a
timer: `invalidateIdentity(endpoint?)` is how a stale key is dropped.

### 2. Ask the route what it costs

There is no per-byte rate to multiply any more. A price is **flat per handler** — one handler,
one price, and an app that wants to charge differently exposes more handlers — so the route
table *is* the price list and only the connector can state it:

```typescript
// GET /ilp/routes/price?destination= — cached per (endpoint, destination)
const quote = await edge.getRoutePrice('http://localhost:8080', 'g.proxy.relay');
quote?.price; // bigint, in ILP base units — the whole fee for ONE packet

// Or, from a started client, against the edge it already resolved:
const price = await client.getRoutePrice('g.proxy.relay'); // bigint | null
```

`null` means the connector terminates no route matching that destination — an answer, not a
failure, and distinct from the `NetworkError` an unreachable edge throws. `publishEvent`
raises `NO_TERMINATED_ROUTE` on it before any packet exists. This is the same longest-prefix
lookup the claim gate charges against, so it cannot quote a price a real request would not be
charged; use it for a pre-write estimate that is guaranteed to equal what the write pays.

### 3. Seal the envelope and mint the condition together

`sealExchange` produces the wrap, the condition and the secret in one call, because getting
any of them separately wrong is silent. A random condition would never be fulfilled; an
all-zero one the connector refuses outright.

```typescript
import { sealExchange } from '@toon-protocol/client';

const exchange = sealExchange(
  {
    method: 'POST',
    target: '/write', // the terminated route's handler; '/store' for the Arweave store
    headers: [['content-type', 'application/json']],
    body: new TextEncoder().encode(JSON.stringify({ event })),
  },
  identity.publicKey,
);

exchange.data; // Uint8Array — the gift wrap, to carry as the PREPARE's `data`
exchange.condition; // Uint8Array — sha256(deriveFulfillment(sharedSecret))
exchange.sharedSecret; // Uint8Array(32) — keep it; nothing else opens the answer
exchange.fulfillment; // Uint8Array — the preimage the connector will return
```

The condition is exactly `deriveCondition(deriveFulfillment(secret))`, and both are exported
if you want to check the derivation yourself:

```typescript
import { deriveCondition, deriveFulfillment } from '@toon-protocol/client';

// deriveFulfillment = HKDF-SHA256(sharedSecret, "toon-giftwrap-fulfillment"), 32 bytes
// deriveCondition   = sha256 of that fulfilment
deriveCondition(deriveFulfillment(exchange.sharedSecret)); // === exchange.condition
```

The terminating connector opens the wrap, recovers the same secret and derives the same
preimage — **the app behind the route supplies nothing and holds no key**, which is what keeps
"any HTTP service is a TOON node app" true. Never reuse a secret for a second packet.

### 4. Send it, then open the answer with the same secret

`exchange.data` goes on the PREPARE as base64 `data` and `exchange.condition` as its
`executionCondition`; the claim rides in the `ILP-Payment-Channel-Claim` header as before.
Whatever comes back — a FULFILL or a REJECT — is read by one function:

```typescript
import { readExchangeOutcome, envelopeHeader } from '@toon-protocol/client';

// `sent` is the transport's `{ accepted, code?, message? }`; `payload` is the packet's
// data bytes (`undefined` when it carried none).
const outcome = readExchangeOutcome(sent, payload, exchange.sharedSecret);

switch (outcome.kind) {
  case 'answered':
    outcome.response.status; // number — any status; a non-2xx is still a paid answer
    outcome.response.headers; // readonly [name, value][]
    outcome.response.body; // Uint8Array
    envelopeHeader(outcome.response, 'content-type'); // case-insensitive lookup
    break;
  case 'destination-refused': // provable: only the termination could have sealed this
    outcome.code, outcome.message, outcome.detail;
    break;
  case 'path-refused': // unauthenticated by construction — a hint, not a verdict
    outcome.code, outcome.message;
    break;
}
```

A FULFILL
that is not a readable sealed response envelope throws `SealedResponseError`, whose `kind` is
`'not-sealed'`, `'unopenable'` or `'malformed-envelope'` — value moved, so bytes that are none
of those mean a broken counterparty rather than an outcome to invent.

**A reject raised short of the termination is plaintext, and that is distinguishable.** Only
the terminating connector holds the shared secret, so only it can seal a refusal; an
intermediate hop rejecting for no-route, expiry, a ceiling or a rejected claim shares no secret
and cannot seal anything. A reject whose `data` actually **opens** under this packet's secret
is therefore proof the destination said no — a leading type byte alone is a claim, not
evidence, and one that fails to open is classified as a path reject. This distinction did not
exist before the seal, and it is why the outcome is a three-way union rather than one error
string.

### What `publishEvent` returns

```typescript
const result = await client.publishEvent(event, {
  destination: 'g.proxy.relay', // defaults to config.destinationAddress
  claim, // optional pre-signed balance proof; otherwise auto-signed
  ilpAmount: 1000n, // optional override — skips the route-price lookup entirely
  proxyPath: '/write', // request-target inside the envelope ('/store' for the store)
});

result.success; // false for a rejected packet AND for a non-2xx answer
result.eventId; // set on success
result.response; // EnvelopeResponse — the opened answer; present whenever the packet FULFILLED
result.refusedBy; // 'destination' (provable) | 'path' (unauthenticated), when rejected
result.code; // the ILP reject code, when rejected
```

An HTTP status inside the response envelope is envelope **content**, not a packet outcome: a
404 rides home on a FULFILL and value moved. `publishEvent` still reports that as
`success: false` — the event did not persist — but `response` is populated either way, so you
can see exactly what you paid for.

### Conformance

`src/wire/` is held to the connector's committed cross-repo vector set, vendored at
[`src/wire/vectors/`](src/wire/vectors/README.md) and SHA-256 pinned: reproducing those bytes
is what conformance means here. `pnpm --filter @toon-protocol/client vectors:check` compares
the vendored copy against connector `main`, and a CI job runs it daily and on any PR touching
`src/wire/**`.

### Removed with the plaintext path

`buildStoreWriteEnvelope`, `parseFulfillHttp`, `parseFulfillHttpBytes`, `ParsedFulfillHttp`,
`serializeHttpRequest`, `parseHttpResponse` and `ILP_CLAIM_WRAPPED_HEADER` are gone — no HTTP
text is serialised or parsed anywhere in this package. `PublishEventResult.data` (raw base64
FULFILL bytes) became `response`, and `extractArweaveTxId` now takes that `EnvelopeResponse`
rather than a base64 string. Per-byte pricing is gone with them: `basePricePerByte`,
`uploadFeePerByte`, `minUploadFee` and `flooredUploadFee` have no successor.

---

## Identity & Multi-Chain Settlement

There are two ways to give the client an identity:

### 1. Raw `secretKey` — Nostr + EVM (secp256k1)

A 32-byte Nostr key. Because Nostr and EVM both use secp256k1, the same key provides your EVM identity automatically. This is the path shown in the Quick Start, and it only supports EVM settlement.

### 2. `mnemonic` — full multi-chain identity (recommended for non-EVM)

A single BIP-39 phrase derives **all** chain identities: Nostr (NIP-06) + EVM (secp256k1), Solana (Ed25519), and Mina (Pallas). This is required to settle on Solana or Mina — a raw secp256k1 `secretKey` cannot represent those curves.

```typescript
import { ToonClient, generateMnemonic, deriveFullIdentity } from '@toon-protocol/client';
import { encodeEventToToon, decodeEventFromToon } from '@toon-protocol/relay';

const mnemonic = generateMnemonic(); // or restore an existing 12-word phrase
const { nostr } = await deriveFullIdentity(mnemonic); // peek at the derived keys if needed

const client = new ToonClient({
  connectorUrl: 'http://localhost:8080',
  mnemonic, // derives Nostr/EVM synchronously; Solana/Mina during start()
  ilpInfo: {
    pubkey: nostr.pubkey,
    ilpAddress: `g.toon.${nostr.pubkey.slice(0, 8)}`,
    btpEndpoint: 'ws://localhost:3000',
  },
  toonEncoder: encodeEventToToon,
  toonDecoder: decodeEventFromToon,
});

await client.start();

// EVM is available before start(); Solana/Mina are derived during start()
console.log('Nostr: ', client.getPublicKey());
console.log('EVM:   ', client.getEvmAddress());
console.log('Solana:', client.getSolanaAddress()); // base58, after start()
console.log('Mina:  ', client.getMinaAddress());   // base58, after start() (needs mina-signer)
```

**Notes & rules:**

- **Precedence**: `mnemonic` and `secretKey` are mutually exclusive (a separate `secretKey` would split the Nostr identity from the Solana/Mina identity — the client rejects it). An `evmPrivateKey` override **is** allowed alongside `mnemonic` (e.g. a hardware-wallet EVM key while still deriving Solana/Mina from the phrase).
- **Solana/Mina addresses** (`getSolanaAddress()`, `getMinaAddress()`) are only available **after `start()`** — those keys are derived asynchronously. `getEvmAddress()`/`getPublicKey()` work before `start()`.
- **Mina is optional**: it requires the `mina-signer` peer dependency (see Installation). Without it, the client still works for Nostr/EVM/Solana and `getMinaAddress()` returns `undefined`.
- **Security**: JavaScript strings can't be zeroed from memory, so a `mnemonic` may linger in the heap. For high-security contexts, derive keys yourself (e.g. via `KeyManager`) and pass a pre-derived `secretKey`.
- **Per-chain claim formats.** Each publish carries a balance-proof claim in the format that destination chain's connector verifier expects — EVM via EIP-712, Solana as a raw Ed25519 message over the on-chain payment-channel message (`channel_pda ‖ nonce ‖ transferredAmount`), Mina as a Pallas-Schnorr claim over a Poseidon `balanceCommitment`. `ToonClient` selects the right signer for the negotiated channel automatically; you do not pick the format. Canonical layouts live in `@toon-protocol/core` (`packages/core/src/settlement/`) so client signers and connector verifiers cannot drift.
- **On-chain redemption is automatic, and driven by the apex — not the client.** You sign off-chain claims; the relay apex validates them, fulfills, and (once a per-channel threshold is crossed) submits the on-chain redemption itself. EVM and Solana credit the recipient on-chain (Solana at channel close, `SETTLE_CHANNEL`). On **Mina** each paid publish redeems on-chain (`claimFromChannel`, the apex co-signs the counterparty signature; the zkApp nonce and balance commitment advance), and **the recipient's tokens are credited at channel close** via the Story 34.4 fund-custody zkApp (`@toon-protocol/connector` ≥3.10.0): the deposit is escrowed on the zkApp account and `settle()` drains it to the participants (recipient + depositor refund). Verified against `@toon-protocol/connector` 3.10.0.

---

## Uploading a blob to a DVM (Arweave storage)

To store a blob permanently on Arweave, pay a **store** node with a `kind:5094` NIP-90 request. The `requestBlobStorage` helper builds the signed event, publishes it through your `ToonClient` (reusing its claim/channel plumbing), and decodes the Arweave transaction ID from the FULFILL response:

```typescript
import { ToonClient, requestBlobStorage } from '@toon-protocol/client';

// `client` is a started ToonClient (see Quick Start). `secretKey` signs the kind:5094 event.
const result = await requestBlobStorage(client, secretKey, {
  blobData: new Uint8Array([1, 2, 3, 4]),
  contentType: 'application/octet-stream',
  ilpAmount: 50_000n, // USDC micro-units; also used as the event's `bid` if `bid` is omitted
  destination: 'g.toon.peer1', // the store node's ILP address (defaults to the client's destinationAddress)
});

if (result.success) {
  console.log(`Stored on Arweave: https://arweave.net/${result.txId}`);
} else {
  console.error(`Upload failed: ${result.error}`);
}
```

`requestBlobStorage(client, secretKey, params)` returns `{ success, txId?, eventId?, error? }` (`RequestBlobStorageParams` / `RequestBlobStorageResult` are exported for typing). It covers the **single-packet** case; for large chunked uploads, drive `client.publishEvent()` with `kind:5094` events directly.

---

## Payment Channels

The client supports payment channels for off-chain settlement on EVM, Solana, and Mina. With a raw `secretKey` you get EVM only; construct from a `mnemonic` (above) to settle on Solana/Mina. Your EVM identity is derived automatically — no separate EVM key needed.

### Enabling Payment Channels

To use payment channels, add chain configuration. The client already has your EVM identity from `secretKey`:

```typescript
const client = new ToonClient({
  connectorUrl: 'http://localhost:8080',
  secretKey,
  ilpInfo: { pubkey, ilpAddress: `g.toon.${pubkey.slice(0, 8)}`, btpEndpoint: 'ws://localhost:3000' },
  toonEncoder: encodeEventToToon,
  toonDecoder: decodeEventFromToon,

  // Add chain config to enable payment channels
  supportedChains: ['evm:anvil:31337'],
  chainRpcUrls: { 'evm:anvil:31337': 'http://localhost:8545' },
  settlementAddresses: { 'evm:anvil:31337': client.getEvmAddress()! },
  tokenNetworks: { 'evm:anvil:31337': '0xCafac3dD18aC6c6e92c921884f9E4176737C052c' },
  initialDeposit: '1000000000000000000', // 1 ETH in wei
});

await client.start();

// Channels are created automatically during bootstrap
const channels = client.getTrackedChannels();
console.log(`Tracking ${channels.length} payment channels`);

// Publish with signed balance proof
const channelId = channels[0];
const claim = await client.signBalanceProof(channelId, 1000n);
await client.publishEvent(event, { claim });
```

### How It Works

1. **Bootstrap**: Client discovers peers via NIP-02 and kind:10032 events, negotiating a settlement chain with each
2. **Channel Creation**: Opens an on-chain payment channel on the negotiated chain — using your derived EVM address (EVM), the Ed25519 channel PDA (Solana), or the deployed zkApp account (Mina) when the matching `solanaChannel` / `minaChannel` config is provided
3. **Off-chain Payments**: Signed balance proofs (chain-appropriate format) settle payments off-chain
4. **Auto-tracking**: ChannelManager automatically tracks channels and increments nonces
5. **On-chain redemption**: A relay apex auto-redeems claims on-chain once a per-channel threshold is crossed (see [Multi-Chain Settlement](#identity--multi-chain-settlement) for the EVM/Solana/Mina specifics and the Mina credit-at-close deferral)

### Using a Separate EVM Key (Advanced)

If you need a different EVM identity than your Nostr key (e.g., hardware wallet or custodial key), pass `evmPrivateKey` explicitly:

```typescript
const client = new ToonClient({
  // ... required config ...
  evmPrivateKey: '0x...', // Overrides the default derivation from secretKey
});
```

---

## Documentation

- **[API Reference](docs/api-reference.md)** — Constructor, config interface, and all methods
- **[Error Handling](docs/error-handling.md)** — Error class hierarchy, codes, and usage patterns
- **[HTTP Adapters](docs/adapters.md)** — Low-level `HttpRuntimeClient`, `HttpConnectorAdmin`, and `withRetry`
- **[Troubleshooting](docs/troubleshooting.md)** — Common issues and solutions

---

## Testing

### Unit & Integration Tests

```bash
cd packages/client
pnpm test                 # Run all unit/integration tests
pnpm test:coverage        # Run with coverage report
```

### E2E Tests

E2E tests require Docker Compose infrastructure. See
[tests/e2e/README.md](tests/e2e/README.md) for the service topology — note its automated setup
script isn't included in this extracted repo either (see the Prerequisites section above), so
provision the equivalent infrastructure manually, then run:

```bash
cd packages/client
pnpm test:e2e
```

---

## Examples

See [examples/](examples/) for standalone client examples:

- **Basic Publish** (`basic-publish.ts`): Publish a Nostr event to the TOON network
- **Publish and Verify** (`publish-and-verify.ts`): Publish an event and verify via connector logs
- **Publish to Peer1** (`publish-to-peer1.ts`): Multi-hop ILP routing via a peer connector
- **Multi-Hop Routing** (`multi-hop-routing.ts`): Route an event through peer1 to the genesis relay
- **With Payment Channels** (`with-payment-channels.ts`): Configure EVM payment channels and publish with a signed balance proof

---

## Related Packages

- **[@toon-protocol/core](https://www.npmjs.com/package/@toon-protocol/core)** — Core protocol (peer discovery, bootstrap, `buildBlobStorageRequest`)
- **[@toon-protocol/relay](https://www.npmjs.com/package/@toon-protocol/relay)** — Operator product running the apex connector plus relay/swap/store nodes; also exports `encodeEventToToon` / `decodeEventFromToon` for event encoding
- **[@toon-protocol/sdk](https://www.npmjs.com/package/@toon-protocol/sdk)** — Higher-level helpers including `streamSwap()` for multi-chain swaps via a **swap**
- **[@toon-protocol/bls](https://www.npmjs.com/package/@toon-protocol/bls)** — Business Logic Server (pricing, validation, storage)

---

## License

MIT
