# Payment channels

A **payment channel** is an x402 `batch-settlement` channel: a deposit this client locks on chain,
payable to one connector, that lets it pay that connector many times while touching the chain only
to open, top up and leave. It is the only way this client pays (connector ADRs 0074 and 0075).

- **Base:** x402's own `x402BatchSettlement` contract.
- **Solana:** solana-foundation's `payment-channels` program.

A channel is one-way, payer to connector.

Requests are paid by **vouchers** signed against the channel. A voucher states the channel's
**cumulative** total, so each one supersedes the last: losing one costs nothing, and replaying one
gains nothing. Signing a voucher costs no gas. Opening a channel costs no native gas either (see
[Opening costs no gas](#opening-costs-no-gas)). Leaving a channel does.

## A route priced at zero needs no channel

Not every route costs money. A connector states a free route explicitly: every terminated route
must carry a price, and an operator writes `price = 0` to say they meant free. A route is never
*silently* free.

A free route runs no claim gate, so an unpaid request to it is simply routed. This client opens no
channel, signs no voucher and touches no chain to use one. `send()` then returns a result with no
`claim`, rather than a zero-valued one.

```ts
const answer = await client.send('g.toon.relay.ephemeral', { body: 'hello' });
answer.fulfilled;      // true — the app answered
answer.claim;          // undefined — nothing was paid, so there is no receipt
```

That lets a client with no funds and no channel use a free route, which is what free routes are for.

## Where the terms come from

Every fact needed to open a channel comes from the node's own self-description, which this client
reads from `GET /ilp`, never from a preset:

- the network (CAIP-2);
- the token;
- the connector's receiving address;
- the withdrawal delay;
- on Solana, also the sponsor key, the minimum deposit and the sponsor endpoint.

```ts
const description = await client.describe();
console.log(description.batchSettlements);   // one entry per chain the node is paid on
```

A 402 greeting carries the same facts in `accepts[]`, priced for the route.

## Opening costs no gas

The first paid `send()` opens a channel by itself, unless `autoOpenChannel` is `false`. You can
also open one explicitly:

```bash
npx toon channel open --deposit 1000000
```

```ts
await client.channel.open();
```

- **Base.** This client signs a deposit authorization. An x402 **facilitator** submits it and pays
  the gas, so a wallet holding USDC and no ETH can open a channel. The facilitator is, in order:
  your `facilitatorUrl` (or `--facilitator`); the one the connector names in its terms, since the
  seller pays the gas as a cost of the sale; the devnet's own
  (`https://onboard.devnet.toonprotocol.dev`) on Base Sepolia. A wallet holding ETH can also pay
  the gas itself; see [Who pays the gas](#who-pays-the-gas).
- **Solana.** This client builds and signs the `open`, then posts it to the `sponsorEndpoint` the
  node publishes. The connector co-signs as fee payer, submits it, and pays the fee and the rent.
  Two conditions apply:
  - The payer's USDC token account must already exist and hold the deposit.
  - The deposit is at least the node's `minDeposit`.

  A refusal throws `SponsorRefusedError`, carrying the node's own reason.
- **Any ERC-20.** A connector names how its token moves (`assetTransferMethod`): `eip3009` for
  USDC-style tokens, `permit2` for any other ERC-20. `depositMethod` overrides it. A Permit2
  deposit first needs Permit2 approved for the token, and this client arranges it the cheapest way
  there is:
  - the token has an EIP-2612 permit and the facilitator offers `eip2612GasSponsoring`: the permit
    rides inside the deposit, and the payer sends nothing;
  - the token has neither, and the facilitator offers `erc20ApprovalGasSponsoring`: the payer signs
    `approve(Permit2, …)` without sending it, and the facilitator funds its fee and broadcasts it;
  - otherwise the payer sends the approval itself, once, from its own ETH.

## Deposits

`deposit` is what a channel opens with, and what it is topped up by. It is in the token's **base
units**: for 6-decimal USDC, `100000` is 0.10 USDC. It is never a native-coin amount. The default
is `100000n`.

A voucher can only claim up to what the channel holds. When the deposit cannot cover the next
voucher, this client tops the channel up by itself (again unless `autoOpenChannel` is `false`):

- **Base.** A further deposit goes through the facilitator, the same way the first one did.
- **Solana.** The connector sponsors opens and nothing else, so a top-up would need SOL. Instead, a
  fresh sponsored channel replaces the old one, and the old binding is archived. What is left in
  the old channel comes back when it is left (see [Leaving a channel](#leaving-a-channel)).

You can top up by hand on Base:

```bash
npx toon channel deposit 1000000
```

```ts
await client.channel.deposit(1_000_000n);
```

## What a channel id is derived from

A channel id is not assigned by either side.

- **Base.** The id is `getChannelId(config)`: the EIP-712 hash of the channel's config, bound to the
  chain and the contract. The config includes a random salt.
- **Solana.** The channel is a program-derived address. It is derived from the payer, the sponsor,
  the mint, the voucher signer, a salt and the slot it was opened at.

Either way, **the chain never gives the config back**. The id alone does not tell you how to
recompute it, and a channel whose config is lost cannot be found again from the wallet. That is why
the store must be durable.

## The watermark, and why the store must be durable

A voucher has **no nonce**. Each one signs the running total, and the connector accepts it only if
it advances the connector's own watermark by at least the route's charge. So the one number to
keep is the cumulative amount, and the channel config must survive with it.

Set `channelStore` whenever the process can restart:

```ts
const client = await ToonClient.create({
  connector: 'https://proxy.ario.devnet.toonprotocol.dev',
  mnemonic: process.env.TOON_MNEMONIC,
  channelStore: `${process.env.HOME}/.toon/channels.json`,
});
```

It persists two things:

| File | Contents |
| --- | --- |
| `channels.json` | The watermark per channel: the cumulative amount, and the highest amount ever signed |
| `channels.peers.json` (sibling) | Each channel this identity holds with each connector: its full config, its deposit, the last voucher sent, and whether it is being left |

With both files present, the next paid request **resumes** the existing channel instead of opening a
new one. Without them, every restart opens a fresh channel and locks a fresh deposit. The CLI
defaults to `~/.toon/channels.json`. The library defaults to memory and warns about it, because a
default that silently loses money would be worse than a warning.

Rules of the road:

- **Nothing leaves before it is recorded.** A deposit or a sponsored open is written down as
  pending *before* it is sent. If the facilitator or the connector lands it and then fails to
  answer, the next use reads the chain and keeps the channel. If it never landed, the channel is
  forgotten.
- **A voucher whose fate is unknown stays counted.** After a timeout, the connector may or may not
  have banked the voucher. The next voucher signs above it either way, which overpays by at most one
  charge if the first never arrived.
- **A refusal says where the node stands.**
  - An underpayment names how far the voucher advanced the connector's watermark, and the next
    voucher is priced from that figure.
  - A voucher that "goes backwards" is the connector saying it holds more than this client
    thought. The count moves up to everything ever signed, and the client asks `claim-state`
    before the next voucher.
  - Any other refusal gives the charge back, unless a later voucher has already superseded the
    refused one.
- **A lost watermark is rebuilt.** Its floor is what the chain shows landed. After that, the
  connector's own figure from `claim-state` replaces it.
- **Never delete these files for a live channel.** The deposit stays locked on chain, and without
  the config you cannot leave the channel.

## Asking the connector for its side

`claim-state` is a read-only answer, in bulk, to "where does the connector stand on each channel I
hold?" For each channel it reports:

- the cumulative amount the connector has accepted;
- the most a voucher may name right now;
- what the next voucher may add;
- when it last claimed.

```bash
npx toon claim-state
npx toon channel status --connector-view   # the same figures, beside this client's own
```

```ts
console.log(await client.claimState());
```

Each channel in the request is authenticated by a **voucher claim-state challenge** that the
channel's voucher signer signs. The challenge is distinct from a voucher, so a captured challenge
can never be replayed as a payment, and it expires within minutes. The same challenge proves the
channel on a BTP session's `auth` message. The challenge changes no state and advances no
watermark, so it still works when the channel has run dry. An agent that cannot afford a paid
request can still report its own runway.

The exact bytes are pinned by the connector's wire vectors, vendored at
`packages/client/src/wire/vectors/` (`voucher_claim_state_challenge`,
`client_auth_channel_challenge`).

## Leaving a channel

Leaving is the payer's own transaction on its own chain account. It is the one step that costs
native gas: Base Sepolia ETH, or devnet SOL.

```bash
npx toon channel close
# … wait out the withdrawal delay (Base) or the grace period (Solana) …
npx toon channel settle
```

```ts
const closing = await client.channel.close();   // one result per channel
// … wait until each result's settleableAt …
await client.channel.settle();
```

- **Base:**
  1. `close()` calls `initiateWithdraw` for everything the connector has not claimed. The connector
     sees it and claims its latest voucher.
  2. After `withdrawDelay`, `settle()` calls `finalizeWithdraw`.
- **Solana:**
  1. `close()` sends `request_close`. During the grace period, the connector lands its latest
     voucher and seals the channel.
  2. After the grace period, `settle()` seals the channel if the connector has not already, then
     calls `withdraw_payer`, which returns what the connector did not claim.

What `close()` and `settle()` cover:

- `close()` covers every open channel with the node, including ones that a newer channel replaced.
- `settle()` also takes back a Solana channel that the connector sealed first.
- A channel with nothing left to take back is marked settled without a transaction.
- One channel failing does not stop the rest. Its result carries an `error`.

Once a channel is closing, the next paid `send()` opens a fresh one.

Neither chain has a cooperative refund. On Base it would need the connector's `receiverAuthorizer`
signature, and the connector never refunds.

Closing does not cancel vouchers you have already signed. They belong to the connector, which can
claim them until the channel is settled.

`client.close()` is a different thing entirely. It releases the websocket session and flushes the
channel store, and it does not touch any channel.

## Who pays the gas

Nothing in x402 pays a facilitator: the contract has no fee field. Gas is paid by whoever wants
the deposit to happen, and in TOON that is the seller, which names the facilitator it pays through.
A payer holding its own ETH needs no one. `depositGas` (`--deposit-gas`) says which:

| `depositGas` | Base deposit, and a Permit2 token's approval |
| --- | --- |
| `auto` (default) | the facilitator when there is one and it will; otherwise this wallet, if it holds ETH |
| `facilitator` | only ever the facilitator; this wallet's ETH is never spent |
| `self` | always this wallet, and no facilitator is contacted |

Under `auto`, a facilitator that is down or refuses is not the end: a wallet holding ETH puts the
same signed deposit on chain itself. That can never deposit twice. Both paths spend one
authorization whose nonce is single-use on chain, so if the facilitator's did land, the direct
one reverts.

| Step | Native gas |
| --- | --- |
| Paying for a request | none (a signature) |
| Opening or topping up, Base, ERC-3009 token | none through a facilitator; one deposit otherwise |
| Opening, Base, Permit2 token, first time | none through a sponsoring facilitator; one approval otherwise |
| Opening, Solana | none (the connector sponsors) |
| Leaving (`close`, `settle`) | yes, the payer's own transaction |

The devnet faucet drips USDC on both chains. Leaving a Solana channel needs SOL, so run `solana
airdrop` first. See [devnet.md](devnet.md#faucet).

## Building blocks

The pieces are exported for callers building something of their own:

- the channel config and id on both chains;
- voucher signing and the claims built from it;
- the claim-state challenges;
- the deposits and `settleDeposit`;
- the sponsored Solana `open`;
- the exit transactions.

See [api.md](api.md).
