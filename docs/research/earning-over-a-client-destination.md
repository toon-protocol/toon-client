# Can an agent earn over a client destination, with no node of its own?

Research note, 2026-10-01, for
[toon-client#719](https://github.com/toon-protocol/toon-client/issues/719) (part of the map
[#715](https://github.com/toon-protocol/toon-client/issues/715)). Not user-facing documentation and
not normative. It decides nothing.

**The question.** Could an agent earn over a client destination, holding only an outbound BTP
session and running no connector? Who funds the payout channel?

**How to read this.** Section 1 is the short answer. Sections 2 to 4 are sourced facts. Section 5
is analysis and is labelled as such. Section 6 lists what contradicts the map's Notes, section 7
the questions sharp enough to be tickets, section 8 what is not verified, section 9 the sources.

**Evidence labels.** *(verified)* means read in the owning source at the pinned commit.
*(inference)* means my reasoning from verified facts. *unverified* means I could not confirm it
from a primary source. Nothing here was run: no connector was started and no packet was sent.

**Citation shorthand.** `C/<path>:<line>` is the connector at
`toon-protocol/connector@8b938f9b0ebf460232bc4342e9174a50ba070a72`. `T/<path>:<line>` is this
repository at `0a6019aeb7a7175aeeb7f2bec57f3b155dfbd918`. `M/<path>:<line>` is
`toon-protocol/toon-meta@bb518c13ed518c6af6659580e1ca0e2607e5638b`. Section 9 says how far each pin
is from its upstream.

**Vocabulary.** The connector's `CONTEXT.md`: *client destination*, *route termination*,
*operator*, *sponsor*, *facilitator*, *voucher*. "Seller" and "buyer" are toon-meta#265's words for
the two ends of one job. "Hosting connector" is a working name for the connector a seller's session
is bound on; it is not a glossary term.

---

## 1. Short answer

**The connector half is built and live in source. The client half was built, then deleted. And the
money path has a hole: the hosting connector pays the seller the packet's full amount out of the
operator's own deposit, and nothing in the code makes the buyer pay the connector for it.**

So a "pay and earn, but run nothing" tier does not exist today as a product. The mechanism for it
exists on one side. Making it real needs a receiving API in this client, an operator willing to
open and fund a channel toward each seller by hand, and a fix or a decision about who covers the
payout.

| Question | Answer |
|---|---|
| Built or only decided? | Connector: built (routing, lease, payout voucher, resend). Client: receiving frames are parsed and dispatched, but nothing answers them; the earning API was deleted in the 1.0 restructure. |
| What makes a client addressable? | A non-empty `peerId` on its BTP `auth` frame. The address is whatever string it sent, unverified. It lasts as long as the socket, with a 120 second silence backstop. |
| Who funds the payout channel? | The hosting connector's operator, on both chains, by a signed `POST /channels`. The connector never opens or tops one up itself. |
| Who seals to whom? | The buyer seals to the seller's own key, learned from a signed Nostr event. No connector's identity key is involved. |
| Does this client receive today? | No. `ToonClient` registers no handler for an inbound MESSAGE, and has no code to land a voucher as a channel's receiver. |
| What does the operator configure? | Nothing in the config file. One signed operator write per seller per chain, carrying that seller's channel terms and a deposit. |

---

## 2. What the connector does

### 2.1 The routing arm is live *(verified)*

`session_route::route_prepare` is the one function both client-edge ingresses call:
`POST /ilp` (`C/crates/connector-client-edge/src/lib.rs:1386-1387`) and a client BTP frame
(`C/crates/connector-client-edge/src/btp.rs:977-978`). Its order
(`C/crates/connector-client-edge/src/session_route.rs:75-159`):

1. Look up the destination in the session registry (`:81`). No session bound: the ordinary router
   answers, usually `F02`.
2. A session is bound and a configured **terminated** app route also matches: refuse with `T00` and
   log at `error` (`:98-104`, `:327-342`). This is ADR 0032's rule.
3. Otherwise ask the ordinary router first (`:121-129`). Any answer other than `F02` stands, so a
   configured forwarding route always wins over a session.
4. Only on `F02`: send the PREPARE down the bound socket as a server-originated BTP MESSAGE
   (`:140-147`) and wait for the client's RESPONSE.
5. The client's answer is decoded as a FULFILL or a REJECT and returned to the sender unchanged
   (`:308-316`). Anything else becomes `T01`.
6. On a FULFILL, pay the session (`:149-156`). See 2.4.

The connector does not open the payload and does not derive a fulfilment on this path. That
matches the `CONTEXT.md` definition of a client destination (`C/CONTEXT.md:170-174`).

### 2.2 The lease: what the client does to be addressable *(verified)*

- **How.** The client's first BTP MESSAGE carries an `auth` entry, JSON `{peerId, secret}`. A
  non-empty `peerId` binds the session in the registry under that exact string
  (`C/crates/connector-client-edge/src/btp.rs:313-321`, `:617-643`). The `secret` is not checked.
  Opening the transport is permissionless (`C/docs/protocol/client-edge-spec.md:986-995`).
- **The address.** It is the `peerId` string, verbatim. The connector does not assign it, does not
  check that it sits under the connector's own prefix, and does not check that the client owns it.
- **Last bind wins.** `bind` always replaces the previous binding for that string and returns a
  higher generation number (`C/crates/connector-client-edge/src/session_registry.rs:134-151`). Two
  sockets can declare the same `peerId`; the newer one receives the packets.
- **How long.** Until the socket's read loop ends, which unbinds at once (`btp.rs:193-195`,
  `session_registry.rs:171-179`). A socket that goes silent is dropped after 120 seconds, checked
  on lookup (`session_registry.rs:82`, `:190-203`). The same figure is published as
  `sessionLeaseTtlMs` on every greeting (`C/docs/protocol/client-edge-spec.md:667-678`).
- **No session, no delivery.** A dead or missing session answers `T01`, retryable, with nothing
  charged (`session_registry.rs:288-296`).

### 2.3 Who can reach a client destination *(verified)*

Only a sender on the hosting connector's **own client edge**.

- A packet arriving from a peer goes to `Connector::handle_peer_prepare`
  (`C/crates/connector-peer-btp/src/accept.rs:473-476`,
  `C/crates/connector-peer-http/src/accept.rs:269-272`). That function is in `connector-runtime`,
  which cannot see the session registry (`C/crates/connector-client-edge/src/session_route.rs:5-8`).
- A packet the operator originates (`POST /packets`, which `connector send` drives) calls
  `Connector::handle_prepare` directly (`C/crates/connector-operator/src/lib.rs:422-449`).
- `route_prepare` has exactly two callers, both named in 2.1.

So a PREPARE forwarded across a peering to the hosting connector, addressed to a bound session, is
answered `F02`. A client destination is not reachable through the mesh. This is absence, read by
searching every caller of the three `handle_*prepare*` functions; no test asserts it either way.

### 2.4 The payout: how the seller is paid *(verified)*

- **The channel.** One x402 `batch-settlement` channel from the connector to the client, separate
  from the channel the client pays in on. Nothing nets
  (`C/docs/protocol/client-edge-spec.md:260-263`, `C/docs/adr/0075-...md:236-248`).
- **Who opens and funds it.** The operator, by a signed `POST /channels` carrying the client's
  `terms` and a `deposit` (`C/crates/connector-operator/src/lib.rs:833-838`, `:928-947`). The
  connector never opens or tops up a payout channel on its own
  (`C/docs/protocol/client-edge-spec.md:1090-1098`, `C/docs/adr/0075-...md:336-337`).
- **Which key is paid.** The session's **payee key**: the voucher signer of a channel the *client*
  holds toward the connector, as the chain records it. The client proves it either by paying a
  voucher on the session, or by a `channelChallenge` on its `auth` frame
  (`btp.rs:272-293`, `:397-427`; spec `:997-1022`, `:1099-1104`). There is no client-declared payout
  address. A new session starts with no payee
  (`C/crates/connector-client-edge/src/claim_gate.rs:374-392`, `:555-569`).
- **Finding the channel.** A lookup of the connector's own opened outbound channels whose receiver
  is that key (`C/crates/connector-runtime/src/batch_channels.rs:683-695`).
- **The amount.** `prepare.amount`, whole, with no fee taken
  (`session_route.rs:107`, `:155`; `claim_gate.rs:617-638`).
- **When nothing is paid.** No payee proved, or no open channel toward it, or the channel cannot
  back the amount: the packet still answers FULFILL, and the seller gets nothing. The connector logs
  a warning that names `POST /channels` or `POST /channels/:id/fund`
  (`C/crates/connector-client-edge/src/outbound_ledger.rs:163-221`).
- **Delivery.** A BTP TRANSFER on the same session, carrying the voucher as `payout-claim` JSON.
  It stays pending until the client answers with a RESPONSE, and is resent on the next delivery or
  when a new session proves the same key (`session_route.rs:258-287`; spec `:1116-1136`).
- **Wired in production.** `connector-cli` gives the claim gate a payout ledger whenever the node
  has outbound channels (`C/crates/connector-cli/src/runtime.rs:1511-1514`).
- **Vector.** `payout_voucher`, one EVM and one Solana case, each with the JSON and the whole
  TRANSFER frame (`C/vectors/wire-vectors.json:716-`).

**Per chain** *(verified)*:

| | EVM | Solana |
|---|---|---|
| Payer | The connector's EVM settlement address; `payerAuthorizer == payer` (`C/docs/adr/0075-...md:102-120`). | The connector's Solana settlement key, also `authorized_signer` (`:137-149`). |
| Opening | The connector sends `deposit` itself and pays its own gas. No facilitator (`:113-114`). | The connector posts a payer-signed `open` to **the client's** `sponsorEndpoint` (`:145-147`; `batch_channels.rs:998-1019`). |
| Receiver's seats | `receiver` and `receiverAuthorizer` are both the client's address. | The client holds fee payer, `rent_payer` and `payee`. |
| What the client needs | Its address. Native gas to land a voucher. | A reachable HTTP sponsor endpoint, SOL for fees and about 0.0047 SOL of rent per channel (`C/docs/adr/0075-...md:421-423`). |

The Solana row matters: a client with only an outbound socket has no sponsor endpoint to publish.

### 2.5 What the buyer pays the hosting connector *(verified)*

Nothing is enforced.

- The charge for a packet is read from the configured route the destination matches. No route
  matches a session address (if one did, 2.1 step 2 or 3 would have answered), so the charge is
  `Price::FREE` (`lib.rs:1265-1274`; `btp.rs:727-735`).
- With a charge of zero, an unpaid PREPARE is not greeted and passes through
  (`lib.rs:1302`; `btp.rs:799`). The module says so: "nothing here is ever priced"
  (`session_route.rs:38-45`).
- The bound on a packet's amount applies only to a forwarded route (`lib.rs:1122-1142`).
- If the buyer does attach a voucher, it is judged against the charge, zero, so any advance is
  accepted (`C/crates/connector-domain/src/claim.rs:118-152`). Nothing compares the voucher's
  advance with `prepare.amount`.
- The connector's own integration test shows the shape: the buyer sends a PREPARE for `amount` over
  plain `POST /ilp` with **no claim header**, and the connector then pays the session `amount`
  (`C/crates/connector-client-edge/tests/client_payouts.rs:464-521`). The unit test at the real call
  site does the same with `client_channel_id = None` (`session_route.rs:861-932`).

### 2.6 Who seals to whom, and what the fulfilment proves *(verified)*

- **Sealing.** The buyer seals the PREPARE's `data` to the seller's `seal_pubkey`, a key on the
  seller's signed `kind:31990` event, never a connector's identity key
  (`C/docs/adr/0032-...md:66-72`; `M/docs/mesh-compute-job-protocol.md:125-126`, `:322-324`). The
  seller unseals with its own private key. The hosting connector forwards bytes it cannot read.
- **What the buyer must know first.** Two things, both from that signed event: the seller's ILP
  address (`ilp_dest`) and its sealing key (`seal_pubkey`). Plus, from somewhere, which connector
  hosts the session, since 2.3 means the buyer must be that connector's client.
  `M/docs/mesh-compute-job-protocol.md:126` gives the example `g.toon.relay.<client-id>`, which
  implies the address names the host by prefix; nothing in the connector enforces that.
- **The fulfilment is unchecked by every hop.** `Prepare` no longer carries an execution condition
  (`C/docs/adr/0069-...md:59-76`). A session's FULFILL "rides home unchecked"
  (`session_route.rs:296-307`; test `:541`). The only check left is the sender's own.

---

## 3. What this client does

### 3.1 The receiving side *(verified)*

- **Frames are parsed.** `IsomorphicBtpClient` recognises a server-originated MESSAGE or TRANSFER
  and offers `onMessage` and `onTransfer` hooks
  (`T/packages/client/src/btp/IsomorphicBtpClient.ts:26-37`, `:92-103`, `:521-534`).
- **Nothing registers them.** `ToonClient` builds its BTP session with no `onMessage` and no
  `onTransfer` (`T/packages/client/src/client/ToonClient.ts:554-573`). With no handler, an inbound
  MESSAGE gets no answer at all (`IsomorphicBtpClient.ts:540-542`); the connector waits, times out
  and answers the buyer `T01`. An inbound TRANSFER is acknowledged with an empty RESPONSE
  (`:552-565`), which the connector reads as "voucher received" and stops resending
  (`C/.../session_route.rs:283-285`).
- **The session is already bound, though.** `ToonClient` sends `peerId: this.identity.senderId`,
  which defaults to the paying chain's address (`ToonClient.ts:213`, `:559`). It also declares its
  channel by `channelChallenge` by default (`T/packages/client/src/client/config.ts:198`;
  `ToonClient.ts:570-572`, `:605-610`). So every BTP `ToonClient` today is a registered client
  destination at its own chain address, with a proven payee, and no way to answer.
- **No receiver-side settlement.** The channel code calls `deposit`, `approve`, `initiateWithdraw`
  and `finalizeWithdraw`. There is no `claim` or `settle` call
  (`T/packages/client/src/channel/batch-settlement/`).
- **The vector is carried and not replayed.** `payout_voucher` is listed under
  `sectionsPresentNotYetReplayed`, with the comment "this client is payer-only"
  (`T/packages/client/src/wire/vectors/wire-vectors.provenance.json`;
  `T/packages/client/src/wire/vectors/load.ts:415-416`;
  `T/packages/client/src/wire/wire-vectors.test.ts:211-215`).
- **The CLI has no command for any of it.**

### 3.2 It used to *(verified)*

`packages/client/src/serve-job.ts` was an earning API: `createJobMessageHandler` plugged a
`JobHandler` into `onMessage`, opened the gift wrap with the client's own key, checked the
handler's fulfilment against the PREPARE's condition, and answered FULFILL or REJECT. It arrived in
`d54324c` (#494) and gained sealing in `c90cd38` (#539). Commit `efd6397` ("The 1.0 client", #619,
2026-08-28) deleted it with `mesh-compute-job.test.ts` when the workspace collapsed to "the payer
and nothing else". `CLAUDE.md` and `CONTEXT.md` both now say this repository is only the payer.

The deleted code cannot be restored as it was: it checked `sha256(fulfilment)` against
`executionCondition`, a field ADR 0069 has since removed from the packet.

---

## 4. Where prose and code disagree

| Prose | Code |
|---|---|
| ADR 0032 says the client's fulfilment is "verified against the packet's own execution condition ... or the packet is rejected" (`C/docs/adr/0032-...md:50-52`). | Nothing verifies it. ADR 0069 removed the field and made the session's FULFILL pass through (`session_route.rs:296-307`). ADR 0032 carries no note of this; the index marks 0019 as corrected by 0069 but not 0032 (`C/docs/adr/README.md:174-178`). |
| The mesh-compute spec has the buyer set `executionCondition` to the seller's `condition`, and the buyer's connector check `sha256(fulfilment)` against it (`M/docs/mesh-compute-job-protocol.md:322-323`, `:340`). | The field does not exist on the wire. The hashlock that ADR 0032 and toon-meta#265 decision 6 exist to protect is now only a check the buyer can make after the fact, against a condition it read from the seller's Nostr event. |
| Spec §1.9 says "nothing in this connector originates a request yet" and "Today's deployed client never sends TRANSFER and never receives a server-originated MESSAGE" (`C/docs/protocol/client-edge-spec.md:975-982`). | `route_prepare` originates a MESSAGE and a TRANSFER in production (2.1, 2.4). |
| Spec §1.9 ends "No production caller decides when to push a job to a client session yet" (`:1187-1191`). | Same. The module doc records the caller (`session_registry.rs:43-53`). |
| Issue #736's acceptance criteria asked that "a delivered job packet is priced and accounted exactly as an app-route termination is". | It is unpriced (2.5). The module doc records that the old charging check was retired with the execution condition (`session_route.rs:42-45`). |
| toon-meta#265 says earnings net "off-chain on the same channel". | ADR 0075 decision 7 retired netting. A payout rides its own channel. |

The spec's later "Update" paragraphs under §1.9 step 7 (`:1087-1137`) are accurate and match the
code. The stale text is the older framing around them.

---

## 5. Analysis

Everything in this section is *(inference)* from the facts above.

### 5.1 Who is at risk, and of what

**The hosting operator** carries all of it.

- It locks a deposit per seller, per chain, and gets it back only by withdrawing after the
  counterparty's delay, one day by default (`C/docs/adr/0075-...md:405-406`, `:418-420`).
- **The deposit can be drained for free.** Read 2.4 and 2.5 together. A seller with a funded payout
  channel can send itself PREPAREs through the connector's own client edge with no claim attached,
  answer each with any 32 bytes, and collect a voucher for each packet's `amount` until the channel
  is empty. Nothing ties the payout to money received. Dedupe does not help: it is keyed on the
  hash of the PREPARE bytes, so a different `data` is a different job.
  An honest buyer using this client would sign a voucher for the amount, because that is how it
  pays; the connector does not require it to. I did not run this. It is the plain reading of the
  code, and the connector's own tests exercise the claimless path.
- A second socket declaring the same `peerId` takes the packets. It cannot take the money: a
  payout goes to the payee the *fulfilling session* proved, on a channel only that key can land
  (connector#1396, closed). It can refuse or black-hole the seller's work.

**The seller** risks little money and a lot of dependence.

- It is paid only if the operator opened a channel toward it and keeps it funded. If not, it does
  the work and the packet answers FULFILL with nothing paid.
- It must first hold a channel of its own toward the connector, to prove a payee key. That needs
  a deposit (the facilitator can cover gas on EVM).
- Pending vouchers are held in memory (`outbound_ledger.rs:99-101`). The signed watermark is
  journaled and a voucher is cumulative, so the money is not lost, but after a connector restart
  an undelivered voucher is not resent until the next job is paid.
- To turn a voucher into tokens it lands it on chain itself, with its own gas.

**The buyer** has no hashlock. It learns the fulfilment after its voucher is already accepted.

### 5.2 Does a "pay and earn, but run nothing" tier exist?

**Not today.** One half of it is built.

- *Decided:* yes, in ADR 0032 and toon-meta#265 decision 6, for one use (a laptop selling
  inference behind NAT).
- *Built in the connector:* yes. Routing, lease, payee proof, payout voucher, resend and a wire
  vector are all in production code paths.
- *Built in this client:* no. It was, and it was removed on purpose.
- *Funded:* by hand, by the hosting operator, one signed write per seller. Nothing automates it,
  and nothing the operator collects covers it.

If it were finished, here is what the tier could not do that a node can:

| A node | A client destination |
|---|---|
| Reachable from anywhere in the mesh, over peerings. | Reachable only by direct clients of its one hosting connector (2.3). |
| Prices its own routes; the price is published and collected before work. | Has no price on the wire. The amount is whatever the buyer's packet says. |
| Collects on a channel the buyer funds. | Is paid from a channel the host funds, when the host chooses to. |
| Can be paid on either chain. | EVM only in practice; Solana needs a reachable sponsor endpoint (2.4). |
| Owns its address. | Holds a string anyone can re-declare (2.2). |
| Forwards for neighbours and earns a fee. | Cannot forward. |
| Serves an ordinary HTTP app, payment-oblivious. | Must speak BTP, unseal the gift wrap and produce a fulfilment itself. |
| Stays up as a hidden service. | Is addressable only while its socket is open. |

It could do one thing a node does not: earn from behind NAT with no inbound reachability and no
hidden-service daemon.

### 5.3 What it means for the map

The map's destination has every agent run a full node, reached as a hidden service. That removes
the reason ADR 0032 gave for rejecting "make the seller a peer": a peer needs inbound reachability
(`C/docs/adr/0032-...md:88-92`), and an onion endpoint supplies it. Under the map's design a client
destination is a second way to do something the first way already does, with a weaker trust
position for the host and no mesh reach.

It is also a product the map's buyer cannot use. The map says an agent pays through its own node's
peerings; a client destination cannot be reached that way (2.3).

So for the client's role ticket ([#722](https://github.com/toon-protocol/toon-client/issues/722)):
"the client is the light earner" is not a role this client can take up cheaply. It would need new
client code, a connector change to make the buyer cover the payout, and an answer to who funds
channels for strangers.

---

## 6. What contradicts the map's Notes

Nothing in "Settled before charting" is contradicted. Three notes need a qualifier:

1. **"0018 and ND-14: a payload is sealed to the terminating connector."** ADR 0032 bounds this.
   At a client destination the payload is sealed to the seller's key and no connector opens it.
   The note is right for every route termination.
2. **"0052: a client may pay any connector with no permission."** True for paying. Earning needs
   the operator's signed write and deposit. The two directions are not symmetric.
3. **"0075: a peering is two x402 channels, each opened and funded by its payer."** The same rule
   covers a client payout, and it means the *host* is the payer who funds it.

One note is confirmed with a sharper edge: "The `toon` CLI has no `sealTo` option". A buyer paying a
client destination must seal to a key that is not the connector's. The library's `sealTo` is the
only way to do that from this client.

---

## 7. Questions sharp enough to be tickets

1. **connector: a client destination pays out with nothing collected.** `route_prepare` signs a
   voucher for `prepare.amount` whether or not the sender's claim advanced by that much (2.5,
   5.1). Is that intended, with the operator's deposit as a subsidy the controller manages, or a
   defect? If a defect, the fix is to require a covering claim before delivery to a session. This
   one should probably be filed against the connector whatever the map decides.
