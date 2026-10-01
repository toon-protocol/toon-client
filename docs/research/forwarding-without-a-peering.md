# Can a node forward to a connector it has no peering with?

Research note, 2026-10-01, for
[toon-client#717](https://github.com/toon-protocol/toon-client/issues/717), part of the map
[toon-client#715](https://github.com/toon-protocol/toon-client/issues/715). Not user-facing
documentation and not normative. It answers one question from the connector's source and tests.

**The question.** A node pays every next hop with a voucher on a channel its peering names. A
peering is written only by an operator. If the far operator has written nothing, can the node
still pay through that connector, and will that connector carry the packet onward?

**How to read this.** Section 1 is the verdict. Section 2 is sourced fact. Section 3 answers the
ticket's questions one by one. Section 4 is my analysis and is labelled as such. Section 5 is
what the map's Notes get wrong or leave out. Section 6 is what I could not verify. Section 7 is
new questions. Section 8 is the sources.

**Evidence labels.** *(source)*: read in the connector's Rust source at the pinned commit.
*(test)*: asserted by an existing test, read at the pinned commit. *(ran)*: a test I ran on
2026-10-01. *(prose)*: stated in a record or spec only. *(inference)*: my reasoning.

**Citation shorthand.** A bare `path:line` is a path in `toon-protocol/connector` at commit
`8b938f9b0ebf460232bc4342e9174a50ba070a72` (`main`, 2026-09-30). That checkout was two commits
behind `origin/main` (`48a9db38`, `787800d0`). I read the diff: it widens voucher amounts from
`u64` to `u128` and changes a CI image. It changes no rule cited here, but line numbers in
`connector-client-edge` and `connector-domain` may be off by a few lines on `origin/main`.

**Vocabulary.** The connector's `CONTEXT.md`. "A" is the node that wants to pay. "B" is the far
connector whose operator has written no peering naming A. "C" is whatever B forwards to.

## 1. Verdict

**(a) holds for paying. A one-sided relationship is enough to pay through a stranger.**

A's operator writes one signed `POST /peers` naming B's URL, and one `POST /routes/peers`. A
opens and funds its own channel toward B and covers every forward with a voucher on it. B has
bound nothing, so each arrival is decided `client`, and B's client edge admits the voucher on a
channel it resolves from chain, exactly as ADR 0052 guarantees for any stranger. B then routes
the packet by its own table: it delivers to its app, or forwards to C and pays C on B's own
channel.

Three conditions bound that answer:

1. **B must already sell the route.** B carries the packet only to a destination B has a
   configured route for, at B's price. A's write gives A no route inside B.
2. **A pays as a client, so the client rules bind.** On a priced forwarded route at B the packet's
   amount must equal B's price exactly. A terminated route pinned to one transport refuses the
   other.
3. **The reverse direction is not one-sided.** Nobody can forward a packet *to* A through B
   unless B's operator writes a peering toward A and a route for A's prefix.

(c) is false. The binary has no separate client channel, but it does not need one: the channel
a peering opens is the same kind of channel a client opens, and the receiver alone decides which
role its vouchers arrive under.

## 2. Sourced facts

### 2.1 One operator can write a peering to a counterparty that has written none

- `POST /peers` reads the counterparty's self-description, opens **only this node's outbound
  channel**, registers the paying hop, writes the durable row, and binds the counterparty's
  published voucher signer. It asks the counterparty for nothing but that document and, on
  Solana, a co-signature (2.7). *(source)* `crates/connector-runtime/src/peering.rs:243-301`.
- The module states the shape: "This write opens and funds only this node's own, and the other
  half is **admitted, not configured**: the counterparty opens it the same way". *(source)*
  `crates/connector-runtime/src/peering.rs:12-24`. ADR 0075 decision 4 says the same. *(prose)*
  `docs/adr/0075-every-channel-is-an-x402-channel-a-peering-is-two-of-them.md:163-175`.
- What the write requires of B's document: a dialable endpoint, an `httpEndpoint`, a shared chain
  with `batchSettlements` terms on the same network, and a `voucherSigners` entry for that
  network. Each missing item is a named refusal before any gas is spent. *(source)*
  `crates/connector-runtime/src/peering.rs:142-212`, `:257-269`, `:320-333`.
- A test makes this write against a bare HTTP server that serves only a self-description. No
  connector is behind it and nothing writes back. The peering is established, the channel is
  created on chain, and a route through it is accepted. *(test)*
  `crates/connector-cli/tests/peering_from_a_url.rs:818-865` (the document server), `:873-978`
  (the write, the on-chain channel, the route).
- A route to a runtime peering is accepted only when that peering has a paying hop registered.
  *(source)* `crates/connector-runtime/src/connector.rs:1797-1821`.

### 2.2 Every forward A sends carries a voucher on that channel

- `forward_via_peer_route` subtracts the peering's fee, checks the cap, shortens the expiry, then
  calls `cover_forward` before sending. A forward that cannot be covered is refused `T00`.
  *(source)* `crates/connector-runtime/src/connector.rs:2602-2775`.
- The voucher is for the channel's signed watermark plus the forwarded amount. A packet that
  moves no value carries a claim-state challenge instead. *(source)*
  `crates/connector-runtime/src/connector.rs:2911-2989`.
- The HTTP dialer puts the voucher in the same header a client uses. The peer carriage imports
  `connector_btp::CLAIM_HEADER`, and the client edge declares its own claim header as that same
  constant. *(source)* `crates/connector-peer-http/src/dial.rs:52`, `:382-392`;
  `crates/connector-client-edge/src/lib.rs:127-131`.
- The dialer presents no credential and no handshake on either carriage. *(source)*
  `crates/connector-peer-http/src/dial.rs:122-127`, `:265-276`;
  `crates/connector-peer-btp/src/dial.rs:231-239`.

### 2.3 At B, an arrival that proves no peering is a client, silently

- Role is `peer` only for a voucher or challenge on a channel whose chain-recorded signer is
  bound to a peering at B. A channel bound to no peering is `client`, with no event. *(source)*
  `crates/connector-peer-auth/src/decision.rs:237-258`. *(prose)* `CONTEXT.md:288-298`.
- Peer traffic and client traffic arrive on the same `POST /ilp` and `GET /ilp/btp`. A
  client-role request is left "exactly as it was. Not refused, not annotated". *(source)*
  `crates/connector-client-edge/src/peer.rs:9-39`, `:188-212`;
  `crates/connector-client-edge/src/lib.rs:1196-1200`.
- `peer_expose` defaults to `neither`. With it, no peer handling is mounted and every arrival
  takes the client path whatever it carries. *(source)*
  `crates/connector-config/src/peer.rs:404-412`;
  `crates/connector-client-edge/src/peer.rs:42-48`, `:126-128`.
- The connector's own local topology says what happens when B has not bound A: "A's vouchers
  would arrive at B as a client's rather than a peer's", and "A voucher from an UNBOUND channel
  is admitted as a client's and would pay this price just as well". *(source, config comments)*
  `local/two-hop/connector-a.toml:68-71`, `local/two-hop/connector-b.toml:69-75`. A test names
  the same fact. *(test)* `crates/connector-bin/tests/local_topologies_load.rs:1246-1250`.

### 2.4 B's client edge admits the voucher on a channel resolved from chain

- ADR 0052: "A conforming connector accepts payment from a buyer it has never heard of, whose
  channel it resolves from chain." *(prose)*
  `docs/adr/0052-permissionless-payment-is-guaranteed-and-a-claim-is-what-authorises.md:7-9`.
- The client path computes the route's charge, greets an unpaid request, then ingests the claim
  against that charge. *(source)* `crates/connector-client-edge/src/lib.rs:1265-1310`,
  `:1355-1370`, `:977-1010`.
- What a channel must be for B to admit it: on EVM, `receiver` and `receiverAuthorizer` both B's
  settlement address, B's token, a `withdrawDelay` at or above B's published minimum. On Solana,
  B's sponsor key as `payee` and `rent_payer`. A opens its channel on exactly the terms B
  publishes. *(source)* `crates/connector-client-edge/src/batch_settlement.rs:33-41`;
  `crates/connector-runtime/src/peering.rs:352-376`.
- B accepts vouchers at all only when a `[settlement.<chain>]` table is written. *(source)*
  `crates/connector-client-edge/src/batch_settlement.rs:9-16`.
- An existing test runs the whole one-sided path over ILP-over-HTTP. The payer is a real
  `Connector` that calls `establish_peering` and opens a real channel on `anvil`. The payee is a
  client edge on a real socket, built with `router_with_gate`, with **no peering and no peer
  carriage**. Three packets fulfil, each voucher advanced by exactly the forwarded amount, the
  third after a restart of the payer. *(test)*
  `crates/connector-client-edge/tests/runtime_peering_can_pay_the_forward_it_accepted.rs:172-219`
  (the payee), `:307-395` (the claim). *(ran)* 2 passed, 0 failed. The payee's claim gate there
  runs over a fake of the settlement seam, not a chain (`:90-139`).
- Against a real chain and two spawned binaries, a voucher on a channel no `[[peer_channels]]`
  row binds is journaled as a client's payment and reaches no peer handling, over both carriages.
  *(test)* `crates/connector-bin/tests/two_connectors_peer.rs:36`, `:446-474`, `:797-807`.

### 2.5 B forwards a client's packet onward, at B's price

- The client edge routes an admitted packet through `Connector::handle_prepare_with_client_channel`,
  which selects among terminated and forwarded routes alike. A forwarded match calls the same
  `forward_via_peer_route` as in 2.2, so B pays C on B's own channel. *(source)*
  `crates/connector-client-edge/src/lib.rs:1383-1396`;
  `crates/connector-client-edge/src/session_route.rs:75-89`;
  `crates/connector-runtime/src/connector.rs:2227-2279`.
- A forwarded route has a client-facing price (ADR 0028). *(source)*
  `crates/connector-runtime/src/connector.rs:3420-3446`.
- A test pays a forwarded route at one binary's client edge with a voucher on an unbound channel,
  and the packet crosses that binary's peering to a second binary and fulfils, over both
  carriages. *(test)* `crates/connector-bin/tests/two_connectors_peer.rs:1012-1057`. The payer in
  that test is a test client, not a connector. It renders its voucher with
  `connector_runtime::voucher_json`, the function a connector's own forward uses (`:396-418`;
  `crates/connector-runtime/src/connector.rs:2979`).

### 2.6 The client rules that bind A

- **Amount on a priced forwarded route.** A client packet may not declare an `amount` above the
  route's charge (`F03`), and the voucher must advance by at least the charge. A's voucher
  advances by exactly the amount it forwards. So on a priced forwarded route at B, the amount A
  forwards must equal B's charge exactly. The charge is a schedule over payload length. *(source)*
  `crates/connector-client-edge/src/lib.rs:1265-1274`, `:1122-1142`, `:1316-1322`;
  `crates/connector-runtime/src/connector.rs:2974-2978`. *(test)*
  `crates/connector-bin/tests/two_connectors_peer.rs:1151`.
- **Transport pin.** A terminated route pinned to one transport refuses a client on the other. A
  forwarded route reports `Both`, so a pin never blocks a forward. *(source)*
  `crates/connector-client-edge/src/lib.rs:1282-1300`;
  `crates/connector-runtime/src/connector.rs:3429-3445`.
- **Lookup budget.** B's first sight of a channel costs B one chain read, and B shapes those
  reads. A request whose slot is too far out is refused `T05`. *(source)*
  `crates/connector-client-edge/src/lookup_budget.rs:1-20`, `:47-54`;
  `crates/connector-client-edge/src/lib.rs:1150`.
- **No ack.** B emits no `claim-ack` on a client interaction. A reads that as `NotSent`, which
  "changes nothing". *(source)* `crates/connector-runtime/src/connector.rs:2991-3009`;
  `crates/connector-peer-http/src/dial.rs:442-450`. *(prose)*
  `docs/protocol/peer-carriage-spec.md:643-650`.
- **Watermark restore.** B's `POST /ilp/claim-state` answers for any channel whose voucher signer
  signs the challenge, whichever role its vouchers arrive under. *(source)*
  `crates/connector-client-edge/src/claim_state.rs:14-41`. The restart leg of the test in 2.4
  covers it.

### 2.7 Chains, carriages, onion endpoints

- **EVM.** A sends its own `deposit` from its settlement key and pays its own gas. No facilitator
  and nothing from B. *(prose)*
  `docs/adr/0076-the-operator-names-the-facilitator-and-pays-its-gas.md:129-130`.
- **Solana.** The `open` names B's sponsor key as fee payer, `rent_payer` and `payee`, and A posts
  it to B's sponsor endpoint. That endpoint is public, unsigned, mounted on the client edge, and
  answers a buyer B has never heard of. It is rate-bounded. *(source)*
  `crates/connector-runtime/src/peering.rs:26-33`; `crates/connector-cli/src/sponsor.rs:1-33`.
- **BTP.** A client BTP session is not authenticated at the handshake or by the `auth` frame.
  "Authorization to write comes from the claim on each packet." A MESSAGE carrying a claim and a
  packet is admitted by the same gate as HTTP. *(source)*
  `crates/connector-client-edge/src/btp.rs:62-75`, `:584-587`, `:646-668`, `:859-876`. The BTP
  dialer's own types name the case of a far side's **client edge** answering a connector's dial.
  *(source)* `crates/connector-peer-btp/src/dial.rs:356-364`.
- **Which carriage A dials.** BTP first where B publishes both. *(source)*
  `crates/connector-runtime/src/peering.rs:401-426`.
- **Onion.** An onion endpoint is a host, not a carriage. A dials B's self-description, carriage
  and claim-state through its one `socks_proxy`, selected by the host alone. *(prose)*
  `CONTEXT.md:255-266`. *(source)* `crates/connector-peer-http/src/client.rs:104-113`;
  `crates/connector-peer-btp/src/ws.rs:283-287`. In `local/onion`, A publishes a hidden service
  of its own only because B's `POST /peers` reads A's self-description. *(source, config
  comment)* `local/onion/connector-a.toml:22-28`.

### 2.8 `forwarded_claim_enforcement`

- It is a per-peering setting read only by the **peer** price gate, for an arrival already
  decided `peer`, to a **forwarded** route. `enforce` refuses `F06` unless a voucher covers the
  packet's amount. `observe` admits the packet and logs a warning. *(source)*
  `crates/connector-peer-btp/src/price_gate.rs:21-34`, `:206-235`, `:257-273`.
- A terminated arrival is enforced unconditionally in both roles. *(source)*
  `crates/connector-peer-btp/src/price_gate.rs:216-224`.
- A runtime peering has no such setting and observes. The policy is built from `[[peers]]` rows,
  and an id with no row reads as the default. *(source)*
  `crates/connector-peer-btp/src/price_gate.rs:95-127`. *(test)*
  `crates/connector-bin/tests/local_topologies_load.rs:574-576`. *(prose)* `local/README.md:220-222`.
- The client path never consults it. *(source)* `crates/connector-client-edge/src/lib.rs:1185-1397`
  contains no reference to it; the only readers are in `connector-peer-btp/src/price_gate.rs`.

### 2.9 What a peering cannot do

- A peering is created only by an operator. "There is now no path by which a stranger becomes a
  peer." *(prose)* `docs/adr/0043-purchasable-peering-is-removed.md:7-9`, `:36-38`.
- The peer role grants no "route the routing table does not have". *(prose)*
  `docs/protocol/peer-carriage-spec.md:637-639`.

## 3. The ticket's questions

**Can an operator write a peering to a counterparty that has written none back?** Yes (2.1,
*test*). The counterparty needs a reachable self-description that publishes an `httpEndpoint`,
x402 terms on a shared network, and a voucher signer.

**What does the counterparty see when the first packet arrives?** A client. On EVM, B reads the
channel from chain on that first voucher, journals the channel and the voucher in
`client-edge-claims.log`, and delivers or forwards. On Solana B already saw the channel when it
co-signed the `open`. No peer event is emitted and no `claim-ack` is returned (2.3, 2.6).

**In the client role, is the forwarding node's voucher admitted on a channel resolved from
chain?** Yes (2.4). *(ran)* for ILP-over-HTTP against a real payer and a faked settlement seam at
the payee; *(test)* against a real chain for an unbound channel's voucher.

**Will the receiving connector forward that packet onward, or only terminate it?** Both, by its
own route table (2.5). It forwards only to destinations it has a configured route for, at that
route's price, and it pays the next hop from its own channel.

**What does `forwarded_claim_enforcement` change here?** Nothing. In `observe` and in `enforce`
alike, A's arrival is a client's and the client edge demands a covering voucher unconditionally.
The setting matters only once B has bound A's signer, and then only on B's forwarded routes
(2.8).

**Does the answer differ between the two carriages, or over an onion endpoint?** The rule does
not. Three practical differences:

- A dials BTP when B publishes both. I verified the one-sided path end to end by test only over
  HTTP. The BTP path is *(source)*, not *(test)*.
- Over HTTP a pinned-to-BTP terminated route at B answers `402`, which A's dialer reports as
  `T01`, not as terms (`crates/connector-peer-http/src/dial.rs:289-301`, `:453-458`).
- Over an onion endpoint A needs a `socks_proxy`. A needs no hidden service of its own to pay.

**If a peering is always required: what is the least the far operator must do?** A peering at
the far end is not required to pay. See 4.3 for what the far operator must already have done,
and for the reverse direction.

## 4. Analysis (mine)

### 4.1 Why (c) is the wrong frame

*(inference from 2.2-2.4)* The map says the binary "holds no client channel". That is true as
vocabulary and misleading as mechanism. A channel is a one-way x402 channel named by the voucher
that pays on it. The payer never declares a role. The receiver decides it, from whether it has
bound the channel's signer. So the channel a one-sided `POST /peers` opens **is** a client
channel from B's side, and the binary already opens, funds, signs on, restores and withdraws it.

### 4.2 What the far operator's write buys

*(inference from 2.6, 2.8 and `docs/protocol/peer-carriage-spec.md:621-650`)* If B also writes
`POST /peers` naming A, and exposes the carriage A dials, A's arrivals become `peer`. That
changes:

- A is no longer held to a terminated route's transport pin.
- On B's forwarded routes A is charged the packet's own amount, not the route's price, and only
  if the peering enforces.
- A's vouchers are answered with a `claim-ack`, so A resyncs after a refused voucher.
- A zero-value packet is attributed to the peering by its challenge.
- B can pay A, on B's own channel toward A. Over BTP, B can originate on the session A dialed.

It does not change whether A can pay B.

### 4.3 The least a far operator must do

*(inference)* **For A to pay through B: nothing per payer, and nothing after setup.** B's
operator must already run a node that is reachable, has a `[settlement.<chain>]` table, publishes
`[node] http_endpoint`, and has a priced route for the destination. Each of those is what an
operator who sells anything has done anyway.

**For A to be paid through B: one peering and one route, written by B's operator.** A packet
addressed to A's prefix reaches A only if some connector has a route for that prefix naming a
peering toward A, with a funded channel to cover the forward (2.2, 2.9). That is two signed
operator writes at B (`POST /peers` naming A's URL with a `deposit`, `POST /routes/peers`) and
B's own money in a channel toward A. The connector will never make them itself (ADR 0006, ADR
0043). They need no human if B's controller is an agent holding B's write key, which is what the
map's Notes already assume.

A buyer can also skip B and pay A directly as a client of A, if A's endpoint is reachable.

### 4.4 What this does to the destination

*(inference)* "An agent pays through its own node's peerings" survives. "One or two channels can
reach everything" survives only as far as the chosen hub already holds priced routes to
everything, because a payer's write creates no route in the hub. Route gossip therefore has to
answer who writes routes into hubs, not who writes peerings into payers.

The destination's contrast, "not as a client of someone else's connector", does not survive as a
mechanism. A node with a one-sided peering *is* a client of the far connector. The contrast that
holds is about the agent's software: it runs its own node and never signs a claim itself.

### 4.5 A risk in the two-sided case

*(inference from 2.8)* A runtime peering observes. Once B has bound A as a peer, an arrival from
A to one of B's forwarded routes is carried even when A's voucher advances by less than the
packet's amount, and B pays C in full from its own channel. B's exposure per packet is its cap
toward C. The one-sided case has no such gap, because the client edge always enforces. So at
default settings the client role is the safer one for the far operator, and a hub that peers back
at runtime is extending credit to that peer. `enforce` is available only on a config-declared
peering (`local/mixed-chain/connector-b.toml:34-38`, `:126-131`).

### 4.6 A's vouchers after a downstream reject

*(inference, not tested)* On a client-priced forwarded route, B rolls its watermark back when the
next hop terminally rejects (`crates/connector-client-edge/src/lib.rs:1412-1450`). A's own signed
watermark has already advanced and A only ever raises it
(`crates/connector-runtime/src/connector.rs:2903-2910`). A's next voucher is therefore signed
above the rolled-back figure and pays for the rejected packet as well. A client that tracks the
rollback is refunded; a connector paying as a client is not.

## 5. Against the map's Notes

- **"The agent pays through its own node's peerings, not as a client of someone else's
  connector."** These are not alternatives. With a one-sided peering both are true at once (4.1,
  4.4).
