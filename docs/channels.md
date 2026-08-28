# Payment channels

A **payment channel** is a two-party agreement, anchored on a chain, that lets value move between
you and a connector many times while touching the chain only to open, top up and close. It is
identified by its participants rather than by a name either party chose: both sides compute the
same identifier from the two of them and the token, so either can ask the chain whether it already
exists without being told anything. At most one is live per pair per token, on every chain.

Requests are paid by **claims** signed against the channel. A claim is a signed statement of the
channel's cumulative state, handed from payer to payee; each claim supersedes the last, so a lost
claim costs nothing and a replayed claim gains nothing. Signing a claim spends no gas. Only open,
deposit, close and settle are transactions.

## A route priced at zero needs no channel

Not every route costs money. A connector states a free one rather than implying it — every
terminated route must carry a price, and `price = 0` is how an operator writes down that they
meant it, because a route is never *silently* free.

Such a route runs no claim gate: an unpaid request to it is simply routed. So this client does not
open a channel, sign a claim or touch a chain to use one, and `send()` returns a result whose
`claim` is absent rather than zero-valued.

```ts
const answer = await client.send('g.toon.relay.ephemeral', { body: 'hello' });
answer.fulfilled;      // true — the app answered
answer.claim;          // undefined — nothing was paid, so there is no receipt
```

That makes a free route usable by a client holding no funds and no channel at all, which is what
it is for.

## You open it, not the connector

The connector has no endpoint that opens a channel for you, and it is not a defect. It reads the
chain, sees the channel exists with itself as counterparty, and accepts claims against it. Which
is why an unaffiliated buyer needs no prior arrangement with the operator: you register on chain,
which anyone can read, rather than with a person.

Every fact you need to open one comes from the node's own self-description — the chain, the
connector's settlement address, the token, its decimals, and the contract or program that holds
the channel. This client reads them from `GET /ilp` and never from a preset.

```ts
const description = await client.describe();
console.log(description.settlements);
```

## Collateral

`deposit` is the collateral locked on chain when the channel opens, in the **settlement token's
base units**. For 6-decimal USDC, `100000` is 0.10 USDC. It is not a native-coin amount and never
in wei. The same figure governs both chains: EVM locks it with `setTotalDeposit`, Solana with the
payment-channel `deposit` instruction.

```bash
npx toon channel open --deposit 100000
```

```ts
await client.channel.open({ deposit: 100_000n });
```

Off-chain claims are only worth what the channel is collateralized for, so an under-funded channel
signs claims that cannot be redeemed. The open fails fast — naming the wallet, the token and the
shortfall — rather than opening an uncollateralized channel. Fund the settlement wallet, or lower
the deposit.

The connector enforces the same bound from its side: a claim whose cumulative amount exceeds the
on-chain deposit is refused `F03` with an accumulated cost of `0`, and the **same nonce can be
resent unchanged** once you have deposited more. Nothing is lost by hitting the ceiling.

Adding collateral is monotonic on both chains — a deposit can never decrease:

```bash
npx toon channel deposit 100000
```

```ts
await client.channel.deposit(100_000n);
```

## What a channel id is derived from

Neither side names a channel. Both compute the same identifier, which is what lets either check
the chain for an existing one.

