# Troubleshooting

Symptom, cause, fix. For the meaning of a specific code, see [errors.md](errors.md).

## Setup and configuration

**`toon` says there are no keys, or "run `toon init`".**
No `TOON_MNEMONIC` in the environment and no keystore at `~/.toon/keystore.json`. Run
`toon init`, or point `--keystore` at the file you have.

**The command hangs, or fails asking for a password, in CI.**
The keystore password has nowhere to come from and stdin is not a terminal. Set
`TOON_KEYSTORE_PASSWORD`, or pass `--password-file`.

**A warning says it is falling back to the devnet connector.**
No `--connector` and no `TOON_CONNECTOR`. That is deliberate and deliberately loud: a request
going somewhere you did not name should not be silent. Set one.

**Upgrading to 1.0 and the EVM address changed — the channel and its collateral are gone.**
They are not gone, they are at the old address. Before 1.0 the EVM key was derived at a
different BIP-44 coin type, because one secp256k1 key served two roles; 1.0 derives it at the
standard Ethereum path. A keystore written before 1.0 is read as
`legacy` and keeps its old addresses automatically — but a **raw phrase** handed to
`ToonClient.create` gets the new derivation. Pass `keyDerivation: 'legacy'`, or run
`toon identity --all-derivations` to see both. See
[api.md](api.md#key-derivation).

**`ChainUnavailableError`, listing chains.**
The chain you asked for is not among the node's settlements, or you hold no key for any it
offers. The error lists what the node does offer; pick one of those, or construct from a mnemonic
so both keys exist.

## Opening and funding a channel

**`ChannelFundingError` on `channel open`.**
The wallet holds the settlement token but no native gas. Opening is a transaction; paying for
requests is not. Get Base Sepolia ETH, or devnet SOL. On Solana the faucet drips USDC and **no
SOL** — use `solana airdrop 1 <address> --url https://api.devnet.solana.com` first.

**The open reverts with `InvalidChannelState()` (`0xf806e9d9`).**
The RPC is not read-after-write consistent: `setTotalDeposit` landed on a replica that had not
seen `openChannel`. This client retries that specific revert and then gives up with
`StaleRpcReadError` naming the endpoint. The cure is a consistent RPC — see
[channels.md](channels.md#choosing-an-evm-rpc).

**The faucet returned success and the balance did not move.**
On the Solana leg this is a known shape: a real transaction signature, zero delivered. `transfer`
raises `TransferNotDeliveredError` for exactly this, because it confirms by an observed balance
change rather than by the call returning. Re-check with `toon balances` and ask again.

**A restart opened a second channel and locked another deposit.**
No channel store, so nothing remembered which channel this identity held. Set `channelStore` (the
CLI already defaults to `~/.toon/channels.json`). The abandoned channel's collateral is still
there: close and settle it to get it back. See
[channels.md](channels.md#the-watermark-and-why-the-store-must-be-durable).

## Sending

**`F03` on every request, `accumulatedCost` equal to the route's price.**
The claim underpaid. Usually an explicit `amount` lower than the price, or a stale cached price.
Send the route's price — `accumulatedCost` on that refusal *is* the price.

**`F03` with `accumulatedCost` of `0`.**
The cumulative amount would exceed the channel's on-chain deposit. Deposit more, then **resend the
same nonce**: nothing was consumed.

**`F01` "unknown channel", repeatedly.**
The connector has no record of the channel your claim names. Either the channel is on a chain this
node does not settle on, or it has been closed and settled, or the persisted binding names one
that no longer exists. This client evicts the binding and retries once; if it keeps happening,
check `toon channel status --connector-view`.

**`F01` for a nonce that does not advance.**
Your watermark is behind the connector's — the classic symptom of a lost or restored-from-backup
channel store. `toon claim-state` shows the connector's side. Never patch a nonce by hand;
resuming with a wrong one refuses every claim after it.

**Every request refused with `PAYMENT_REQUIRED` even though a channel is open.**
The claim header is not reaching the connector, or the channel is on a different chain from the
one the route settles in. Check `describe()`'s `settlements` against `client.chain`.

**`TRANSPORT_REQUIRED`, or `F02` over BTP with terms attached.**
The route accepts one carriage and you used the other. `answer.terms.requiredTransport` names the
one it wants. The devnet relay route is BTP-only: `--transport btp`, or `transport: 'btp'`.

**Parallel requests fail with nonce errors that a serial run does not produce.**
Parallel HTTP requests can race their own claim nonces. Use the BTP carriage: one ordered socket
cannot race itself. Or serialize the sends.

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
Probing is free traversal, gated on having paid before: it needs a channel the connector
recognizes, and it is rate-limited per channel. Open a channel and send at least one paid request
first.

**A reject says `refusedBy: 'path'` and I want to know who refused.**
Nobody can tell you. A plaintext reject is unauthenticated by construction: it may be a hop, or a
termination that could not open the wrap. Only a **sealed** reject proves the destination itself
said no. Do not read a plaintext reject as an accusation.

## Still stuck

- `toon describe` and `toon channel status --connector-view` show, between them, almost everything
  either side believes.
- `toon claim-state` works when the channel has run dry, which is when you most need it.
- The wire is the connector's: [toon-protocol/connector](https://github.com/toon-protocol/connector)
  and its committed vectors are the authority.