- **"The connector binary holds no client channel."** True, and it does not need one (4.1). The
  ticket's option (c) rests on this note.
- **"0043: a peering is created only by an operator, by a signed write."** Holds. It does not
  follow that paying needs the far operator's write.
- **"0075: a peering is two x402 channels, each opened and funded by its payer."** Holds for a
  two-way relation. One channel is enough to pay one way.
- **"A well-connected peer forwards for it, so one or two channels can reach everything."**
  Holds only where the hub already has priced routes. The Notes do not say who writes them.
- **`local/two-hop/` "pays the next hop over a peering".** True, and that topology pins B's route
  to BTP precisely so that a one-sided payment would fail there
  (`local/two-hop/connector-b.toml:69-75`). It is a proof of the peer role, not evidence that a
  peering is needed.

One place where the connector's prose could mislead. `peer-carriage-spec.md:626-631` lists "being
a next hop: packets from this interaction may be forwarded per the routing table" under what the
**peer** role grants "and only these". Read alone, that suggests a client's packet is not
forwarded. The code forwards it (2.5), and ADR 0028 prices exactly that case.

## 6. Not verified

- **No test runs the full chain this design needs**: connector A with a one-sided runtime
  peering, to connector B in the client role, forwarded to C. Each half is tested (2.4, 2.5). The
  join is *(inference)* from both halves using the same voucher rendering and the same header.
