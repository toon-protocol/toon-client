# A mainnet facilitator, and the native gas an agent node needs

Research note, 2026-10-01. Not user-facing documentation and not normative. It decides nothing.
It answers [toon-client#720](https://github.com/toon-protocol/toon-client/issues/720), a ticket on
the map [toon-client#715](https://github.com/toon-protocol/toon-client/issues/715).

**The question.** Does a mainnet node have a facilitator to name, so that being paid costs neither
side native gas? What native gas does an agent node need at all? What must a user fund before the
node can pay, and before it can earn?

**How to read this.** §1 is the short answer. §2 to §6 are sourced facts, each with its citation.
Every paragraph headed **Analysis** is the author's reasoning from those facts. §8 lists what was
not verified. Nothing was signed, nothing was sent to any `/verify` or `/settle`, and no account was
opened anywhere. Every network read was a public, unauthenticated `GET` or a read-only JSON-RPC
call.

## Citation conventions

Local checkouts under `/home/allidoizcode/Work/TOON-Protocol/`, read at these commits:

- **C:`path:lines`** is [toon-protocol/connector](https://github.com/toon-protocol/connector) at
  `8b938f9b0ebf460232bc4342e9174a50ba070a72` (`main`, 2026-09-30), so
  `https://github.com/toon-protocol/connector/blob/8b938f9b/<path>#L<lines>`.
- **I:`path:lines`** is [toon-protocol/infra](https://github.com/toon-protocol/infra) at
  `b60734015793e9a2c53dc1d2e6fef9c2b57e8f9e`. That checkout was on the branch `issue-42-dealer`,
  not `main`. The last commit touching the files cited here is `dcb4cb1` (infra#48).
- **G:`path:lines`** is [toon-protocol/gas-station](https://github.com/toon-protocol/gas-station)
  at `8ddddd17dc59234d991f4fde619cada5d8a4b197` (`main`, 2026-09-29).
- **T:`path:lines`** is this repository at `0a6019aeb7a7175aeeb7f2bec57f3b155dfbd918`.

Primary sources on the web, all read on 2026-10-01:

- **X:`path:lines`** is [x402-foundation/x402](https://github.com/x402-foundation/x402) at
  `6b6ee91fee027b540faabcb25774e73851006c3b` (`main`, committed 2026-09-29), so
  `https://github.com/x402-foundation/x402/blob/6b6ee91f/<path>#L<lines>`. The connector's own
  records pin an older commit, `0cb1a1f0`. The contract file was read at the newer one.
- **P:`path:lines`** is [PayAINetwork/docs](https://github.com/PayAINetwork/docs) at
  `15442c55caa1f915ed3b1a79fa6c67b462e36a96` (committed 2026-10-01 09:21 UTC), the source of
  `docs.payai.network`.
- **CDP** is Coinbase's documentation: <https://docs.cdp.coinbase.com/x402/seller/facilitator> and
  <https://docs.cdp.coinbase.com/x402/support/faq>. Both were read through a page-to-text
  converter, so the quotations are that converter's extraction and not a byte copy. The same holds
  for Dexter's own page, <https://dexter.cash/facilitator>.
- **LIVE** is a `GET <facilitator>/supported` at 13:58 UTC.
- **CHAIN** is Base mainnet, read at 13:58 to 14:10 UTC: `eth_getCode` and `eth_gasPrice` against
  `https://mainnet.base.org`, and Blockscout's list of the 2,000 most recent transactions to
  `x402BatchSettlement`
  (`https://base.blockscout.com/api/v2/addresses/0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003/transactions`,
  40 pages). Those 2,000 run from 2026-09-29 09:07 UTC to 2026-10-01 13:15 UTC, and all succeeded.

---

## 1. The short answer

**Yes, there is a facilitator to name on Base mainnet. No, naming one does not make an agent node
gasless.** Those are two different questions, and the second is the one that sets the install.

1. **A mainnet facilitator exists.** PayAI (`https://facilitator.payai.network`) documents
   `batch-settlement` on Base mainnet as public, with no account, when the receiver keeps its own
   `receiverAuthorizer`, which a connector always does. Its signers were seen on chain relaying
   `deposit` into channels of exactly that shape. Coinbase CDP documents it too, behind an API key.
   Dexter and Solvador advertise it and were not seen relaying one. Nobody sent a deposit toward a
   TOON connector through any of them, so that last step is unproven.
2. **A facilitator only helps a buyer that is a client.** Under connector ADR 0075 and 0076, a node
   funds its own outbound channels by sending `deposit` itself, from its own gas. A peering is two
   such channels. So in the mesh the map describes, where an agent pays through its own node's
   peerings, the facilitator a node names is never on the path of a peering.
3. **As built, an agent node needs native gas on every chain it configures.** On Base it needs ETH
   to open, top up, land and withdraw. On Solana it needs SOL before it will even boot.
4. **So the funding step is one address and two assets, per chain.** A Base-only node needs USDC
   and a little ETH at its EVM settlement address. A node that also settles on Solana needs USDC and
   SOL at a second address. `hermes-mpp`'s bar of one token at one printed address is not met by the
   connector as it stands.
5. **The contract does not force this on EVM.** `deposit` may be sent by anyone, `claimWithSignature`
   is relay-friendly and `settle` is permissionless. Only the payer's own withdrawal must come from
   the payer's key. The connector chose to send all of them itself. Whether to change that is a
   decision for the connector, and §7 states it as a ticket.

The amounts are small. On 2026-10-01 a Base `deposit` cost about $0.0024 and a `claim` plus
`settle` about $0.002. The friction is the second asset, not its price.

---

## 2. Is there a facilitator on Base mainnet that relays `batch-settlement` deposits?

### 2.1 What a facilitator has to do for a TOON node

The connector publishes the facilitator's URL and never calls it. The **payer** calls it, with no
credential, and posts one x402 v2 settle request (C:`docs/adr/0076-the-operator-names-the-facilitator-and-pays-its-gas.md:52-67`;
T:`packages/client/src/channel/batch-settlement/facilitator.ts:55-73`, which sends only a
`content-type` header). The facilitator must therefore:

- accept an unauthenticated `POST /settle` from a caller it has never seen;
- relay a deposit to an arbitrary `payTo`;
- accept a `receiverAuthorizer` that is the receiver's own address, never the facilitator's
  (C:`docs/adr/0074-a-client-may-pay-over-an-x402-batch-settlement-channel.md:221-224`).

### 2.2 The contract is on Base mainnet

`eth_getCode` at `0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003` on Base mainnet returned 11,175 bytes
of code (CHAIN). The address is the one the connector binary fixes
(C:`docs/adr/0075-every-channel-is-an-x402-channel-a-peering-is-two-of-them.md:63-68`).

### 2.3 Who offers it

| Facilitator | `batch-settlement` on `eip155:8453` | Advertised `receiverAuthorizer` | Auth on `/settle` | Price | Seen relaying a `deposit` on Base mainnet |
| --- | --- | --- | --- | --- | --- |
| **PayAI** `facilitator.payai.network` | Yes, flagged `experimental` (LIVE) | None in the public `/supported` (LIVE) | None with your own authorizer (P) | Gas plus 30%, after a free allowance (P) | **Yes**, 13 times in the sample (CHAIN) |
| **Coinbase CDP** `api.cdp.coinbase.com/platform/v2/x402` | Docs say yes. `/supported` answered `401` (LIVE) | Unknown, behind auth | CDP API key (CDP) | 1,000 a month free, then $0.001 (CDP) | Not attributable: its signers are not public |
| **Dexter** `x402.dexter.cash` | Yes (LIVE) | `0x88559c29…ecfB` (LIVE) | "No account required" (its own page) | "Dexter charges no facilitator fee" (its own page) | No |
| **Solvador** `api.solvador.com` | Yes (LIVE) | `0xC077C1A9…F8e7`, also its only signer (LIVE) | Not documented | Not documented | No |
| **x402.org** | No. Base Sepolia only (LIVE) | None | None | Free | Not applicable |
| **The devnet Onboarder** `onboard.devnet.toonprotocol.dev` | No. Base Sepolia only (LIVE) | None | None | The operator's gas | Not applicable |

**x402.org is not a mainnet option, by its own account.** "It is not intended for mainnet routes;
use a production facilitator, a self-hosted facilitator, or self-facilitation for production
networks" (X:`docs/dev-tools/facilitators.md:38`). Its live `/supported` lists `batch-settlement`
only on `eip155:84532`.

### 2.4 PayAI, in detail

**What its documentation says** (P:`x402/servers/evm-batch-settlement.mdx`):

- "PayAI serves `batch-settlement` on **Base mainnet** (`eip155:8453`) and **Base Sepolia**
  (`eip155:84532`) at `https://facilitator.payai.network`. Access is public: no PayAI account or
  API key is needed when you run your own receiver authorizer." (`:9`)
- "PayAI submits the deposit; the customer pays no gas." (`:14`)
- Running your own authorizer is "upstream's recommended production mode. Your channels survive a
  facilitator change, because any facilitator can relay your signed claims and refunds." (`:67`)
- "Every on-chain leg PayAI relays for you is priced at the observed gas plus 30 percent: deposit,
  claim, sweep and refund. … Without an API key, legs draw on the public free-tier allowance for
  your `payTo` address and are refused when it is exhausted. With a merchant API key they are billed
  as credits." (`:135`)
- Policy, also published live as `batchPolicy`: the asset is USDC (`0x8335…2913`) only, a new
  channel's deposit is 0.10 to 100 USDC, the withdraw delay is 3,600 to 86,400 seconds, and deposit
  attempts are 5 a minute per receiver and 10 a minute per client IP (`:121-131`).

**The free allowance** is "1,000 free credits per receiving wallet (lifetime)", at $0.001 a credit
(P:`x402/facilitators/pricing.mdx:22`, `:119`). Past it, a keyless call is refused as
`free_tier_exhausted`: "Add an API key to pay with credits, or relay the transaction yourself"
(P:`x402/servers/evm-batch-settlement.mdx:162`). An agent can buy credits and a key over x402 "with
no portal signup" (P:`x402/facilitators/pricing.mdx:117`).

**What its live endpoint says** (LIVE). The `eip155:8453` `batch-settlement` entry carries
`experimental: true` and the `batchPolicy` above, and no `receiverAuthorizer`. `extensions` are
`bazaar`, `eip2612GasSponsoring` and `erc20ApprovalGasSponsoring`. `signers["eip155:*"]` lists 15
addresses. The published `pricing.rates` table has **no** `batch-settlement` row for `eip155:8453`,
only `exact` rows (2.31 and 2.18 credits) and Solana batch rows.

**What the chain shows** (CHAIN). Two of PayAI's 15 advertised signers,
`0xc6699d2aadA6c36Dfea5C248DD70f9CB0235cB63` and `0xB2Bd29925CBbCEA7628279c91945Ca5B98bf371B`, sent
13 `deposit` transactions to `x402BatchSettlement` in the sample, as well as `claimWithSignature`,
`settle` and `refundWithSignature`. Blockscout decodes each one's `ChannelConfig`. Across the 13,
for example
[`0x5381588e…afdccc`](https://base.blockscout.com/tx/0x5381588ef0b5c00ead5e8ca963978981412041f3de8dbfba9340e8fb88afdccc):

- the collector is `ERC3009DepositCollector` (`0x4020806089470a89826cB9fB1f4059150b550004`) and the
  token is Base USDC, in the three read in full;
- `payerAuthorizer` equals `payer`, and is nonzero, in all 13;
- `receiverAuthorizer` equals `receiver` (`0x66B2ec35…525F`) in 12 of the 13, and that address is
  **not** one of PayAI's advertised signers. The other one names `0x0098b9d3…2Ea4`, which is not an
  advertised signer either and may be PayAI's delegated authorizer;
- `withdrawDelay` is 86,400 in the one linked above and 3,600 in the other 12.

That is the channel shape a connector admits: a nonzero `payerAuthorizer`, and `receiver` and
`receiverAuthorizer` both the receiver's own address (C:`docs/operators/x402-batch-settlement.md:178-181`).

**Limits of that evidence.** Every PayAI-relayed deposit in the sample has the same payer and the
same receiver. It may be PayAI's own test traffic or one customer. It shows the path works for that
pair, not that it works for any `payTo`. Only one of the 13 used the connector's default delay of
86,400 seconds.

**One conflict inside PayAI's documentation.** The endpoint table says of `/settle`: "required for
batch and beyond the ordinary exact free tier" (P:`x402/facilitators/authentication.mdx:498`). The
EVM batch page says no key is needed with your own authorizer. The EVM page is the newer and more
specific one, and the endpoint table may be describing the delegated-authorizer option. Which holds
for a keyless `/settle` was not tested.

### 2.5 Coinbase CDP, in detail

- **Networks.** The docs list `exact`, `upto` and `batch-settlement` on Base `eip155:8453`, and only
  `exact` and `upto` on Solana (CDP, seller/facilitator). "`batch-settlement` remains EVM-only"
  (CDP, FAQ).
- **Auth.** "The CDP Facilitator authenticates with your CDP API key ID and secret" (CDP,
  seller/facilitator). Its `/supported` answered `401` to an unauthenticated `GET` (LIVE).
- **Price.** "The first 1,000 onchain Facilitator transactions each month are free, then each
  additional onchain transaction costs $0.001." Only a `2xx` settle is billed, and "the facilitator
  submits the settlement transaction and pays the gas, which is what the per-transaction price
  covers" (CDP, both pages).
- **Screening.** "Every payment is screened against OFAC sanctions lists and Know Your Transaction
  (KYT) risk signals before it settles … and checks the payer and the recipient" (CDP, FAQ).
- **Gas sponsoring.** It "sponsors the initial Permit2 approval for tokens that support EIP-2612".

### 2.6 How an operator pays each one

| Facilitator | How the operator pays |
| --- | --- |
| Its own (the Onboarder's shape) | It funds a gas key with ETH. Each deposit costs that key gas (I:`onboarder/deploy/README.md:75-78`). |
| PayAI | Nothing until 1,000 credits are spent per `payTo`. After that, credits at $0.001 bought in the merchant portal or over x402, spent by a call that carries the operator's JWT. |
| CDP | A CDP account. It bills per on-chain transaction past the free tier, against the API key on the call. |
| Dexter | Its page says it charges nothing. |

**Analysis: only a keyless facilitator fits TOON's rule that the payer calls it.** ADR 0076 has the
payer post the deposit, and the greeting gives the payer a URL and nothing else. A facilitator that
needs the *seller's* credential on that call cannot be named as it stands, because the payer does
not hold the credential. That rules out CDP as a bare `facilitator_url`. It also means PayAI works
only inside its free allowance. At the fees in §6 a Base deposit is about 3 credits, so the
allowance is roughly 300 deposits per receiving address, for life. Past either limit the operator
would need a proxy of its own that adds the credential, which is a public endpoint spending the
operator's money on a stranger's request. ADR 0076 rejected putting exactly that inside the
connector (C:`docs/adr/0076-…md:163-166`). The connector's operator page recommends CDP as "the
credible hosted option for mainnet" (C:`docs/operators/x402-batch-settlement.md:331-333`) without
noting this.

**Analysis: PayAI's policy fits the connector's defaults, with no room to spare.** The connector's
default minimum `withdrawDelay` is 86,400 seconds (C:`docs/operators/x402-batch-settlement.md:233`),
which is PayAI's maximum. An operator who raises it has every PayAI deposit refused. This client's
default deposit is 100,000 base units (T:`docs/channels.md:91-93`), which is PayAI's minimum.

**Analysis: Dexter and Solvador are unproven for TOON.** Both advertise their own
`receiverAuthorizer`. The x402 spec lets a server decline it, "The server may delegate to this
address as its channel's `receiverAuthorizer`, or supply its own"
(X:`specs/schemes/batch-settlement/scheme_batch_settlement_evm.md:468`), but neither documents that
it honours a server-supplied one. Neither signer appears as a sender in the 2,000-transaction
sample. The 50 most recent Base transactions from each signer, reaching back to August, are
`transferWithAuthorization` calls and no `deposit`.

---

## 3. On devnet the organisation runs its own. Could an agent node run or share one?

### 3.1 How the devnet's is run

- **What it is.** The **Onboarder**: the published `@x402/core` and `@x402/evm` facilitator, reduced
  to `batch-settlement` on one network, with no `receiverAuthorizer` (I:`onboarder/index.mjs:1-33`,
  `:92-94`). It is an Express service with `/verify`, `/settle`, `/supported` and `/health`
  (`:112-155`).
- **Where.** `https://onboard.devnet.toonprotocol.dev`, on the one devnet host behind the edge, on
  its own network. It "is **not a Node**. It has no connector, no ILP address and no seal key, and
  nothing pays it over ILP" (I:`docs/adr/0002-the-onboarder-runs-on-the-devnet-host-but-is-not-a-node.md:16-21`).
  It measured 49 MiB idle (`:21`).
- **What it holds.** One funded key with no other role. "The only thing of value it has is the gas
  payer's Base Sepolia ETH" (I:`onboarder/deploy/README.md:19-23`, `:56-61`). `/health` answers 503
  when that key holds no ETH (I:`onboarder/index.mjs:149-150`).
- **What bounds it.** The edge rate-limits `/settle` (I:`docs/adr/0002-…md:43-46`). Its sponsored
  Permit2 approvals are bounded by a token allowlist, a gas cap, a fee cap and once per payer
  (I:`onboarder/deploy/README.md:32-49`).
- **Who names it.** The relay, the store and the gas station each publish it as `facilitator`. The
  gateway does not yet (I:`docs/devnet.md:173-178`; G:`deploy/connector.toml.template:160-163`).
- **Live today.** Its `/supported` lists `batch-settlement` on `eip155:84532` with the extensions
  `eip2612GasSponsoring` and `erc20ApprovalGasSponsoring`, signer `0x88eA231F…0630` (LIVE).

So the devnet already runs **one shared facilitator for several nodes**, paid for by one party.

### 3.2 Could an agent node run one?

Facts:

- It is a second process beside the connector, with a second funded ETH key that must have no other
  role, a public URL payers can reach, and its own RPC client (I:`onboarder/deploy/README.md:56-61`;
  I:`onboarder/index.mjs:63-66`).
- Nothing in the code restricts which `payTo` it relays to. It registers the stock scheme and adds
  no receiver check (I:`onboarder/index.mjs:92-107`).
- `facilitator_url` must be an absolute `http` or `https` URL
  (C:`docs/adr/0076-…md:54-55`).
- A hiding payer's facilitator call goes through its SOCKS proxy (T:`docs/hidden-service.md:130-136`).

**Analysis.** An agent node *can* run one, and for an agent node it is mostly wasted. A node's
buyers in the mesh are its peers, and a peer's deposit uses no facilitator (§4.1). A facilitator of
the node's own serves only clients that pay the node directly at the client edge. For that it adds a
second hot key holding ETH, and a public endpoint that spends on a stranger's request. It lowers no
funding requirement of the node's own: the node still needs ETH on its settlement key, and now needs
ETH on a second key too. Whether an Onboarder behind an onion endpoint works end to end was not
tried: the config rule admits the URL, and the Onboarder's own RPC client has no proxy setting, so
its RPC would dial direct.

### 3.3 Could nodes share one, and does that make a central operator?

Facts about what a facilitator can and cannot do:

- It never holds the payer's funds. The collector pulls from `config.payer` under the payer's own
  signature, and the contract checks its balance rose by exactly `amount`
  (X:`contracts/evm/src/x402BatchSettlement.sol:222-225`).
- It cannot redirect a deposit. An ERC-3009 authorization's nonce is `keccak256(channelId, salt)`
  and a Permit2 transfer's witness is the channel id
  (C:`crates/connector-settlement-evm/src/batch_payer.rs:498-502`, `:576-579`), so the signature
  binds the channel.
- It is never the `receiverAuthorizer`, so it cannot refund earned value to the payer
  (C:`docs/adr/0076-…md:65-67`).
- A payer holding ETH needs no facilitator at all, and the same signed authorization serves either
  path (C:`docs/adr/0076-…md:112-116`; T:`docs/channels.md:263-266`).
- "A facilitator sees the deposits it relays" (T:`docs/hidden-service.md:169-170`).

**Analysis.** Sharing one facilitator does not create a central operator of *payments*. It holds no
money, sits on no packet's path, lands nothing and can refund nothing. It does create three central
things:

1. **A central subsidy.** One party pays the gas for every gasless deposit into every node that
   names it. ADR 0076's reason for the seller paying, "the party selling pays to be paid"
   (C:`docs/adr/0076-…md:71-74`), is gone when the seller names somebody else's.
2. **A liveness dependency for buyers with no ETH.** If it is down, dry or refusing, a zero-ETH
   client cannot open a channel to any node that names it. A buyer holding ETH is unaffected.
3. **A vantage point.** It sees every payer address, receiver address, amount and time for the
   deposits it relays, and the caller's network address unless the caller is behind a proxy.

Whether that is acceptable under "no central operator" is the map's call. The cheaper reading is
that a shared facilitator is a convenience for *client* buyers, falls back cleanly to the buyer's
own ETH, and is not on the mesh's path at all.

---

## 4. Every on-chain action of an agent node

An **agent node** here is a connector with a relay and a store behind it, peered with other nodes.
It is a payer on its outbound channels and a receiver on its inbound ones. The table is the
connector as built at `8b938f9b`.

"Could anyone else send it" is what the contract or program allows, not what the connector does.
"Rides the settlement circuit" is ADR 0073's `rpc_via_socks_proxy = true`
(C:`docs/adr/0073-settlement-rpc-may-ride-the-circuit-once-every-wait-on-it-is-bounded.md:172-183`).

### 4.1 Base (EVM)

| # | When | On-chain call | Who sends it, as built | Native gas from the node's own key? | Could anyone else send it? | Rides the circuit? |
| --- | --- | --- | --- | --- | --- | --- |
| E1 | Boot | none. Boot only reads | n/a | **No.** A key with no ETH boots (I:`docs/devnet.md:143-144`) | n/a | reads do |
| E2 | Once per token, only a token without ERC-3009 | `approve(Permit2, max)` | the node (C:`crates/connector-settlement-evm/src/batch_payer.rs:560-562`) | **Yes** | Not for USDC, which never needs it. Otherwise only through `erc20ApprovalGasSponsoring`, which the connector does not use | yes |
| E3 | `POST /peers`: open the outbound channel of a peering | `deposit(config, amount, collector, data)` | the node (C:`…/batch_payer.rs:459-496`, sent at `:483-491`) | **Yes** | **Yes.** `deposit` has no caller check (X:`contracts/evm/src/x402BatchSettlement.sol:200-232`). This is what a facilitator does for a client | yes |
| E4 | `POST /channels/:id/fund`: top up | `deposit`, same config | the node (C:`…/batch_payer.rs:755-766`) | **Yes** | Yes, as E3 | yes |
| E5 | Open a payout channel toward a client that earns | `deposit` | the node (C:`docs/adr/0075-…md:236-243`) | **Yes** | Yes, as E3 | yes |
| E6 | Pay a packet | none. A voucher is a signature (C:`…/batch_payer.rs:771-800`) | n/a | **No** | n/a | n/a |
| E7 | A peer opens its channel toward this node | the peer's `deposit` | the peer node, from its own gas | **No** | n/a | n/a |
| E8 | A client opens a channel toward this node | the client's `deposit` | the facilitator this node names, or the client from its own ETH | **No** on chain. The operator pays the facilitator off chain | n/a | the connector never calls the facilitator |
| E9 | Land, every 10 minutes while a voucher is new, and at boot | `claim(rows)` | the node (C:`crates/connector-settlement-evm/src/batch_watch.rs:262-264`, cadence `:73`) | **Yes** | **Yes**, as `claimWithSignature`, "callable by anyone (relay-friendly)" given the `receiverAuthorizer`'s signature (X:`…/x402BatchSettlement.sol:261-289`). `claim` itself needs `msg.sender` on the receiver side (`:242-259`) | yes |
| E10 | After each claim that moved something | `settle(receiver, token)` | the node (C:`…/batch_watch.rs:277-296`) | **Yes** | **Yes.** "Permissionless: typically called by the receiver or a facilitator" (X:`…/x402BatchSettlement.sol:296-307`) | yes |
| E11 | A payer starts to leave: within 5 s of `WithdrawInitiated` | `claim` for that channel | the node (C:`…/batch_watch.rs:1-16`, `:66`) | **Yes** | Yes, as E9 | yes |
| E12 | `POST /channels/:id/land` | `claim` | the node (C:`crates/connector-settlement-evm/src/batch_settlement.rs:499-500`) | **Yes** | Yes, as E9 | yes |
| E13 | `POST /channels/:id/withdraw`, first call | `initiateWithdraw(config, amount)` | the node (C:`…/batch_payer.rs:806-853`) | **Yes** | **No.** "Only `config.payer` or `config.payerAuthorizer` may call" (X:`…/x402BatchSettlement.sol:318-327`) | yes |
| E14 | Same route, after `withdrawDelay` (one day by default) | `finalizeWithdraw(config)` | the node (C:`…/batch_payer.rs:859-895`) | **Yes** | **No**, same rule (X:`…/x402BatchSettlement.sol:350-359`) | yes |
| E15 | Cooperative refund to a payer | `refund` / `refundWithSignature` | never sent. "The connector never gives one" (C:`docs/operators/x402-batch-settlement.md:170-171`) | n/a | n/a | n/a |

The operator routes are C:`crates/connector-operator/src/lib.rs:223-230`. The paying half's own
statement is "this node sends `deposit` itself and pays its own gas"
(C:`…/batch_payer.rs:28-29`), and ADR 0076 decision 5 repeats it: "A node's own outbound deposit
involves no facilitator … it sends `deposit` itself from its settlement key and pays its own gas. It
holds ETH anyway" (C:`docs/adr/0076-…md:129-131`).

### 4.2 Solana

| # | When | Instruction | Who sends it, as built | Native gas from the node's own key? | Could anyone else send it? | Rides the circuit? |
| --- | --- | --- | --- | --- | --- | --- |
| S1 | Boot | none, but the key's balance is read | n/a | **Yes, it must be nonzero.** "holds no lamports … fund it before starting the node" (C:`crates/connector-settlement-solana/src/batch/mod.rs:208-216`) | n/a | reads do |
| S2 | First boot of a key | create the node's own receiving token account | the node (C:`…/batch/mod.rs:246-275`) | **Yes:** a fee, and that account's rent | No | yes |
| S3 | `POST /peers`: open the outbound channel | `open` | the **counterparty**, as sponsor. This node signs as payer and posts it to the peer's `sponsorEndpoint` (C:`crates/connector-settlement-solana/src/batch/pay.rs:14-25`) | **No.** The counterparty pays the fee and the rent | It must be the receiver (C:`docs/adr/0074-…md:243-256`) | the post is not RPC. It goes through `socks_proxy` only when the sponsor is an onion host (C:`…/batch/pay.rs:53-61`) |
| S4 | Top up | `top_up` | the node (C:`…/batch/pay.rs:649-688`) | **Yes** | No. The connector "sponsors opens and nothing else" (T:`docs/channels.md:99-101`) | yes |
| S5 | Pay a packet | none. A voucher is a signature (C:`…/batch/pay.rs:694-726`) | n/a | **No** | n/a | n/a |
| S6 | A buyer, peer or client, opens a channel toward this node | `open`, co-signed as fee payer and `rent_payer` | the node, on its public sponsor endpoint | **Yes:** the fee, and 4,711,920 lamports of rent per channel, floated until S10 (C:`docs/adr/0075-…md:421-423`) | No. A third-party sponsor is refused (C:`docs/adr/0074-…md:243-256`) | yes |
| S7 | Land, every 10 minutes per open channel with a new voucher | `settle` | the node (C:`crates/connector-settlement-solana/src/batch/sweep.rs:224-233`, cadence `:60`) | **Yes** | Not established here | yes |
| S8 | A payer asked to close | `settle_and_seal`, or a seal with no voucher | the node, as `payee` (C:`…/batch/sweep.rs:235-258`) | **Yes** | No. The `payee` is its only signer (C:`docs/adr/0074-…md:232-236`) | yes |
| S9 | A channel is sealed | `distribute`, with two idempotent token-account creates | the node (C:`…/batch/sweep.rs:275-330`) | **Yes:** a fee, and rent for any account that is missing | Not established here | yes |
| S10 | A channel is distributed | `reclaim`, several to a transaction | the node (C:`…/batch/sweep.rs:333-348`) | **Yes:** a fee. The rent of S6 comes home | Not established here | yes |
| S11 | Withdraw, first call | `request_close` | the node (C:`…/batch/pay.rs:730-756`) | **Yes** | Not established here | yes |
| S12 | Withdraw, after the grace period (one day by default) | `seal` if the receiver has not sealed, then `distribute` | the node (C:`…/batch/pay.rs:762-799`) | **Yes** | `seal` is called "permissionless" in the code (`:30`). Whichever side's `distribute` lands first does the job | yes |

### 4.3 What the settlement circuit covers

- **Every row marked "yes" rides it** once the chain's table sets `rpc_via_socks_proxy = true`: the
  backend's reads and writes all go through that table's one `RpcTransport`, and there is no direct
  fallback (C:`docs/adr/0073-…md:178-183`, `:212-218`). The EVM rate source rides it too.
- **Three things are not settlement RPC and so are not covered by it:**
  1. the payer-signed Solana `open` this node posts to a peer's sponsor endpoint (S3), which goes
     direct unless the peer is an onion host;
  2. a client's call to the facilitator this node names (E8), which is the client's traffic, not
     the node's;
  3. the RPC of a facilitator the node runs itself, which is a separate process.
- **It hides the node's address from the RPC provider and nothing else.** "It does not hide the
  node's keys, its transactions or its payments, which are on chain either way"
  (C:`CONTEXT.md:273-281`). An API-keyed RPC undoes it
  (C:`docs/adr/0073-…md:162-166`).
- **One measurement is still owed.** A funded submit and confirm over a circuit has not been run:
  both faucets refused (C:`docs/adr/0073-…md:273-275`). The reads were measured, and the writes are
  one round trip of the same shape, "an inference and … labelled as one" (`:98`).

---

## 5. On Solana the receiving node is the sponsor. What does it cost, and what does it float?

Facts:

- **The seats.** The sponsor is the node's Solana settlement key, as fee payer, `rent_payer` and
  `payee` of every channel opened toward it (C:`CONTEXT.md:343-351`).
- **The float.** 4,711,920 lamports, about 0.0047 SOL, per channel, "peers' as well as clients'",
  until `reclaim` (C:`docs/adr/0075-…md:421-423`). It comes back.
- **The fee on each open.** Two signatures, and at most 40,000 lamports of priority fee, because the
  sponsor refuses a compute-unit price above 100,000 microlamports at a 400,000-unit limit
  (C:`crates/connector-settlement-solana/src/batch/sponsor.rs:98-110`;
  C:`crates/connector-cli/src/sponsor.rs:65-69`). This is spent, not floated.
- **What bounds a stranger.** The published `min_sponsored_deposit`, which locks the opener's own
  capital for at least the grace period. At most 8 sponsorships in flight, one per payer, and a
  budget of 8 sent-and-failed opens an hour, "about 400,000 lamports an hour at most"
  (C:`docs/operators/x402-batch-settlement.md:310-316`; C:`crates/connector-cli/src/sponsor.rs:60-72`).
- **The rest of a channel's life is the sponsor's to pay too:** `settle`, the seal, `distribute` and
  `reclaim` (§4.2, S7 to S10).
- **No facilitator replaces it.** PayAI offers Solana mainnet `batch-settlement` with itself as
  `feePayer` (LIVE), which seats it as `payee`. ADR 0074 decision 5 refuses a third-party sponsor,
  because it could seal before the node lands (C:`docs/adr/0074-…md:243-256`).

**Analysis: per buyer, in SOL.** One buyer's channel costs the receiving node about 0.0047 SOL of
float for the channel's whole life, plus fees that are spent: one open, one `settle` per ten-minute
sweep in which that channel earned, then a seal, a `distribute` and a `reclaim`. At Solana's base
fee of 5,000 lamports a signature, and before any priority fee, the spent part is of the order of
0.00003 SOL for a channel that opens and closes without traffic, and grows by one fee per sweep that
lands. The float is the larger number until a channel has been swept several hundred times. At the SOL price PayAI's pricing page used on
2026-09-22, $116.60 (P:`x402/facilitators/pricing.mdx:77-78`), the float is about $0.55 a channel.
A node with 20 peers and clients floats about 0.094 SOL.

**Analysis: a peering costs each side the other's rent.** On Solana each node's outbound `open` is
sponsored by the other. So a two-way peering makes each side float 0.0047 SOL for the other's
channel, and neither pays for its own open. That is symmetric, and it is what a peering handshake
would be asking each side to commit on Solana.

---

## 6. What it costs on Base mainnet today

Observed fees, from the 2,000-transaction sample (CHAIN). Each figure is the total fee the sender
paid, L1 data fee included. USD is at $2,693.99 per ETH, Blockscout's own `coin_price` at the time
of reading.

| Call | n | Median gas used | Median fee, wei | Median fee, USD |
| --- | --- | --- | --- | --- |
| `deposit` (ERC-3009 collector) | 157 | 140,636 | 887,625,682,714 | $0.0024 |
| `claimWithSignature` | 1,138 | 57,812 | 361,144,142,968 | $0.0010 |
| `settle` | 629 | 56,840 | 342,453,718,712 | $0.0009 |
| `initiateWithdraw` | 2 | 53,097 | 324,611,159,107 | $0.0009 |
| `finalizeWithdraw` | 6 | 77,710 | 477,172,323,438 | $0.0013 |
| `refundWithSignature` | 36 | 95,250 | 611,062,597,137 | $0.0016 |

The widest spread in the sample was a `claimWithSignature` at 3,102,529,995,585 wei, about nine
times the median. PayAI's own figures agree: "a deposit costs about 140,000 gas, a single-channel
claim about 77,000, a sweep about 57,000 and a refund about 95,000"
(P:`x402/servers/evm-batch-settlement.mdx:137`).

**Analysis: what a node spends.**

- **To open a peering:** one `deposit`, about $0.0024.
- **To earn:** at most one `claim` and one `settle` per ten minutes. Running flat out that is 144
  pairs a day, about 0.0001 ETH, or $0.27 a day. A node that earned nothing in a sweep sends
  nothing. The connector calls `claim`, not `claimWithSignature`. Its cost was not measured and
  should be a little lower, since it checks no authorizer signature.
- **To leave a peering:** `initiateWithdraw` and `finalizeWithdraw`, about $0.0022 together.
- **So 0.001 ETH, about $2.70, covers** roughly a thousand deposits, or about ten days of sweeping
  at the maximum rate.

These are one two-day sample of an L2's fees. They can move by an order of magnitude.

---

## 7. So: what must a user fund?

### 7.1 As the connector is built today

| Node configuration | Before it can **pay** | Before it can **earn** |
| --- | --- | --- |
| **Base only** | USDC and ETH, both at the node's EVM settlement address. USDC is the collateral of each outbound channel. ETH pays for each `deposit` (E3, E4). | ETH at the same address, for `claim` and `settle` (E9, E10). No USDC. |
| **Solana only** | USDC and SOL, both on the node's Solana settlement key. SOL is needed to boot at all (S1), and then for top-ups and for leaving. The open itself is paid by the peer. | SOL on the same key: to boot, to sponsor each buyer's open and float its rent (S6), and to land (S7 to S10). No USDC. |
| **Both** | Both rows. Two addresses, since the two keys are different curves, and four balances. | Both rows. |

**One token at one address is not enough on either chain.** The least a user can fund is one
address with two assets, on a Base-only node.

Three details that change the install's wording:

1. **A Base-only node boots and can be paid with no ETH.** EVM boot only reads. Vouchers are
   admitted from the chain's state and cost nothing to accept. What a node with no ETH cannot do is
   land them, and an unlanded voucher is lost when the payer's withdrawal finalizes
   (C:`docs/adr/0074-…md:207-210`). So "before it can earn" really means "before it can keep what it
   earns". The first voucher and the first `claim` can be a day apart at the default `withdrawDelay`.
2. **A Solana node does not start without SOL.** There is no such grace on Solana
   (C:`crates/connector-settlement-solana/src/batch/mod.rs:208-216`; C:`README.md:390-396`).
3. **Earning never needs USDC.** A node that only sells holds no collateral. On Base it needs only
   ETH, and nothing else if it has no ETH-less clients to name a facilitator for.

### 7.2 What a peering asks each side to commit

- **Base.** Each side deposits USDC into its own outbound channel and pays that deposit's gas. Each
  side later pays gas to land what it receives. Neither pays anything for the other. Collateral
  roughly doubles on a two-way peering "because nothing nets" (C:`docs/adr/0075-…md:414-417`).
- **Solana.** Each side deposits USDC into its own outbound channel, and **the other side** pays
  that open's fee and floats its rent. Each side later pays to land.
- **Either chain.** Getting collateral back takes the counterparty's minimum delay, one day by
  default, and two transactions from the payer's own key.

### 7.3 Where the facilitator fits, and where it does not

- **It fits** a buyer that is a **client** of the node: a `toon-client` user with USDC and no ETH,
  opening a channel at the client edge. For that buyer on Base mainnet, PayAI is a name a node could
  publish today, within the limits in §2.4.
- **It does not fit** a peering. A node's own deposit goes straight to the chain (E3). The map's
  destination has the agent pay through its own node's peerings, so the agent's own payments never
  touch a facilitator, and its node needs ETH to make them.
- **This client is the gasless payer the connector is not.** `toon-client` opens a Base channel with
  no ETH through the named facilitator (T:`docs/channels.md:66-71`), and replaces a Solana top-up
  with a fresh sponsored channel so that it needs no SOL (T:`docs/channels.md:99-101`). The
  connector's paying half does neither.

### 7.4 Analysis: what would get a Base node to one token at one address

Read from the contract, not from any record:

- **Opening and topping up** need no gas of the node's: the node already signs a
  `receiveWithAuthorization` for each deposit (C:`…/batch_payer.rs:503-539`), and `deposit` accepts
  it from any sender.
- **Landing** needs no gas of the node's: `claimWithSignature` takes the `receiverAuthorizer`'s
  signature from any sender, and `settle` is open to all. PayAI sells exactly these legs.
- **Leaving** does need it. `initiateWithdraw` and `finalizeWithdraw` have no signed variant. The
  only gasless exit is the receiver's cooperative `refundWithSignature`, which the connector never
  gives.

So a node could run on USDC alone until the day it winds a channel down, if it relayed its own
deposits and its landing through a facilitator. Three things stand in the way, and all three are
decisions, not facts:

1. **ADR 0076 forbids it today.** Its falsifier is any `crates/**/*.rs` addressing a facilitator's
   `/settle`, `/verify` or `/supported`, and it says "the connector never calls it"
   (C:`docs/adr/0076-…md:7`, `:61-64`).
2. **Whose facilitator.** For a peer's deposit the receiving peer's named facilitator is the natural
   one, since the seller pays to be paid. For landing it would be one the node picks for itself.
3. **Landing through a third party puts the exit race in its hands.** A claim that is censored or
   late loses the voucher. ADR 0074 set the one-day default delay for exactly that window
   (C:`docs/adr/0074-…md:217-220`).

On Solana no such route exists: the receiving node must be the sponsor, so it must hold SOL.

**A cheaper alternative the install could take without touching the connector:** fund the node's
EVM address with USDC only, and have the install buy the first ETH for it. Nothing read here
provides that. The gas station does not: its EVM leg relays ERC-2771 forward requests to a
`TokenNetwork` (G:`README.md:160-166`), which ADR 0075 retired, and `x402BatchSettlement` reads
`msg.sender` directly.

---

## 8. What was not verified

- **Whether any mainnet facilitator relays a deposit toward a TOON connector.** No `/settle` was
  sent. PayAI's on-chain deposits match the channel shape a connector admits, for one payer and one
  receiver. That is evidence, not a run.
- **Whether PayAI accepts a keyless `/settle` for `batch-settlement`.** Its EVM page says yes and
  its endpoint table says a key is required (§2.4).
- **PayAI's price for a Base batch leg in credits.** The formula is published, and the live rate
  table has no row for it. The "about 3 credits" and "roughly 300 deposits" in §2.6 are arithmetic
  from observed gas.
- **Whether this client's settle request is accepted by PayAI as sent.** PayAI documents a `/verify`
  step and a 100-second answer budget. This client posts `/settle` only.
- **Who the unattributed senders are.** `0xB3ED726D…641b` sent 113 of the sample's 157 deposits, to
  channels whose `receiverAuthorizer` differs from the receiver in every row tallied, and
  `0x5BD51469…ED67` sent 1,004 of its 1,138 `claimWithSignature` calls. Either could be CDP's. CDP publishes no signer list that was reachable without a key.
- **Anything about CDP beyond its documentation.** Its `/supported` needs a key, its code is closed,
  and the two pages were read through a text converter.
- **Whether Dexter or Solvador honours a server-supplied `receiverAuthorizer`**, and their rate
  limits and screening.
- **The cost of a direct `claim`**, of a Permit2 `approve`, and of any Solana instruction. Solana
  figures are the records' rent constant and the base fee per signature. No Solana transaction was
  read from chain, and the rent of a token account is not cited here.
- **Whether `payment-channels` lets a third party send `settle`, `distribute` or `reclaim`.** The
  table says "not established". The program's source was not read for this note.
- **Whether an Onboarder can sit behind an onion endpoint.** Inferred from the config rule only.
- **A funded settlement transaction over a circuit.** Still owed by ADR 0073 itself.
- **That EVM boot sends no transaction.** Taken from infra's devnet notes and from finding no
  balance check in `connector-settlement-evm`. The boot path was not traced line by line.
- **Devnet's current state.** Read from infra's documents and the live `/supported`. No node's live
  `GET /ilp` was fetched.
- **The fee figures as a forecast.** They are one sample of about 52 hours.

## 9. Records this note found out of date

For whoever owns them. None of these is this repository's to edit.

- **C:`docs/research/x402-devnet-facilitators.md:48-50`, `:323-327`** says PayAI offers `exact`
  only on EVM and batch only on Solana mainnet, behind an API key. As of 2026-10-01 PayAI advertises
  `batch-settlement` on `eip155:8453` and `eip155:84532`, and documents it as public.
- **C:`docs/adr/0076-…md:37-38`** says "a mainnet payer had no default at all". It still has no
  *default*, since this client names none off the devnet
  (T:`packages/client/src/presets.ts:118-126`), but a keyless mainnet facilitator now exists.
- **C:`docs/operators/x402-batch-settlement.md:331-333`** recommends CDP as the hosted option for
  mainnet. CDP needs the seller's API key on a call that, in TOON, the payer makes (§2.6).
- **G:`README.md:160-166`, `:177-195`** still describes relaying `TokenNetwork` calls and the TOON
  channel program, both retired by ADR 0075.
