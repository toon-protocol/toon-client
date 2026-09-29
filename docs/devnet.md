# Devnet reference

Every address, endpoint and price for the public TOON devnet, in one place. This is the only
document in this repository that carries the full table; everything else links here.

**These are testnets.** Base Sepolia and Solana devnet carry no real value, and the USDC on both
is a mock mint anyone can draw from the faucet.

## The live values come from the node

Ask the node, not this page:

```bash
curl -s https://proxy.ario.devnet.toonprotocol.dev/ilp | jq
```

`GET /ilp` is free and unauthenticated. Its `batchSettlements` are the x402 channel terms the node
is paid under, one per chain, and `voucherSigners` the keys it expects vouchers from. The table below is a convenience — a URL to put in an example, a
default RPC, an address to check a balance against. When the two disagree, the node is right, and
this client never consults a preset in preference to the document a node answers with.

The same values ship as `DEVNET` in `@toon-protocol/client`, for the same reason and with the same
caveat.

## Nodes

Three nodes, six routes. Each node is the receiver of its own channels, so a
channel opened with one buys nothing at the others.

| Node        | Client-edge URL                               | Route                    | Price                        | Carriage     |
| ----------- | --------------------------------------------- | ------------------------ | ---------------------------- | ------------ |
| Store       | `https://proxy.ario.devnet.toonprotocol.dev`  | `g.toon.store`           | 1000 **+ 10 per KiB**        | HTTP or BTP  |
| Gas station | `https://proxy.gas.devnet.toonprotocol.dev`   | `g.toon.gas`             | 1000 base units (0.001 USDC) | HTTP or BTP  |
| Relay       | `https://proxy.relay.devnet.toonprotocol.dev` | `g.toon.relay`           | 1 base unit (0.000001 USDC)  | **BTP only** |
| Relay       | `https://proxy.relay.devnet.toonprotocol.dev` | `g.toon.relay.ephemeral` | free                         | HTTP or BTP  |
| Relay       | `https://proxy.relay.devnet.toonprotocol.dev` | `g.toon.relay.store`     | 1001 **+ 10 per KiB**        | HTTP or BTP  |
| Relay       | `https://proxy.relay.devnet.toonprotocol.dev` | `g.toon.relay.gas`       | 1001 base units              | HTTP or BTP  |

The last two are **forwarded**: the relay carries the packet to the store or the
gas station and charges its own hop on top. Forwarding runs one way — the leaves
do not carry back to the relay.

A forwarded route needs one thing a direct one does not. The payload is sealed to
the connector that _terminates_ the route, and no hop may name that key on the
terminator's behalf, so you name the far node yourself with `sealTo`:

```ts
const answer = await client.send(
  'g.toon.relay.gas',
  { body: 'hello' },
  {
    sealTo: 'https://proxy.gas.devnet.toonprotocol.dev',
  }
);
```

Seal to the relay instead and the packet is undeliverable: the gas station cannot
open the wrap, and the refusal is an `F01`.

The price needs no help here, because the relay prices both forwarded routes
itself. Pass an explicit `amount` only when the node you are attached to prices
no matching route at all — it will tell you so with a `RouteNotPricedError`
rather than guessing.

### A route that meters by size

`g.toon.store` — and `g.toon.relay.store`, which terminates there — charges a
base price **plus 10 base units per kibibyte of sealed payload**. The metered
quantity is the sealed packet, not your request body, and kibibytes are counted
from one, so the smallest possible packet already costs `1000 + 10`. `send()`
computes this for you; `toon price` prints both figures; and
`client.routePrice()` returns them when you want to work it out yourself:

```ts
import { chargeFor } from '@toon-protocol/client';

const terms = await client.routePrice('g.toon.store'); // { price: 1000n, pricePerKib: 10n }
chargeFor(terms!, 1185); // 1020n — two kibibytes started
```

