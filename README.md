# toon-client

Pay for an HTTP request, per request, in stablecoin — from Node.js or from the command line.

A **connector** is a paid reverse proxy: it fronts an ordinary HTTP app, charges a flat price
per route, and hands that app a request that was already paid for. This repository is the
payer. It seals your request into a packet addressed to a route, attaches a signed claim on a
payment channel you opened yourself on chain, and gives you back the app's HTTP response.

```text
  you                                connector                          app
   │                                     │                               │
   │  PREPARE (sealed request) + claim   │                               │
   ├────────────────────────────────────►│   plain HTTP, already paid    │
   │                                     ├──────────────────────────────►│
   │                                     │◄──────────────────────────────┤
   │◄────────────────────────────────────┤        HTTP response          │
   │  FULFILL (sealed answer), or        │                               │
   │  REJECT (a refusal, with its cost)  │                               │
```

## Install

```bash
npm install @toon-protocol/client
```

The CLI ships in the same package. `npx toon` runs it without a global install.

## Sixty seconds against the devnet

Asking a node what it is costs nothing and needs nothing — no wallet, no channel, no account:

```bash
npx toon describe https://proxy.relay.devnet.toonprotocol.dev
```

That prints its addresses, the key packets are sealed to, the chains it settles on, and every
route with its price. The devnet relay serves one priced at **zero**, so once you have an identity
you can exercise the whole wire without a channel or a single test token:

```bash
export TOON_CONNECTOR=https://proxy.relay.devnet.toonprotocol.dev
npx toon init                                        # an encrypted keystore at ~/.toon/keystore.json
npx toon send g.toon.relay.ephemeral --body 'hello'  # free: no channel, no claim
```

```text
FULFILL 200  (http)
  paid  nothing — this route is free
```

A `FULFILL` means the app answered and the packet was delivered. The app's own status rides inside
it — even a `4xx` is a real answer, and on a priced route it costs the same as a `200`.

### Then, a paid one

Both halves below do the same thing: open a channel with the devnet store node and buy one request
on `g.toon.store`, which costs 1000 base units (0.001 USDC) plus 10 per kibibyte of sealed
payload. `send()` works the total out from the node's own price list — you never compute it.

```bash
export TOON_CONNECTOR=https://proxy.ario.devnet.toonprotocol.dev

npx toon init                      # write an encrypted keystore at ~/.toon/keystore.json
npx toon faucet                    # devnet mock USDC for the address it just made
npx toon channel open --deposit 100000    # 100000 base units (0.10 USDC) of collateral
npx toon send --body 'hello'               # ~1010 base units, one request
```

```ts
import { ToonClient } from '@toon-protocol/client';

const client = await ToonClient.create({
  connector: 'https://proxy.ario.devnet.toonprotocol.dev',
  mnemonic: process.env.TOON_MNEMONIC,
  channelStore: `${process.env.HOME}/.toon/channels.json`,
});

await client.channel.open({ deposit: 100_000n }); // 100000 base units (0.10 USDC)

const answer = await client.send({ body: 'hello' });
if (answer.fulfilled) {
  console.log(answer.status, answer.text());       // the app's own HTTP response
  console.log(answer.claim.amount);                // 1010n base units — 1000 + 10/KiB
} else {
  console.log(answer.code, answer.message);        // a refusal, not an exception
}

await client.close();
```

Runnable versions of both, on each chain:
[`packages/client/examples/`](packages/client/examples/).

## Concepts in five bullets

- **A connector is a paid reverse proxy.** It fronts an app that knows nothing about payment,
  and delivers that app requests it has already collected for.
- **A packet carries its own claim.** Nothing is owed between requests: the claim that pays for
  a request travels with it, so there is never a balance for either side to walk away from.
- **You open the channel yourself, on chain.** The connector has no endpoint that opens one for
  you. It reads the chain, sees your channel, and accepts claims against it.
- **A price is flat per route.** One route, one price, whatever the payload — so a route's price
  is a figure you can ask for before you spend anything.
- **Reading a node's facts is free.** Its addresses, endpoints, sealing key, settlement terms and
  route prices come from one unauthenticated `GET`. Only the app's work costs money.

## What this is not

- **Not a Nostr client, and there is no relay.** Versions before 1.0 published events to relays
  and bootstrapped from announcements. All of it is gone: a node is a URL you configure, and its
  self-description is the whole of bootstrapping.
- **Not a way to open a payment channel through a connector.** Opening, funding, closing and
  settling are your own transactions, on your own gas, against the settlement contract the
  connector names. See [docs/channels.md](docs/channels.md).
- **Not RFC 0027 bytes on the wire.** The packet's semantics are ILPv4's; its encoding is TOON's
  own dialect and is not byte-compatible. An off-the-shelf ILPv4 encoder does not produce a
  packet this edge accepts. See [docs/how-a-paid-packet-works.md](docs/how-a-paid-packet-works.md).
- **Not a connector.** If you want to run a node, sell a route, or peer with someone, that is
  [toon-protocol/connector](https://github.com/toon-protocol/connector).

## Documentation

| Document | What is in it |
| --- | --- |
| [Getting started](docs/getting-started.md) | Nothing to a paid request, step by step, CLI and library |
| [Library API](docs/api.md) | `ToonClient`, its configuration, and every type it returns |
| [CLI reference](docs/cli.md) | Every command, resolution order, `--json`, exit codes |
| [Payment channels](docs/channels.md) | Collateral, the lifecycle on both chains, and the watermark |
| [How a paid packet works](docs/how-a-paid-packet-works.md) | The wire, top to bottom |
| [Devnet reference](docs/devnet.md) | Endpoints, routes, prices, contract addresses, faucet |
| [Errors and reject codes](docs/errors.md) | What each code means and what to do about it |
| [Troubleshooting](docs/troubleshooting.md) | Symptom, cause, fix |
| [Development](docs/development.md) | Build, test tiers, wire vectors, release |

## The protocol is the connector's

The wire is defined by the Rust connector, not by prose here:
[toon-protocol/connector](https://github.com/toon-protocol/connector) and its committed wire
vectors are the authority, and this client replays those vectors as its own conformance suite.
Where a document in this repository disagrees with them, they are right.

## License

MIT.
