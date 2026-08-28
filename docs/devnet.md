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

`GET /ilp` is free and unauthenticated, and every settlement fact in it was proved against a live
chain when the node booted. The table below is a convenience — a URL to put in an example, a
default RPC, an address to check a balance against. When the two disagree, the node is right, and
this client never consults a preset in preference to the document a node answers with.

The same values ship as `DEVNET` in `@toon-protocol/client`, for the same reason and with the same
caveat.

## Nodes

Three nodes, six routes. Each node is its own settlement counterparty, so a
channel opened with one buys nothing at the others.

| Node | Client-edge URL | Route | Price | Carriage |
| --- | --- | --- | --- | --- |
| Store | `https://proxy.ario.devnet.toonprotocol.dev` | `g.toon.store` | 1000 **+ 10 per KiB** | HTTP or BTP |
| Gas station | `https://proxy.gas.devnet.toonprotocol.dev` | `g.toon.gas` | 1000 base units (0.001 USDC) | HTTP or BTP |
| Relay | `https://proxy.relay.devnet.toonprotocol.dev` | `g.toon.relay` | 1 base unit (0.000001 USDC) | **BTP only** |
| Relay | `https://proxy.relay.devnet.toonprotocol.dev` | `g.toon.relay.ephemeral` | free | HTTP or BTP |
| Relay | `https://proxy.relay.devnet.toonprotocol.dev` | `g.toon.relay.store` | 1001 **+ 10 per KiB** | HTTP or BTP |
| Relay | `https://proxy.relay.devnet.toonprotocol.dev` | `g.toon.relay.gas` | 1001 base units | HTTP or BTP |

The last two are **forwarded**: the relay carries the packet to the store or the
gas station and charges its own hop on top. Forwarding runs one way — the leaves
do not carry back to the relay.

A forwarded route needs one thing a direct one does not. The payload is sealed to
the connector that *terminates* the route, and no hop may name that key on the
terminator's behalf, so you name the far node yourself with `sealTo`:

```ts
const answer = await client.send('g.toon.relay.gas', { body: 'hello' }, {
  sealTo: 'https://proxy.gas.devnet.toonprotocol.dev',
});
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
path in every other respect: the request is sealed, the condition is derived from the secret
inside the seal, and the app's answer comes back sealed.

A route may also be pinned to one carriage, in which case a request over the other one is answered
with the route's terms instead of the work; see [errors.md](errors.md). `g.toon.relay` is pinned to
BTP today — an HTTP send to it is refused `TRANSPORT_REQUIRED`. Note that the deployed node does
**not** currently publish a `requiredTransport` for it, so the pin cannot be discovered from
`GET /ilp` and is only learned by being refused. Read the live document rather than this table if
it matters to you.

Client-edge paths on all three, relative to the base URL above:

| Path | Method | What it is |
| --- | --- | --- |
| `/ilp` | `GET` | The node's self-description. Free. |
| `/ilp` | `POST` | A PREPARE, `application/octet-stream`. The paid path. |
| `/ilp/btp` | `GET` | Websocket upgrade for the BTP carriage. |
| `/ilp/probe` | `POST` | A packet sent to be refused, to learn what a path costs. |
| `/ilp/identity` | `GET` | The key a payload is sealed to. Free. |
| `/ilp/routes/price?destination=` | `GET` | One route's price. Free. `404` when no route matches. |
| `/ilp/claim-state` | `POST` | The connector's own watermark for channels you control. |

## Base Sepolia (EVM)

| Fact | Value |
| --- | --- |
| Chain id | 84532 |
| RPC | `https://sepolia.base.org` |
| Token network registry | `0x0c41D9D424d6B075A3cEa1068a694f7847a8CCa5` on Base Sepolia |
| Token network | `0xe9E05dfecfe165266C88d73e61D483612651952a` on Base Sepolia |
| Settlement token | `0x49beE1Bca5d15Fb0963117923403F9498119a9Ce` on Base Sepolia — mock USDC, 6 decimals, ungated `mint()` |

A claim on this chain is an EIP-712 signature under the domain `TokenNetwork` / version `1` /
chain id 84532 / `verifyingContract` = the token network above. The channel id is derived from
the two participants and the channel epoch; see [channels.md](channels.md).

`https://sepolia.base.org` is a load balancer and is not read-after-write consistent. That has a
real failure mode when opening a channel — see
[channels.md](channels.md#choosing-an-evm-rpc).

## Solana devnet (Solana)

| Fact | Value |
| --- | --- |
| Cluster | devnet, the public cluster — not a local validator |
| RPC | `https://api.devnet.solana.com` |
| Payment-channel program | `2aEVJ8koKD8LTZrLRSGtAtU7LBt4e7QjjCgf1kzQ7Rip` on Solana devnet |
| Settlement token | `34eSxY7qxQ4GzyhDJ8GpUcTz1WWzruGbJbR8q6TtxfQU` on Solana devnet — mock USDC SPL mint, 6 decimals |

A claim on this chain is an Ed25519 signature over a 96-byte message that binds the program id
above, so a claim cannot be replayed against another deployment of the same program.

## Faucet

`https://faucet.devnet.toonprotocol.dev`

| Path | Method | Body | What it drips |
| --- | --- | --- | --- |
| `/api/base-sepolia/request` | `POST` | `{ "address": "0x…" }` | Mock USDC on Base Sepolia. **No ETH** — the gas drip is disabled |
| `/api/solana/usdc-request` | `POST` | `{ "address": "<base58>" }` | Mock USDC on Solana devnet. **No SOL.** |
| `/api/info` | `GET` | — | What the faucet is configured to drip |

**Neither leg funds gas.** Both drip the settlement token and nothing else, so a wallet needs
Base Sepolia ETH, or devnet SOL, from elsewhere before it can pay for the transactions that open
and fund a channel:

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

Every amount on the wire is an integer in the settlement asset's base units. The settlement token
is 6-decimal USDC on both chains, so:

| Base units | USDC |
| --- | --- |
| 1 | 0.000001 |
| 1000 | 0.001 |
| 100000 | 0.10 |
| 1000000 | 1.00 |

Native gas is not this scale: ETH is 18 decimals (wei) and SOL is 9 (lamports). A deposit is
always in the settlement token's base units, never in wei.
