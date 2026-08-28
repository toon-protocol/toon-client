# Library API

Everything below is exported from the package root:

```ts
import { ToonClient, DEVNET, sealExchange /* … */ } from '@toon-protocol/client';
```

Amounts are `bigint` throughout, in the settlement asset's base units. The settlement token is
6-decimal USDC on both devnet chains, so `1000n` is 0.001 USDC.

## `ToonClient`

```ts
const client = await ToonClient.create(config);
```

`create` reads the node's self-description with one free `GET /ilp`, derives your keys, picks a
settlement chain and opens the channel store. **It sends no transaction and spends nothing.**

### Properties

| Property | Type | What it is |
| --- | --- | --- |
| `connector` | `string` | The normalized client-edge base URL this client is attached to |
| `chain` | `'evm' \| 'solana'` | The settlement chain in use |
| `identity` | `ToonIdentity` | `{ evmAddress?, solanaPublicKey?, senderId }` |
| `channel` | `ChannelFacade` | On-chain channel operations |
| `wallet` | `WalletFacade` | Chain reads and transfers unrelated to paying a connector |

### Methods

```ts
describe(options?: { fresh?: boolean }): Promise<NodeSelfDescription>
```

`GET /ilp`. Cached per instance; `{ fresh: true }` re-reads. This is the whole of bootstrapping —
addresses, endpoints, the sealing key, per-chain settlement terms and route prices.

```ts
price(destination: string): Promise<bigint | null>
```

`GET /ilp/routes/price`. `null` means the connector serves no route matching that destination —
an answer, not a failure. The same longest-prefix lookup the claim gate charges against, so it
cannot quote a price a real request would not be charged.

```ts
probe(destination: string): Promise<{ accumulatedCost: bigint; code: string; message: string }>
```

`POST /ilp/probe`. Learns what a path costs without buying the work. Requires an open channel: a
probe traverses for free, so it is gated on a channel the connector recognizes and rate-limited
per channel.

```ts
send(request?: SendRequest, options?: SendOptions): Promise<SendResult>
send(destination: string, request?: SendRequest, options?: SendOptions): Promise<SendResult>

defaultDestination: string | undefined
```

Pay for one HTTP request. The central operation. Never throws on a refusal.

The destination is **optional**. Omitted, the packet goes to `defaultDestination` — the first
address the node published for itself that it also prices — so configuring a client is just a
URL and the route is a fact read off `GET /ilp` rather than a string copied by hand. Name a
destination explicitly to address a route the node forwards rather than terminates.

```ts
claimState(channelIds?: string[]): Promise<ClaimStateResult[]>
```

`POST /ilp/claim-state`. The connector's own watermark for channels you control — deposit total,
cumulative claimed, available, nonce, last-claim time. Authenticated by one signature per channel
over a challenge distinct from a claim. Works when the channel has run dry.

```ts
close(): Promise<void>
```

Releases the BTP session and flushes the channel store. **It does not close the channel** — that
is `channel.close()`, an on-chain transaction.

## `ToonClientConfig`

```ts
interface ToonClientConfig {
  connector: string;

  mnemonic?: string;
  evmPrivateKey?: string | Uint8Array;
  solanaSecretKey?: Uint8Array | string;
  accountIndex?: number;
  keyDerivation?: 'standard' | 'legacy';

  chain?: 'evm' | 'solana';
  rpcUrl?: string;
  transport?: 'auto' | 'http' | 'btp';
  channelStore?: string | ChannelStore;
  senderId?: string;

  deposit?: bigint | string;
  settlementTimeout?: number;
  autoOpenChannel?: boolean;
  timeoutMs?: number;

  btp?: { maxReconnectAttempts?: number; reconnectDelay?: number; declareChannel?: boolean };
  faucetUrl?: string;
  fetch?: typeof fetch;
  createWebSocket?: (url: string) => unknown;
}
```