`g.toon.relay.ephemeral` is priced at **zero**, which makes it the one route you can exercise the
whole wire against while holding no funds and no channel — see
[channels.md](channels.md#a-route-priced-at-zero-needs-no-channel). It is still a real paid-write
path in every other respect: the request is sealed, the fulfilment to expect is derived from the
secret inside the seal, and the app's answer comes back sealed.

A route may also be pinned to one carriage, in which case a request over the other one is answered
with the route's terms instead of the work; see [errors.md](errors.md). `g.toon.relay` is pinned to
BTP today — an HTTP send to it is refused `TRANSPORT_REQUIRED`.

A pinned route names its carriage on **its own entry** in `GET /ilp`, as `requiredTransport`
(connector ADR 0072), and `transport: 'auto'` reads it there and dials it on the first attempt. A
node-wide `requiredTransport` sits beside the routes as a summary, and it is stated only where every
route covering the node's own addresses agrees — which the relay's do not, since
`g.toon.relay.ephemeral` is not pinned. **The deployed relay has not yet picked up a connector that
publishes the per-route field**, so until it does its document names no pin at all and `auto` there
still falls back to HTTP and is refused; name `btp` explicitly against it. Read the live document
rather than this table if it matters to you.

Client-edge paths on all three, relative to the base URL above:

| Path                             | Method | What it is                                               |
| -------------------------------- | ------ | -------------------------------------------------------- |
| `/ilp`                           | `GET`  | The node's self-description. Free.                       |
| `/ilp`                           | `POST` | A PREPARE, `application/octet-stream`. The paid path.    |
| `/ilp/btp`                       | `GET`  | Websocket upgrade for the BTP carriage.                  |
| `/ilp/probe`                     | `POST` | A packet sent to be refused, to learn what a path costs. |
| `/ilp/identity`                  | `GET`  | The key a payload is sealed to. Free.                    |
| `/ilp/routes/price?destination=` | `GET`  | One route's price. Free. `404` when no route matches.    |
| `/ilp/claim-state`               | `POST` | The connector's own watermark for channels you hold.     |
| `/ilp/batch-settlement/solana/open` | `POST` | The Solana sponsor endpoint: a payer-signed `open`, co-signed and paid for by the node. The path a node publishes as `sponsorEndpoint` is the one to use. |

## x402 facilitator

`https://onboard.devnet.toonprotocol.dev` — the Onboarder (toon-protocol/infra#23), a stock x402
facilitator on Base Sepolia. It submits a payer-authorized channel deposit and pays its gas, so a
wallet holding devnet USDC and **no ETH** can open a channel. It is this client's default on Base
Sepolia (`DEVNET.facilitator`), and used nowhere else. It offers x402's `eip2612GasSponsoring` and
`erc20ApprovalGasSponsoring`, so a Permit2 deposit of a token without ERC-3009 is gasless too
(toon-protocol/infra#40).

## Base Sepolia (EVM)

| Fact                       | Value                                                                                                                                                                                                    |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Network                    | `eip155:84532`                                                                                                                                                                                           |
| RPC                        | `https://sepolia.base.org`                                                                                                                                                                               |
| `x402BatchSettlement`      | `0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003` — the channel contract                                                                               |
| ERC-3009 deposit collector | `0x4020806089470a89826cB9fB1f4059150b550004`                                                                                                                                                             |
| Permit2 deposit collector  | `0x4020425FAf3B746C082C2f942b4E5159887B0005`                                                                                                                                                             |
| Token                      | `0x0C996d7c934c79a6255254875607Fe69df25C0E1` on Base Sepolia — devnet USDC (Circle FiatToken v2.2: ERC-3009, EIP-2612), 6 decimals; minting is minter-gated, so fund through the faucet (connector#1337) |

A voucher on this chain is an EIP-712 signature under x402's own domain for the contract above. The
channel id is the EIP-712 hash of the channel's config; see [channels.md](channels.md). The bytes are
pinned by the wire vectors (`claim_voucher`), not by this page.

## Solana devnet (Solana)

| Fact                       | Value                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------ |
| Network                    | `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` — devnet, the public cluster, not a local validator     |
| RPC                        | `https://api.devnet.solana.com`                                                                  |
| `payment-channels` program | `CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX` — solana-foundation's |
| Token                      | `34eSxY7qxQ4GzyhDJ8GpUcTz1WWzruGbJbR8q6TtxfQU` on Solana devnet — mock USDC SPL mint, 6 decimals |

A voucher on this chain is an Ed25519 signature over a fixed-layout message naming the channel
account and the cumulative amount; the vectors (`claim_voucher`) pin it. The node's sponsor key,
minimum deposit and sponsor endpoint are in its `batchSettlements` entry.

## Faucet

`https://faucet.devnet.toonprotocol.dev`

| Path                        | Method | Body                        | What it drips                                                    |
| --------------------------- | ------ | --------------------------- | ---------------------------------------------------------------- |
| `/api/base-sepolia/request` | `POST` | `{ "address": "0x…" }`      | Devnet USDC on Base Sepolia. **No ETH** — the gas drip is disabled |
| `/api/solana/usdc-request`  | `POST` | `{ "address": "<base58>" }` | Mock USDC on Solana devnet. **No SOL.**                          |
| `/api/info`                 | `GET`  | —                           | What the faucet is configured to drip                            |

**Neither leg funds gas, and opening a channel needs none**: the facilitator pays for a Base
deposit and the node sponsors a Solana open. Gas is needed only to *leave* a channel, which is the
payer's own transaction — Base Sepolia ETH from elsewhere, or devnet SOL:

```bash
solana airdrop 1 <your base58 address> --url https://api.devnet.solana.com
```

From this client:

```bash
npx toon faucet --chain evm
```

```ts
await client.wallet.faucet('evm');
```

## Amounts

Every amount on the wire is an integer in the token's base units. The token is 6-decimal USDC on
both chains, so:

| Base units | USDC     |
| ---------- | -------- |
| 1          | 0.000001 |
| 1000       | 0.001    |
| 100000     | 0.10     |
| 1000000    | 1.00     |

Native gas is not this scale: ETH is 18 decimals (wei) and SOL is 9 (lamports). A deposit is
always in the token's base units, never in wei.

## Hidden services

The devnet publishes **no `.anyone` node** at the time of writing, so there is no hidden-service
row in the tables above, and no address here to point anything at. That is a connector-side
deployment, not a gap in this client.

The client's support for one is complete and tested against a local SOCKS5 proxy. The live test in
`packages/client/src/__integration__/hidden-service.integration.test.ts` is skipped for exactly
that reason — inventing an address would be worse than skipping — and becomes real the day one
exists: set `TOON_HS_CONNECTOR`, `TOON_SOCKS` and `TOON_MNEMONIC` to run it. See
[hidden-service.md](hidden-service.md).
