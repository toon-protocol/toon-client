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

### The client asks for you, after a request whose fate it does not know

One disagreement it settles on its own. A request that **times out** may still have been
delivered: the connector banked the claim, and this end saw nothing. The client repays the amount
locally — being one claim short spends nothing, where running ahead spends the deposit on nothing —
but that guess would otherwise stand forever, and every later claim under-advances by the same gap
and is refused (`F03`, then `F01`).

So a transport error, a timeout, or a refused claim marks the channel's watermark **doubtful**, and
the next request on it runs `claim-state` for that one channel *before* signing, adopting the
connector's figure. The doubt is durable — it is written into `channels.json`, so a timeout in one
`toon` invocation is settled by the next one — and it is cleared for free by the first claim the
connector banks, so a healthy channel never pays for the read.

Two things it will not do. It never adopts a cumulative **higher than this client has ever
signed**: a connector can only bank a claim it holds a signature for, so a larger figure is not a
fact about your channel. And it never lowers a nonce, because re-issuing a claim at a spent nonce
is how a payer double-spends against itself.

If the read itself fails — the connector that just timed out may still be unreachable — the request
goes out on the local figure as before, and the next one asks again.

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

### Onboarding without gas: x402 `batch-settlement`

Connector ADR 0074 lets a client pay from an x402 `batch-settlement` channel instead. That channel
is payer-only, sits on x402's own contract (Base) or solana-foundation's payment-channels program
(Solana), and is opened with no native gas:

- On Base, a stock x402 facilitator submits the deposit and pays its gas.
- On Solana, the receiving connector sponsors the `open`.

Opt in with `batchSettlement`:

```ts
const client = await ToonClient.create({
  connector: 'https://node.example',
  mnemonic,
  channelStore: '~/.toon/channels.json',
  batchSettlement: { facilitatorUrl: 'https://x402.org/facilitator', deposit: 1_000_000n },
});
```

When the node's `GET /ilp` offers `batch-settlement` on your chain, the first paid `send()` deposits
`deposit` through the facilitator. The deposit creates the channel, and the packet then carries a
voucher instead of a claim. A node that offers no such channel is paid over `toon-channel` exactly
as without the option.

- **A voucher has no nonce.** Each one signs the running total, and the connector accepts it only
  if it goes up by at least the route's charge. A free route carries no voucher.
- **A voucher whose fate is unknown stays counted.** A timeout may or may not have been banked. So
  the next voucher signs above it either way, overpaying by at most one charge if it never
  arrived. Only a refusal gives a charge back.
- **The store is the watermark.** The connector's `claim-state` does not answer for these channels
  yet (toon-protocol/connector#1364). A lost store can only be recovered to what the chain shows
  landed, so set `channelStore`.
- **Top-ups** go through the facilitator the same way, when the deposit cannot cover the next
  voucher.
- **Solana needs no `facilitatorUrl`.** The first paid `send()` builds the `open`, signs the
  payer's slot, and posts it to the `sponsorEndpoint` the node publishes. The node co-signs as fee
  payer and `rent_payer`, submits it, and pays the fee and the rent. The payer's USDC token
  account must already exist and hold the deposit. The deposit is at least the node's
  `minDeposit`. A refusal is a `SponsorRefusedError` carrying the node's own reason.
- **A Solana top-up would need SOL**, because the node sponsors opens and nothing else. So a
  Solana channel whose deposit cannot cover the next voucher is replaced by a fresh sponsored
  one, and the old binding is archived. What is left in the old channel returns to the payer when
  the node closes it.
- **Permit2.** `depositMethod: 'permit2'` is for a token without ERC-3009. It needs a one-time
  Permit2 `approve` from the payer, which costs native gas unless the facilitator sponsors it.

The building blocks are exported too: the channel config and id, voucher signing and claims on
both chains, the deposits and `settleDeposit`, and the sponsored Solana `open`.