| Field | Default | Notes |
| --- | --- | --- |
| `connector` | required | Base URL or `…/ilp`; a trailing `/ilp` is normalized away. There is no discovery and no peer list — one URL is the whole of bootstrapping. |
| `mnemonic` | — | A BIP-39 phrase, deriving both chain keys. |
| `evmPrivateKey` | — | A raw EVM key, when you are not deriving from a phrase. |
| `solanaSecretKey` | — | A 32-byte seed or a 64-byte secret key, bytes or base58. |
| `accountIndex` | `0` | BIP-44 account index. |
| `keyDerivation` | `'standard'` | See [Key derivation](#key-derivation). |
| `chain` | first settlement you hold a key for | Set it explicitly when a node settles on several and you care which one your money moves on. |
| `rpcUrl` | the devnet preset for the chain | On Base Sepolia, prefer a read-after-write consistent endpoint — see [channels.md](channels.md#choosing-an-evm-rpc). |
| `transport` | `'auto'` | `'auto'` honours the node's `requiredTransport`, otherwise prefers HTTP. Choose `'btp'` when streaming many requests: one ordered socket cannot race its own claim nonces. |
| `channelStore` | in memory, with a warning | A path becomes a JSON file store. **Set it.** See [channels.md](channels.md#the-watermark-and-why-the-store-must-be-durable). |
| `senderId` | your address on the selected chain | A label the connector echoes, never an authority — a claim is authorised by its signature and nothing else. |
| `deposit` | `100000n` (0.10 USDC) | Collateral for the first channel this client opens, in base units. |
| `settlementTimeout` | `86400` | Challenge period in seconds. Floored at `3600` on EVM. |
| `autoOpenChannel` | `true` | Open a channel on the first `send()` when none exists. |
| `timeoutMs` | `30000` | Per-packet timeout. |
| `faucetUrl` | the devnet faucet | Devnet only. |

## Sending

```ts
interface SendRequest {
  method?: string;                                  // default 'POST'
  target?: string;                                  // default '' — the handler itself
  headers?: Record<string, string> | [string, string][];
  body?: string | Uint8Array | object;
}

interface SendOptions {
  amount?: bigint;                 // default: the route's price
  sealTo?: Uint8Array | string;    // another connector's identity, for a forwarded route
  timeoutMs?: number;
}
```

`target` is resolved strictly *beneath* the route's configured handler path and can never replace
it: `''` and `'/'` both address the handler, and an absolute path, a `..` segment, a scheme or an
authority is refused `F00` before the app is touched.

A `string` or a plain object body is encoded UTF-8; an object also sets
`content-type: application/json`.

`amount` above the price is refused `F03` on a forwarded route before the claim is even read, so
raising it does not buy priority. `sealTo` is needed only when paying a route the addressed node
**forwards**, because a payload must be sealed to the connector that terminates it and no hop may
name that key on its behalf.

### `SendResult`

```ts
type SendResult = SendFulfilled | SendRefused;

interface SendFulfilled {
  fulfilled: true;
  transport: 'http' | 'btp';
  status: number;                    // the APP's HTTP status
  headers: [string, string][];       // in order, duplicates preserved
  body: Uint8Array;
  text(): string;
  json<T = unknown>(): T;
  fulfillment: Uint8Array;           // 32 bytes: proof of delivery to the intended receiver
  claim: ClaimSummary;
}

interface SendRefused {
  fulfilled: false;
  transport: 'http' | 'btp';
  refusedBy: 'destination' | 'path' | 'edge';
  code: string;
  message: string;
  accumulatedCost?: bigint;
  claimAck?: ClaimAck;
  terms?: PaymentTerms;
  detail?: Uint8Array;
  claim?: ClaimSummary;
}

interface ClaimSummary {
  channelId: string;
  chain: 'evm' | 'solana';
  nonce: number;        // strictly increasing per channel
  cumulative: bigint;   // the channel's total after this claim
  amount: bigint;       // what this request cost
}
```

A `404` from the app is a real answer: it arrives on a FULFILL, and costs what a `200` costs. Only
a refusal short of the app produces `SendRefused`. Every code is in [errors.md](errors.md).

`claimAck` is the connector's separate verdict on the claim, and is independent of the ILP
outcome: a FULFILL can carry a **rejected** `claimAck`. Never infer one from the other.

## `ChannelFacade` — `client.channel`

```ts
readonly id: string | undefined;
open(options?: { deposit?: bigint | string; settlementTimeout?: number }): Promise<ChannelState>;
deposit(amount: bigint | string): Promise<ChannelState>;
close(): Promise<{ txHash?: string; closedAt?: bigint; settleableAt?: bigint }>;
settle(): Promise<{ txHash?: string }>;
state(options?: { onChain?: boolean }): Promise<ChannelState>;
ensure(description?: NodeSelfDescription): Promise<string>;
```

Every one of these is your transaction, on your gas. `open` adopts the channel already open with
this connector rather than opening a second one. `ensure` is what `send()` calls: it returns a
usable channel's id, opening one if configured to.

```ts
interface ChannelState {
  chain: 'evm' | 'solana';
  channelId: string;          // '0x…' 32 bytes on EVM; the channel account's base58 key on Solana
  counterparty: string;       // the connector's settlement address
  status: 'open' | 'closed' | 'settled' | 'missing';
  depositTotal: bigint;       // on-chain collateral
  spent: bigint;              // cumulative claimed
  nonce: number;              // the last nonce signed
  available: bigint;          // depositTotal - spent
  onChain?: { deposit?: bigint; closedAt?: bigint; settleableAt?: bigint };
  domain: ChannelTerms;       // the domain a claim on this channel is signed under
}
```

`spent` and `nonce` are the **local** watermark — what this client has signed. The connector keeps
its own and is the one that decides. They agree unless a claim was signed and never accepted; ask
the connector with `claimState()`.

## `WalletFacade` — `client.wallet`

```ts
balances(chain?: 'evm' | 'solana'): Promise<WalletChainBalances[]>;
transfer(params: SendTransferParams): Promise<SendTransferResult>;
faucet(chain?: 'evm' | 'solana'): Promise<FundWalletResult>;   // devnet only
```

These have nothing to do with paying a connector. `balances` is a free read of the native coin and
the settlement token; a chain whose RPC is unreachable degrades to `unreadable` rather than
failing the others.

`transfer` sends the token or native gas from your key straight to an address, and confirms
delivery by an **observed balance delta** at the destination rather than by the transaction
returning. A transfer whose transaction landed but whose destination never moved raises
`TransferNotDeliveredError`.

## Key derivation

One phrase, two chains:

| Chain | Path | Notes |
| --- | --- | --- |
| EVM | `m/44'/60'/0'/0/{accountIndex}` | BIP-44's registered coin type. The same phrase in an ordinary wallet shows the same address, so the channel wallet can be inspected or topped up without this package. |
| Solana | `m/44'/501'/{accountIndex}'/0'` | SLIP-0010, all hardened. What the Solana CLI derives. |

`keyDerivation: 'legacy'` puts the EVM key at `m/44'/1237'/0'/0/{accountIndex}` instead. That is
where this client derived it before 1.0, when one secp256k1 key served two roles. The addresses
are different, and they may hold channels with real collateral, so:

- **A keystore written before 1.0 records no derivation and is read as `legacy`.** Its addresses,
  and the channels funded at them, do not move when you upgrade.
- A keystore written now is version 2, records `standard`, and says so on disk.
- Nothing rewrites an old file in place. Moving to the standard path is deliberate: import the
  same phrase into a new keystore, and open a new channel at the new address.

## Keystore

Node-only. scrypt for the KDF, AES-256-GCM for the encryption, mode `0600` on the file.

```ts
import {
  generateKeystore, importKeystore, openKeystore, keystoreDerivation,
} from '@toon-protocol/client';

const { mnemonic } = generateKeystore('/home/you/.toon/keystore.json', password);
const opened = openKeystore('/home/you/.toon/keystore.json', password);
opened.mnemonic;    // the phrase
opened.derivation;  // 'standard' | 'legacy' — see above
opened.version;     // 2, or 1 for a pre-1.0 file
```

`loadKeystore` returns the phrase alone and is kept for compatibility; prefer `openKeystore`,
because a phrase without its derivation is only half the answer.

## Jobs

Some apps a connector fronts are not plain HTTP handlers: the store and the gas station both take
their input as a **kind-tagged Nostr event** whose arguments are `['param', key, value]` tags, and
answer in the FULFILL body. There is no relay and no round trip — the event *is* the request body
of the paid POST.

```ts
import { buildJobEvent, sendJob } from '@toon-protocol/client';

const answer = await sendJob<MyReceipt>(
  { client, destination: 'g.toon.store' },
  buildJobEvent({ kind: 5095, params: { op: 'buy', name: 'my-name' } })
);
```

The signature on the event is **integrity, not identity** — it proves the tags were not altered in
transit, and nothing else. Who paid is the connector's `X-TOON-Payer` header, proved against a
claim. So `buildJobEvent` generates a key per event by default, and this client carries no Nostr
identity: there is nothing to derive, back up or rotate.

`sendJob` returns a `JobAnswer<T>` — `{ accepted: true, receipt }`, or `{ accepted: false, code,
message, refusal? }`. `accepted: false` never means "the app said no to what you asked": that is a
receipt. It means there is no receipt, because the packet was refused short of the app or the app
rejected the event before running it.

| Export | What it does |
| --- | --- |
| `buildJobEvent` | Builds and signs one NIP-01 event from a `{ kind, params }` |
| `jobEventParam` | Reads a `['param', key, value]` tag back off an event |
| `sendJob` | Pays for one job and decodes its receipt |
| `JobEndpoint` | `{ client, destination, sealTo?, timeoutMs? }` — who pays, which route, and whose key the payload is sealed to |

### Buying an ArNS name with no SOL

`kind:5095 op=buy` needs a `processId`: the MPL Core asset pubkey of an ANT you already own.
Spawning one costs ~0.012 SOL of rent, and this client holds stablecoin credit on a payment
channel, not SOL. So the work splits across three parties, and no single one has to be able to do
all of it — the **store** composes the transaction, the **client** signs it, the **gas station**
pays for it and broadcasts it.

```ts
import { buyArnsNameWithNewAnt, solanaKeypair } from '@toon-protocol/client';

const outcome = await buyArnsNameWithNewAnt({
  store: { client, destination: 'g.toon.store' },
  gas:   { client, destination: 'g.toon.gas' },
  owner: solanaKeypair(mySolanaSecret),
  name:  'my-name',
  years: 1,
});
```

`spawnAnt` drives the ceremony on its own; `buyArnsName` registers a name to an ANT you already
hold; `buyArnsNameWithNewAnt` is the two in order.

```text
1. → gas    kind:5096 quote, no draft    → feePayer
2. → store  kind:5095 op=prepare         → unsigned draft transaction
3.          sign the mint and owner slots
4. → gas    kind:5096 quote, with draft  → quoteId, recentBlockhash, maxLamports
5.          patch the blockhash, sign again
6. → gas    kind:5096 execute            → co-signed, broadcast, signature
7. → store  kind:5095 op=buy             → the name is yours
```

Two quotes and two signings, because the gas station prices the job from a **signed** draft — that
is what makes the free quote a full policy dry run — and then requires the executed transaction to
carry the blockhash **it** chose. Everything from step 4 on runs inside one merged
quote/blockhash deadline, 60 seconds by default, which is why step 5 patches those 32 bytes
locally instead of paying for a second `op=prepare`. Pass `reprepare: true` to take that round
trip anyway; both routes end in the same place.

The mint keypair is **ephemeral and single-use**: generated per spawn, its public half becomes the
ANT's permanent address and the `processId` for step 7, and nothing needs its private half once
the spawn confirms.

**Nothing here throws.** A gate that declined to spend, a packet the connector would not carry, an
event the app rejected and a receipt this client will not sign are all outcomes — `{ spawned:
false, step, reason, detail, idempotencyKey }`. By the time any of them is read a packet has
already been paid for, so it is returned rather than thrown.

`reason` is the gas station's own vocabulary wherever the verdict is one the gas station would
give, including the checks made locally to reach that verdict before paying for it. The reasons
worth branching on:

| `reason` | What to do |
| --- | --- |
| `float_exhausted` | The node is out of gas money. Nothing to retry. |
| `quote_expired`, `blockhash_expired`, `blockhash_mismatch` | Re-run the spawn; the ceremony overran its deadline. |
| `confirmation_timeout` | Broadcast but not confirmed — it may still land. Re-send the execute with the **same** `idempotencyKey`; the refusal carries it, along with the `quoteId` and the `transaction` bytes. |
| `missing_client_signature` | A slot is still zero. Sign *after* patching, never before. |
| `malformed_receipt` | The store composed against keys other than the ones it was handed, or an ANT other than the mint. Nothing was signed. |

The two halves are separately re-runnable on purpose. If the buy fails after the spawn confirmed,
the ANT is still yours: call `buyArnsName` with the `processId` in `ant` rather than spawning a
second one.

The spawned ANT is **not ACL-bootstrapped** — that is ~61.4M lamports against the gas station's
20M per-job ceiling. The ANT resolves fine; it just will not appear in "ANTs I own" registry
lookups until you bootstrap it later with your own SOL, and that registry is an
eventually-consistent secondary index, not truth.

## Low-level exports

For forming packets by hand, or checking what this client formed. Each is covered by the
connector's own wire vectors — see
[how-a-paid-packet-works.md](how-a-paid-packet-works.md).

| Export | What it does |
| --- | --- |
| `sealExchange` | Seals an envelope to an identity key and mints the matching condition, secret and fulfilment in one call |
| `readExchangeOutcome` | Reads a FULFILL or a REJECT back into an outcome, using that secret |
| `envelopeHeader` | Case-insensitive header lookup on an envelope |
| `deriveFulfillment`, `deriveCondition` | The derivation itself, if you want to check it |
| `encodeEnvelope`, `decodeEnvelope` | The OER envelope codec |
| `sealRequest`, `openResponse` | The gift wrap on its own |
| `ConnectorEdgeClient` | The client-edge endpoints as plain calls |
| `parseSelfDescription` | `GET /ilp` body to `NodeSelfDescription` |
| `ChannelManager`, `JsonFileChannelStore` | The watermark and the bindings, without a client |
| `EvmSigner`, `SolanaSigner` | Balance-proof signing, per chain |
| `parseSolanaWireTransaction` | Reads a compiled Solana transaction this client did not build — its signers, its blockhash, which slots are still zero |
| `signSolanaWireTransaction` | Fills the signature slots that are yours, in place, without recompiling the message |
| `patchSolanaRecentBlockhash` | Moves the 32 blockhash bytes to the one a fee payer chose, clearing the signatures made over the old message |
| `generateSolanaKeypair`, `solanaKeypair` | A fresh single-use keypair, or one read back from a 32-byte seed or 64-byte secret |
| `DEVNET`, `defaultRpcUrl` | Well-known devnet values. Defaults and examples only — settlement facts always come from `GET /ilp` |

## Examples

Runnable, in [`packages/client/examples/`](../packages/client/examples/):

- `send-http.ts` — EVM, the store node, over ILP-over-HTTP
- `send-btp-solana.ts` — Solana, the relay node, over BTP
