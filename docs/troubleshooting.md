# Troubleshooting

Symptom, cause, fix. For the meaning of a specific code, see [errors.md](errors.md).

## Setup and configuration

**`toon-client` says there are no keys, or "run `toon-client init`".**
No `TOON_MNEMONIC` in the environment and no keystore at `~/.toon/keystore.json`. Run
`toon-client init`, or point `--keystore` at the file you have.

**The command hangs, or fails asking for a password, in CI.**
The keystore password has nowhere to come from and stdin is not a terminal. Set
`TOON_KEYSTORE_PASSWORD`, or pass `--password-file`.

**A warning says it is falling back to the devnet connector.**
No `--connector` and no `TOON_CONNECTOR`. That is deliberate and deliberately loud: a request
going somewhere you did not name should not be silent. Set one.

**Upgrading to 1.0 and the EVM address changed — the channel and its deposit are gone.**
They are not gone, they are at the old address. Before 1.0 the EVM key was derived at a
different BIP-44 coin type, because one secp256k1 key served two roles; 1.0 derives it at the
standard Ethereum path. A keystore written before 1.0 is read as
`legacy` and keeps its old addresses automatically — but a **raw phrase** handed to
`ToonClient.create` gets the new derivation. Pass `keyDerivation: 'legacy'`, or run
`toon-client identity --all-derivations` to see both. See
[api.md](api.md#key-derivation).

**"is a hidden service, which is reachable only through a SOCKS5h proxy".**
The connector is a `.anyone` address and the library was given no `socksProxy`. The library never
starts a daemon itself — set `socksProxy` to a running `anon` daemon, or use the `toon-client` CLI, which
starts one for you. See [hidden-service.md](hidden-service.md).

**"Transaction … may still be mined" / "may still land" (`TransactionOutcomeError`, `outcome: 'unknown'`).**
A chain write was sent and the RPC stopped answering before its outcome showed. It may still land.
Look `txHash` up on an explorer before doing anything that would repeat it. On Solana a repeated
deposit deposits twice. `outcome: 'expired'` (Solana) means the opposite: it can no longer land,
and sending it again is safe.

**"use the .anyone TLD", or "is a Tor hidden service".**
`.anon` is not a routable hidden service — `anon` treats it as a clearnet name and fails much later
with `HostUnreachable` — and `.onion` belongs to Tor, which this client does not dial. Only
`<address>.anyone` is routed. The `.anon` message carries the corrected address.

**"No SOCKS5 proxy at 127.0.0.1:9050".**
Nothing is listening there. Start the daemon, or let `toon-client` start one. This check runs before the
first packet on purpose: discovering it later costs a signed voucher.

**A hidden-service request is slow, or times out the first time.**
Building a circuit to a cold hidden service takes tens of seconds. The per-packet timeout already
defaults to 120 s on this path; raise `timeoutMs` if your node is slower still. A second request
over the same client reuses the circuit and is far quicker.

**`toon-client` pauses on a `.anyone` connector, or fails to start a daemon.**
The first run downloads and verifies a pinned `anon` release, then waits up to 90 s for it to
bootstrap; the stderr lines say which step it is on. It needs `unzip` on PATH (PowerShell on
Windows) and a platform with a pinned checksum — an unpinned one is refused rather than trusted.
On an unsupported or offline machine, run your own daemon and pass `--socks`.

**`ChainUnavailableError`, listing networks.**
The chain you asked for is not among the node's `batchSettlements`, or you hold no key for any it
offers. `offered` lists the networks the node does offer, in CAIP-2; pick one of those, or
construct from a mnemonic so both keys exist.

## Opening and funding a channel

**`FacilitatorError` on `channel open` or `deposit` (Base).**
The x402 facilitator answered and did not settle the deposit. `reason` is its own. Usually the
wallet holds less USDC than the deposit — run `toon-client faucet`. No channel was funded. Under the
default `depositGas: 'auto'` you only see this when the wallet holds no ETH either; with ETH, the
client deposits directly instead.

**`InsufficientBalanceError` about a Permit2 approval.**
The token has no ERC-3009, so its deposit goes through Permit2, which needs a one-time approval.
The facilitator sponsors none that fits this token, and the wallet holds no ETH to send it
itself. Send the wallet a little ETH, or use a facilitator that offers x402's
`erc20ApprovalGasSponsoring` (or, for a permit token, `eip2612GasSponsoring`).

**`ConfigError` asking for `facilitatorUrl` or ETH.**
The node is paid on an EVM network where neither you nor the connector names a facilitator, and
this client will not pick a third party to relay real money. Set `facilitatorUrl` (or
`--facilitator`), or hold a little ETH and the client deposits directly.

**`SponsorRefusedError` on a Solana open.**
The node's sponsor endpoint declined to open the channel. `reason` names why
(`token_program_unsupported`, `sponsor_busy`, …). A `502` is the one case where the open may still
have landed; the next use reads the chain and keeps it if so.

**`InsufficientBalanceError` on a Solana open.**
The payer's USDC token account does not exist yet, or holds less than the deposit (which is at
least the node's `minDeposit`). Draw USDC from the faucet first; the open needs no SOL.

**The faucet returned success and the balance did not move.**
On the Solana leg this is a known shape: a real transaction signature, zero delivered. `transfer`
raises `TransferNotDeliveredError` for exactly this, because it confirms by an observed balance
change rather than by the call returning. Re-check with `toon-client balances` and ask again.

**A restart opened a second channel and locked another deposit.**
No channel store, so nothing remembered which channel this identity held — and an x402 channel's
config cannot be recovered from the chain. Set `channelStore` (the CLI already defaults to
`~/.toon/channels.json`). A channel whose config was lost cannot be left by this client. See
[channels.md](channels.md#the-watermark-and-why-the-store-must-be-durable).

**`channel close` or `settle` fails for want of gas.**
Leaving a channel is the payer's own transaction, the one step that costs native gas: Base Sepolia
ETH, or devnet SOL (`solana airdrop 1 <address> --url https://api.devnet.solana.com`). The other
channels in the same run are still attempted.

## Sending

**`F03` on every request, `accumulatedCost` equal to the route's price.**
The voucher underpaid. Usually an explicit `amount` lower than the price, or a stale cached price.
Send the route's price — `accumulatedCost` on that refusal *is* the price.

**`F03` with `accumulatedCost` of `0`.**
The cumulative amount would exceed what the channel holds. A library client tops up on its own;
with `autoOpenChannel: false` (the CLI), run `toon-client channel deposit` (Base) or `toon-client channel open`
after the Solana channel is replaced. Nothing was consumed.

**`F01`, repeatedly.**
The connector would not accept the voucher: it does not verify, the channel is one the node has no
record of, or the claim is of a retired kind. Check `toon-client channel status --connector-view` against
`toon-client describe`.

**A request timed out, and the next one was refused.**
The packet may have been delivered anyway, and the connector banked the voucher. The client
already assumes so: a voucher whose fate is unknown stays counted, so the next one signs above it.
Where a refusal still says the voucher "goes backwards", the client asks `claim-state` before the
next voucher and adopts the connector's figure — never below what the connector is proven to
hold (what the chain landed, a voucher it banked, or the refused one), nor above what this client
signed. If refusals persist, that read is failing too —
check that the client edge is reachable (over `--socks`, for a hidden service). See
[channels.md](channels.md#the-watermark-and-why-the-store-must-be-durable).

**The connector's figure is ahead of this client's, after restoring a backup.**
A channel store restored from an older copy is behind what was signed since, and the client never
adopts a connector figure above what its own store says it signed — a connector can only hold a
voucher it was given. `toon-client claim-state` shows the connector's side. Restore the newest copy; never
edit the store by hand. A store whose watermark file is missing outright *is* rebuilt, from the
chain and then from `claim-state`.

**Every request refused with `PAYMENT_REQUIRED` even though a channel is open.**
The voucher header is not reaching the connector, or the channel is on a different chain from the
ones the node is paid on. Check `describe()`'s `batchSettlements` against `client.chain`.

**`TRANSPORT_REQUIRED`, or `F02` over BTP with terms attached.**
The route accepts one carriage and you used the other. `answer.terms.requiredTransport` names the
one it wants. The devnet relay route is BTP-only: `--transport btp`, or `transport: 'btp'`.

On `transport: 'auto'` this should never happen — `auto` reads the pin off the route's own entry in
`GET /ilp` and dials it. If it does, that node is not publishing the pin it enforces: run
`toon-client describe` and look for a carriage beside the route's price. A node with none, on a route that
refuses you, is the defect connector ADR 0072 closes, and naming the carriage by hand is the only
thing you can do until that node is upgraded.

**`T04` and a message naming a cap.**
The packet exceeds the largest amount that connector will forward to one peer in a single packet.
It is never split. Send a smaller one — the message is the only place that cap is published.

**`413` from the connector.**
The body exceeded 2 MiB. There is no configuration knob for it on the connector side.

**`400` from the connector.**
The body was not a decodable PREPARE. If you are forming packets by hand, note that the encoding
is TOON's dialect and not RFC 0027's — see
[how-a-paid-packet-works.md](how-a-paid-packet-works.md#the-packet-is-ilpv4s-semantics-in-toons-encoding).

**`SealedResponseError`.**
A FULFILL came back that is not a readable sealed response. Value moved, so this is not an outcome
to work around: it is a broken counterparty, or a sealing key that rotated mid-flight. Re-read
`describe({ fresh: true })` and try once; if it persists, report it against the node.

## Reading the answer

**`fulfilled: true` but the status is `500`. Was I charged?**
Yes. The packet reached the app and the app answered; a non-2xx from the app costs exactly what a
`200` costs. `answer.claim.amount` is what it cost. Only a refusal short of the app is
`fulfilled: false`.

**`price()` returns `null`.**
The connector serves no route matching that destination. It is an answer, not a failure — check
the prefix against `describe()`'s `routes`. Routing is longest-prefix.

**`probe()` fails with `403`.**
Probing is free traversal, gated on having paid before: it resends your latest voucher, and it is
rate-limited per channel. Send at least one paid request first — before that, `probe()` throws
`ChannelNotOpenError` without asking.

**A reject says `refusedBy: 'path'` and I want to know who refused.**
Nobody can tell you. A plaintext reject is unauthenticated by construction: it may be a hop, or a
termination that could not open the wrap. Only a **sealed** reject proves the destination itself
said no. Do not read a plaintext reject as an accusation.

## Still stuck

- `toon-client describe` and `toon-client channel status --connector-view` show, between them, almost everything
  either side believes.
- `toon-client claim-state` works when the channel has run dry, which is when you most need it.
- The wire is the connector's: [toon-protocol/connector](https://github.com/toon-protocol/connector)
  and its committed vectors are the authority.
