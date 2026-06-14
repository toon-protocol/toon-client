---
name: toon-client
description: Act as a TOON Protocol client from a Claude agent (Desktop or Code)
  via the toon-* MCP tools backed by the toon-clientd daemon. Covers pay-to-write
  publishing ("how do I publish to TOON?", "how do I post a note on TOON?",
  toon_publish, paid write, payment-channel claim, balance proof, ILP/BTP),
  free reads ("how do I read from TOON?", "how do I subscribe to a TOON relay?",
  toon_subscribe, toon_read, NIP-01 filter, event buffer, cursor), channel and
  balance management ("how do I open a payment channel?", "how do I check my
  channel nonce/balance?", toon_open_channel, toon_channels, nonce watermark),
  mill swaps ("how do I swap tokens on TOON?", toon_swap, multi-chain swap),
  client status/identity ("am I connected to TOON?", "what is my TOON address?",
  toon_status, toon_identity, bootstrapping), and threshold/off-chain settlement
  semantics ("how does paying per write work on TOON?", "why is reading free?").
  Use whenever the user wants to publish, read, pay, or swap on the TOON network
  through the toon-* tools.
---

# TOON Client (agent surface)

This skill lets a Claude agent act as a **TOON Protocol client** through the
`toon-*` MCP tools. TOON is **pay-to-write Nostr over Interledger (ILP)**: a
write is an ILP packet carrying a TOON-encoded Nostr event plus a signed
off-chain payment-channel claim; reads are free. The tools are backed by an
always-on local daemon (`toon-clientd`) that owns the BTP session, payment
channels, signer keys, and a persistent relay subscription — the agent never
sees private keys.

Composes with `nostr-protocol-core` (event structure/kinds), `public-chat` and
`relay-discovery` (what to publish/where), and the RFC skills (`rfc-0001`,
`rfc-0027`, `rfc-0023`) for ILP/BTP internals.

## Mental model: pay-to-write, free-read

- **Write = pay.** Every `toon_publish` signs a payment-channel **claim** (an
  EIP-712 / chain-specific balance proof) for a small fee and sends it with the
  event over BTP to the apex/connector. The apex validates the claim, takes its
  fee, and forwards the event to the town relay, which returns FULFILL (accepted)
  or REJECT. Cost scales with encoded byte size — **be concise**.
- **Read = free.** `toon_subscribe` opens a persistent NIP-01 subscription on the
  town relay; `toon_read` drains buffered events. No payment, no claim.
- **Settlement is off-chain + threshold.** Each paid write advances a monotonic
  **nonce** and a cumulative amount on the channel; the connector settles
  on-chain only when a threshold is crossed. The nonce watermark is persisted by
  the daemon and **must never go backwards** (a regressed nonce invalidates the
  proof) — this is why a single daemon instance owns the channel.

## First call: check status

Always start with `toon_status`. The daemon's first bootstrap pays a one-time
anon-proxy + BTP warm-up (~30–90s). While it comes up, write tools return a
"still bootstrapping — retry shortly" message. `toon_status` reports:

- `bootstrapping` / `ready` — whether paid writes can go through yet,
- `identity` — your Nostr pubkey + EVM/Solana/Mina addresses,
- `relay` — connection + buffered-event count + active subscriptions,
- `network` — per-chain settlement readiness.

`toon_identity` returns just the public addresses (e.g. to fund a testnet wallet
or share an npub). It never returns private keys.

## Publishing (paid)

`toon_publish({ event, destination?, fee? })`

- `event` MUST be a **fully-signed** Nostr event (id + sig + pubkey + kind +
  created_at + tags + content). Build/sign it using the Nostr event rules from
  `nostr-protocol-core` and the relevant kind skill.
- `destination` defaults to the configured apex (`g.townhouse.town`).
- `fee` overrides the per-write fee (base units); default comes from daemon
  config.

Returns `{ eventId, channelId, nonce, data? }`. `nonce` advances by one per
successful publish. `data` carries FULFILL response bytes (e.g. an Arweave tx id
from a DVM job). A rejected write surfaces the relay/connector error (e.g. F06 =
parent/child mis-tagging) — report it; do not silently retry a rejected claim.

If the tool says it is bootstrapping, wait a few seconds and call `toon_status`
before retrying.

## Reading (free)

1. `toon_subscribe({ filters })` — `filters` is a NIP-01 filter object or array
   (e.g. `{ "kinds": [1], "authors": ["<hex>"] }`, `{ "#e": ["<id>"] }`).
   Returns `{ subId }`.
2. `toon_read({ subId?, cursor?, limit? })` — drains events newer than `cursor`.
   Pass the returned `cursor` back on the next call to get only new events
   (long-poll style). Without `subId`, drains across all subscriptions.

The daemon de-duplicates by `event.id` and auto-reconnects the relay socket, so
a subscription survives transient drops. Events are buffered (bounded ring); read
promptly if you expect high volume.

## Channels & balances

- `toon_open_channel({ destination? })` — pre-open (or fetch) the payment channel
  for a peer. Channels open lazily on the first publish; pre-open only when you
  need the `channelId` first.
- `toon_channels()` — list tracked channels with `nonce` (watermark) and
  `cumulativeAmount`. Use this to confirm a publish advanced the nonce or to
  inspect spend.

## Mill swaps (multi-chain)

`toon_swap({ destination, amount, toonData? })` pays a mill peer `amount` of
asset A and receives asset B plus a signed target-chain claim in the FULFILL
`data`. `destination` is the mill peer's ILP address. Returns
`{ accepted, data?, code?, message? }`.

## Failure & retry guidance

- **bootstrapping** → not an error; wait and retry after `toon_status` shows
  `ready: true`.
- **daemon not reachable** → the daemon failed to start; tell the user to check
  `~/.toon-client/daemon.log` and that their config (mnemonic/keystore + btpUrl)
  is set.
- **rejected (502)** → the relay/connector refused the claim or event; surface
  the `code`/`message` verbatim. Common causes: insufficient channel balance,
  parent/child tagging (F06), or an unconfigured settlement chain.
- Never fabricate a `nonce`, address, or eventId — read them from tool results.

## Social Context

Acting as a TOON client means spending real (testnet or mainnet) value on every
write, against a shared relay an operator pays to run. That shapes how an agent
should behave here, differently from a free Nostr relay:

- **Every publish costs money and is irreversible.** The fee leaves the user's
  payment channel and advances a nonce that can't go backwards. Before a burst of
  writes, tell the user what will be published and roughly what it costs; don't
  loop `toon_publish` on failures without surfacing why. Conciseness is courtesy
  and economy — cost scales with encoded byte size.
- **Reads are free, so prefer reading first.** Use `toon_subscribe`/`toon_read`
  to check whether something already exists before paying to publish it again.
- **The daemon holds the user's keys; the agent does not.** Treat addresses and
  channel balances as the user's financial state — report them faithfully, never
  invent them, and flag anything that looks like unexpected spend (a nonce
  jumping, a channel you didn't open).
- **A rejected write is the operator's network telling you something.** Surface
  the connector/relay `code` + `message` verbatim (e.g. F06 parent/child,
  insufficient balance, unconfigured chain) rather than silently retrying — a
  blind retry can still cost a fee.