- **One-sided over BTP** is read in source only.
- **One-sided over an onion endpoint** is read in source and config only. `local/onion` writes
  both ends.
- **One-sided on Solana** is read in source only. I did not check that B's sponsor rules accept
  an `open` from a payer it has no peering with beyond the endpoint's own statement that it is
  public.
- **The real EVM backend's admission of A's channel as a client's** is tested for a test client's
  channel, not for one a connector opened with `POST /peers`. Both open on B's published terms.
- **4.5 and 4.6** are read from code and not exercised.
- **What B's operator sees on `GET /channels` and `GET /claims`** for A's channel. I read the
  journal path, not the operator views.
- I ran one test file. I ran nothing against devnet or a live node.

## 7. New questions

1. **Who writes routes into a hub?** A payer's `POST /peers` gives it no route inside the far
   connector, and the connector never learns one (ADR 0006). The mesh needs each hub's controller
   to write a priced route per destination prefix. This is the route gossip ticket's real
   subject.
2. **How does a node get paid through a hub?** It needs the hub's operator to open and fund a
   channel toward it and write a route for its prefix. What makes a hub's agent do that for a
   node nobody has heard of, and with whose money?
3. **Exact-amount composition.** A connector paying as a client must forward exactly the far
   route's charge, which varies with payload length. `connector send` takes one `--amount`.
   Something must compute it from the far node's published schedule and the local fee.