**EVM.** The two participants are sorted, and the `TokenNetwork` contract's `channelEpoch(min,
max)` counts how many channels that pair has already settled:

```text
channelId = keccak256(participant1 ‖ participant2 ‖ pad32(channelEpoch))
```

So re-opening after a settle produces a new id, and an open that is already live is found rather
than duplicated. This client derives the id, opens, and then asserts the id in the open's own log
matches — an open that produced a different id is a mismatch, not something to carry forward.

**Solana.** The channel is a program-derived address, and the vault holding the collateral is
another:

```text
channel = PDA(["channel", min(participants), max(participants), mint], programId)
vault   = PDA(["vault", channel], programId)
```

Being derived rather than minted, a Solana re-open re-derives the same account — which is why
losing a channel store hurts less on Solana than on EVM, and is not a reason to lose one.

## The watermark, and why the store must be durable

A claim's nonce must **strictly advance** the connector's watermark for the channel. The
connector's watermark is the highest nonce it has accepted; a claim that does not advance it is
refused before its signature is even checked.

That makes the nonce the one piece of state a payer cannot reconstruct. It is not on chain — no
chain indexes an off-chain claim — and the connector will not hand you a nonce to use. A process
that forgets which nonce it reached re-signs at one already banked, and every claim after that is
refused `F01`.

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
| `channels.json` | The claim watermark — nonce and cumulative amount — per channel |
| `channels.peers.json` (sibling) | Which on-chain channel this identity holds with each connector, per chain and settlement contract |

With both, opening — or the lazy open on the first paid request — **resumes** the existing channel
instead of opening a new one. Without them, every restart locks a fresh deposit. Solana happens to
survive it, because its channel id is a deterministic address; EVM's `openChannel` mints a new
`bytes32` per call, so each restart abandons one channel and its collateral.

Rules of the road:

- **Never delete these files for a live channel.** The collateral stays locked on chain and the
  watermark is unrecoverable. If the watermark for a bound channel goes missing, this client
  raises `ChannelResumeError` rather than silently restarting the nonce at zero. Resuming anyway
  would re-track a live channel at nonce 0 and every claim after it would be refused; opening a
  fresh channel instead would quietly strand the old collateral. Neither is safe to do without
  you: settle the old channel, or restore the file.
- A channel that has entered the withdraw flow — closed or settled — is not resumed. The next
  open is a fresh channel.
- The CLI defaults to `~/.toon/channels.json`. The library defaults to memory and warns, because
  a default that silently loses money would be worse than a warning.

## Asking the connector for its side

`claim-state` is a bulk, read-only answer to "what is the off-chain state of every channel I
control?" — deposit total, cumulative claimed, available balance, nonce and last-claim time.

```bash
npx toon claim-state
```

```ts
console.log(await client.claimState());
```

It exists because the watermark is known only to the channel's counterparty and the connector's
claim gate: an on-chain read gives you the deposit and the channel's existence for free, but not
the nonce. Each channel in the request is authenticated by its own signature over a **claim-state
challenge** — a message distinct in content and length from a real claim's, so a captured
challenge can never be replayed as a payment or the reverse. It changes no state and advances no
watermark, which is why it works when the channel has run dry: an agent that cannot afford a paid
request can still report its own runway.

Use it when your side and the connector's might disagree — after a crash mid-send, or when claims
are being refused for a reason you cannot see locally.

## Closing and settling

Closing starts a challenge period; settling pays out once that period has elapsed. Both are your
transactions.

```bash
npx toon channel close
# … wait out the challenge period …
npx toon channel settle
```

```ts
const { settleableAt } = await client.channel.close();
// … wait until settleableAt …
await client.channel.settle();
```

`settlementTimeout` is the challenge period in seconds, chosen at open. The default is 86400
(24 hours); the EVM `TokenNetwork` enforces a one-hour floor and this client raises anything lower
to 3600. On Solana it becomes the channel's `challenge_duration`, and the channel is settleable at
`closeTimestamp + challengeDuration`.

The period exists so the payee can redeem the latest claim it holds before the collateral is
released. Closing does not cancel claims you have already signed — they are the payee's, and it
can present them.

`client.close()` is a different thing entirely: it releases the websocket session and flushes the
channel store. It does not touch the channel.

## Choosing an EVM RPC

The RPC must be **read-after-write consistent**. Base Sepolia's public
`https://sepolia.base.org` is a load balancer: the `setTotalDeposit` that follows a just-confirmed
`openChannel` can land on a replica that has not seen the open and reverts `InvalidChannelState()`
(`0xf806e9d9`), leaving an open channel with no collateral.

This client polls the channel back before depositing and retries that specific revert, and gives
up with `StaleRpcReadError` naming the endpoint — but the cure is a consistent RPC.
`https://base-sepolia-rpc.publicnode.com` behaves correctly. Set it explicitly:

```ts
const client = await ToonClient.create({
  connector: 'https://proxy.ario.devnet.toonprotocol.dev',
  mnemonic: process.env.TOON_MNEMONIC,
  rpcUrl: 'https://base-sepolia-rpc.publicnode.com',
});
```

```bash
npx toon channel open --deposit 100000 --rpc https://base-sepolia-rpc.publicnode.com
```

## Gas

Opening a channel costs native gas — Base Sepolia ETH, or devnet SOL — and so do deposit, close
and settle. Paying for a request does not: it is a signature.

A wallet with the settlement token but no gas fails the open with `ChannelFundingError`, which
says so in as many words rather than surfacing the chain's own message about an account balance.
It is retryable once the wallet is funded.

The devnet faucet's EVM leg best-effort tops up ETH; its Solana leg drips USDC and no SOL, so a
Solana wallet needs `solana airdrop` first. See [devnet.md](devnet.md#faucet).
