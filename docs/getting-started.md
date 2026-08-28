# Getting started

From nothing to a paid request against the public devnet, and back again after a restart. Every
step is given twice: once as the `toon` CLI, once as the library.

You need Node.js 22 or newer. Nothing else — no local chain, no node of your own.

## What you are about to do

You will make a wallet, fill it with devnet test funds, lock some of them into a payment channel
on chain, and then buy one HTTP request from an app behind a connector. The channel is the slow,
on-chain part and you do it once; requests after that are signatures, not transactions.

The node used throughout is the devnet store, `https://proxy.ario.devnet.toonprotocol.dev`,
which serves the route `g.toon.store` at 1000 base units (0.001 USDC) plus 10 per kibibyte of
sealed payload. See
[devnet.md](devnet.md) for the full table.

## Install

```bash
npm install @toon-protocol/client
```

The `toon` CLI ships in the same package; `npx toon` runs it without a global install.

## Step 1 — a wallet

One BIP-39 phrase derives both chain keys: an EVM key at `m/44'/60'/0'/0/0` and a Solana key at
`m/44'/501'/0'/0'`. The EVM half is on the standard path, so the same phrase typed into an
ordinary wallet shows you the same address.

```bash
npx toon init
```

That writes an encrypted keystore at `~/.toon/keystore.json` — scrypt and AES-256-GCM, mode
`0600` — and prints the phrase once, for you to write down. It is not stored anywhere else.

```bash
npx toon identity
```

```text
  evm         0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266  m/44'/60'/0'/0/0
  solana      oeYf6KAJkLYhBuR8CiGc6L4D4Xtfepr85fuDgA9kq96  m/44'/501'/0'/0'
  derivation  standard
  keys from   TOON_MNEMONIC
```

Those particular addresses come from the well-known test phrase every local chain ships with, so
they are safe to print here — **yours will differ, and are the only ones worth funding.** The
paths are shown because they are what makes the EVM half importable into an ordinary wallet.

As a library, hand the phrase in directly:

```ts
import { ToonClient } from '@toon-protocol/client';

const client = await ToonClient.create({
  connector: 'https://proxy.ario.devnet.toonprotocol.dev',
  mnemonic: process.env.TOON_MNEMONIC,
  channelStore: `${process.env.HOME}/.toon/channels.json`,
});

console.log(client.identity.evmAddress);
console.log(client.identity.solanaPublicKey);
```

`ToonClient.create` reads the node's self-description, derives your keys, picks a chain and opens
the channel store. It sends no transaction and spends nothing.

