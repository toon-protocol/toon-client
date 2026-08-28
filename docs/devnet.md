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

| Node | Client-edge URL | Route | Price | Carriage |
| --- | --- | --- | --- | --- |
| Store | `https://proxy.ario.devnet.toonprotocol.dev` | `g.toon.ario` | 1000 base units (0.001 USDC) | HTTP or BTP |
| Relay | `https://proxy.relay.devnet.toonprotocol.dev` | `g.toon.relay` | 1 base unit (0.000001 USDC) | HTTP or BTP |
| Relay | `https://proxy.relay.devnet.toonprotocol.dev` | `g.toon.relay.ephemeral` | free | HTTP or BTP |

`g.toon.relay.ephemeral` is priced at **zero**, which makes it the one route you can exercise the
whole wire against while holding no funds and no channel — see
[channels.md](channels.md#a-route-priced-at-zero-needs-no-channel). It is still a real paid-write
path in every other respect: the request is sealed, the condition is derived from the secret
inside the seal, and the app's answer comes back sealed.

A route may also be pinned to one carriage, in which case the node publishes
`requiredTransport` and a request over the other one is answered with the route's terms instead of
the work; see [errors.md](errors.md). None of the routes above is pinned today, so read the live
document rather than this table if it matters to you.

Client-edge paths on both, relative to the base URL above:

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
| Token network registry | `0x8263BdD4eB4862395Cb4ef5dA5d637F4b047Eea1` on Base Sepolia |
| Token network | `0xa79C3b1dbcEA00a6d84735a134395D8eF6D6a478` on Base Sepolia |
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
| Settlement token | `xyc5J8MgKFiEN13PnfftdXxUzYH34FEvw1LCrFwN7in` on Solana devnet — mock USDC SPL mint, 6 decimals |

A claim on this chain is an Ed25519 signature over a 96-byte message that binds the program id
above, so a claim cannot be replayed against another deployment of the same program.

## Faucet

`https://faucet.devnet.toonprotocol.dev`

| Path | Method | Body | What it drips |
| --- | --- | --- | --- |
| `/api/base-sepolia/request` | `POST` | `{ "address": "0x…" }` | Mock USDC on Base Sepolia, and a best-effort top-up of ETH for gas |
| `/api/solana/usdc-request` | `POST` | `{ "address": "<base58>" }` | Mock USDC on Solana devnet. **No SOL.** |
| `/api/info` | `GET` | — | What the faucet is configured to drip |

The Solana leg funds the token and nothing else, so a Solana wallet needs devnet SOL from
elsewhere before it can pay for the transactions that open and fund a channel:

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