2. **connector: ADR 0032 and spec §1.9 describe a check that ADR 0069 removed.** The record still
   says the fulfilment is verified. Either 0032 gets an "amended by 0069" note and the spec's stale
   paragraphs go, or the hashlock is restored some other way. toon-meta's
   `mesh-compute-job-protocol.md` §6 and §7 have the same problem.
3. **connector: should a client destination be reachable from a peer?** Today it is not (2.3). If
   the tier is wanted, this decides whether it is a one-connector feature or a network one.
4. **Does the map want the tier at all?** With every agent on an onion endpoint, the NAT argument
   for it is gone (5.3). A grilling ticket could close this in one line, and
   [#722](https://github.com/toon-protocol/toon-client/issues/722) may be the place.
5. **toon-client: every BTP `ToonClient` binds a session at its chain address and acknowledges any
   TRANSFER.** Harmless today because no operator opens a channel toward a payer. Worth a look if
   the connector starts paying sessions more freely: an acknowledged voucher is one the connector
   stops resending, and this client discards it.

---

## 8. Not verified

- **Nothing was run.** Every claim about behaviour is read from source and its tests.
- **The drain in 5.1** is a reading of the code, not a demonstrated exploit. I did not check
  whether a deployed connector has any payout channel open toward a client; if none does, nobody is
  exposed today.
- **Whether any deployed node has ever paid a client.** connector#770 records a devnet run before
  ADR 0075 where the money step did not move. I found no record of a run after it.
- **Peer reachability (2.3)** rests on the absence of a caller. No test pins it.
- **What a seller's EVM `terms` must contain** for the operator's `POST /channels` to succeed was
  read from the request type, not exercised. A plain client publishes no self-description, so the
  operator has to assemble those terms by hand; I did not find a documented procedure.
- **The Solana row of 2.4**: I read that the open is posted to the receiver's `sponsorEndpoint`. I
  did not confirm there is no other way for a receiver with no endpoint to be opened toward.
- **toon-meta#265's later comments** (six of them) were not read; only the issue body and #266's
  body and the spec file.
- **The local connector checkout is two commits behind upstream** (section 9). I read the upstream
  diff for the files cited here: it widens voucher amounts from `u64` to `u128` and changes no
  routing or payout logic.

---

## 9. Sources

All read on 2026-10-01.

**Connector**, `toon-protocol/connector@8b938f9b0ebf460232bc4342e9174a50ba070a72` (local checkout,
`main`, 2026-09-30). Upstream `main` was two commits ahead at `48a9db3`; the vectors vendored in
this repository are from that commit.

- `docs/adr/0032-a-client-destination-is-never-a-route-termination.md`
- `docs/adr/0048-...`, `docs/adr/0069-the-execution-condition-leaves-the-wire.md`
- `docs/adr/0075-every-channel-is-an-x402-channel-a-peering-is-two-of-them.md` (decisions 3, 7, 11;
  trust statement; consequences)
- `docs/protocol/client-edge-spec.md` §1.3 step 5, §1.4, §1.9
- `CONTEXT.md` (Client destination, Sponsor, Facilitator)
- `crates/connector-client-edge/src/`: `session_route.rs`, `session_registry.rs`, `btp.rs`,
  `lib.rs`, `claim_gate.rs`, `outbound_ledger.rs`; `tests/client_payouts.rs`
- `crates/connector-runtime/src/`: `connector.rs`, `batch_channels.rs`
- `crates/connector-operator/src/lib.rs`, `crates/connector-cli/src/runtime.rs`
- `crates/connector-peer-btp/src/accept.rs`, `crates/connector-peer-http/src/accept.rs`
- `crates/connector-domain/src/claim.rs`
- `vectors/wire-vectors.json` (`payout_voucher`)
- Issues [#736](https://github.com/toon-protocol/connector/issues/736),
  [#770](https://github.com/toon-protocol/connector/issues/770),
  [#1396](https://github.com/toon-protocol/connector/issues/1396) (all closed)

**This repository**, `toon-protocol/toon-client@0a6019aeb7a7175aeeb7f2bec57f3b155dfbd918`.

- `packages/client/src/btp/IsomorphicBtpClient.ts`, `BtpRuntimeClient.ts`
- `packages/client/src/client/ToonClient.ts`, `config.ts`
- `packages/client/src/channel/batch-settlement/`
- `packages/client/src/wire/vectors/` and `wire/wire-vectors.test.ts`
- History: `d54324c`, `c90cd38`, `efd6397`; `serve-job.ts` as of `efd6397^`

**toon-meta**, `toon-protocol/toon-meta@bb518c13ed518c6af6659580e1ca0e2607e5638b`.

- Issue [#265](https://github.com/toon-protocol/toon-meta/issues/265) (body) and
  [#266](https://github.com/toon-protocol/toon-meta/issues/266) (body)
- `docs/mesh-compute-job-protocol.md` §3, §6, §7