If you are upgrading from a pre-1.0 keystore, read
[the derivation note in api.md](api.md#key-derivation) first: an old keystore keeps its old
addresses, deliberately.

## Step 2 — funds

Two different things are needed, and they are easy to confuse.

- **The settlement token** — mock USDC — is what a channel is collateralized with and what every
  request is paid in.
- **Native gas** — Base Sepolia ETH, or devnet SOL — is what the transactions that open and fund
  the channel cost. Requests themselves spend no gas.

```bash
npx toon faucet
```

The faucet's EVM leg mints mock USDC and best-effort tops up ETH. Its Solana leg drips USDC and
**no SOL**, so on Solana get SOL first:

```bash
solana airdrop 1 <your base58 address> --url https://api.devnet.solana.com
```

```ts
await client.wallet.faucet('evm');
```

Check what arrived:

```bash
npx toon balances
```

```ts
console.log(await client.wallet.balances());
```

## Step 3 — a channel

A payment channel is a two-party agreement anchored on chain that lets value move between you and
the connector many times while touching the chain only to open, top up and close. You open it
yourself: the connector has no endpoint that opens one for you, it simply reads the chain and
sees that your channel exists.

```bash
npx toon channel open --deposit 100000
```

100000 base units is 0.10 USDC — collateral, in the settlement token's base units, never in wei.
At 1000 base units (0.001 USDC) per request that is a hundred requests before the channel needs
a top-up.

```ts
const channel = await client.channel.open({ deposit: 100_000n });
console.log(channel.channelId, channel.available); // 100000n base units (0.10 USDC)
```

Both are idempotent: run against a connector you already hold an open channel with, they adopt it
rather than opening a second one. Adding more collateral later:

```bash
npx toon channel deposit 100000
```

```ts
await client.channel.deposit(100_000n);
```

[channels.md](channels.md) has the rest — closing, settling, and what the channel id is derived
from.

## Step 4 — one paid request

```bash
npx toon send g.toon.store --body 'hello'
```

```ts
const answer = await client.send('g.toon.store', {
  method: 'POST',
  headers: { 'content-type': 'text/plain' },
  body: 'hello',
});
```

Behind that one call: the client reads the route's price, seals your request to the connector's
identity key, signs a claim advancing the channel by that price, and sends both as one packet.
[how-a-paid-packet-works.md](how-a-paid-packet-works.md) walks the whole wire.

## Step 5 — reading the result

`send` returns an outcome. It does not throw on a refusal — a refusal is an answer about the
network, and everything this client *does* throw happened before the packet went out or on chain.

```ts
if (answer.fulfilled) {
  answer.status;              // the app's own HTTP status
  answer.headers;             // [name, value][], in order
  answer.text();              // the body, as UTF-8
  answer.json();              // the body, parsed
  answer.claim.amount;        // 1000n base units (0.001 USDC) — what this cost
  answer.claim.nonce;         // the nonce this claim carried
} else {
  answer.refusedBy;           // 'destination' | 'path' | 'edge'
  answer.code;                // 'F03', 'F01', 'PAYMENT_REQUIRED', …
  answer.message;
  answer.accumulatedCost;     // what the path costs, when the connector said
}
```

A `404` from the app is a real, paid answer: it arrives on a FULFILL and costs exactly what a
`200` costs. Only a refusal short of the app is `fulfilled: false`.

The CLI prints one JSON document with `--json`, and exits `3` on a refusal:

```bash
npx toon send g.toon.store --body 'hello' --json
```

```json
{
  "fulfilled": true,
  "transport": "http",
  "status": 200,
  "headers": [["content-type", "application/octet-stream"], ["content-length", "34"]],
  "body": "ZGVsaXZlcmVkIGJ5IHN0dWIgYXBwOiBqc29uIHBsZWFzZQ==",
  "text": "delivered by stub app: json please",
  "fulfillment": "jPo1IwR2rxlICypi1c48W5uW127WVkVf/IiEsMmut54=",
  "claim": {
    "channelId": "0xf5e0ecad66f856dc2a186635388804dfdbd241c690c27bfa7762250fbbb8af9b",
    "chain": "evm",
    "nonce": 8,
    "cumulative": "5000",
    "amount": "1000"
  }
}
```

`body` is base64 because a response is bytes; `text` is beside it when those bytes decode as
UTF-8. Every amount is a decimal string, never a JSON number — a figure past 2^53 is a real
amount and rounding one silently would be worse than refusing to print it.

The `claim` block is the receipt: which channel paid, at what nonce, and what the channel's
cumulative total became. `fulfillment` is the proof the packet reached its intended receiver.

Every code, and what to do about each one, is in [errors.md](errors.md).

## Step 6 — after a restart

A claim's nonce must strictly advance the connector's watermark for your channel. A process that
forgets which nonce it reached re-signs at one already banked, and every claim after that is
refused. So the watermark has to outlive the process.

The CLI persists it at `~/.toon/channels.json` by default. The library defaults to memory, which
is almost never what you want:

```ts
const client = await ToonClient.create({
  connector: 'https://proxy.ario.devnet.toonprotocol.dev',
  mnemonic: process.env.TOON_MNEMONIC,
  channelStore: `${process.env.HOME}/.toon/channels.json`, // set this
});
```

With it set, the next process resumes the same channel at the next nonce, sends no transaction,
and locks no second deposit. Without it — on EVM especially, where each open mints a new channel
id — every restart strands a deposit in an abandoned channel.

**Never delete that file for a live channel.** The collateral stays locked on chain and the
watermark is unrecoverable. If the watermark for a bound channel goes missing, the client refuses
to guess: it raises `ChannelResumeError` rather than silently restarting the nonce at zero.

To compare your side against the connector's:

```bash
npx toon claim-state
```

```ts
console.log(await client.claimState());
```

That is an owner-authenticated read: one signature per channel, over a challenge distinct from a
claim, so it can never be replayed as a payment. It works when the channel has run dry, which is
exactly when you need it.

## Where to go next

- [api.md](api.md) — every method, option and returned type
- [cli.md](cli.md) — every command, the resolution order, exit codes
- [channels.md](channels.md) — collateral, the lifecycle, the watermark
- [how-a-paid-packet-works.md](how-a-paid-packet-works.md) — the wire
- [`packages/client/examples/`](../packages/client/examples/) — runnable versions of the above