4. **Should a runtime peering be able to enforce?** At default settings, peering back with a
   stranger at runtime lets that stranger under-cover forwards (4.5).
5. **A prototype would close section 6's first item**: a three-node local topology where only A
   writes `POST /peers`, and B's route to C is unpinned.

## 8. Sources

- `toon-protocol/connector` at `8b938f9b0ebf460232bc4342e9174a50ba070a72`, local checkout, read
  2026-10-01. Crates read: `connector-runtime`, `connector-client-edge`, `connector-peer-http`,
  `connector-peer-btp`, `connector-peer-auth`, `connector-config`, `connector-cli`, and the tests
  in `connector-bin`, `connector-cli` and `connector-client-edge`.
- Records read: `CONTEXT.md`; ADR 0006, 0028, 0042, 0043, 0052, 0058, 0070, 0075, 0076;
  `docs/protocol/peer-carriage-spec.md` §1.2-§1.11; `local/two-hop/`, `local/onion/`,
  `local/README.md`.
- Test run: `cargo test -p connector-client-edge --test
  runtime_peering_can_pay_the_forward_it_accepted`, 2 passed, with `anvil` 1.7.1 on the path.
- The closing comment of
  [connector#1442](https://github.com/toon-protocol/connector/issues/1442), for the decision the
  map rests on.
