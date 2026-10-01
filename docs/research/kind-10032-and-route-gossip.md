# Is the announcer's kind:10032 event enough for route gossip?

> **Research note, not a decision record.** It answers
> [toon-client#718](https://github.com/toon-protocol/toon-client/issues/718), a ticket on the map
> [toon-client#715](https://github.com/toon-protocol/toon-client/issues/715). It decides nothing.
> Written 2026-10-01. Sections 1 to 7 are fact, each tagged with how it was established. Section 8
> is analysis and says so.

**Evidence tags.** CODE: read in source at the cited path, line and commit. LIVE: observed on
2026-10-01 against the public devnet. RUN: produced by running the announcer's own code (see
§2.3). DOC: stated by a record in a repository, not checked against code. INFERRED: my reading.

**Checkouts read.** All local, none modified, none fetched. A checkout may be behind its remote.

| Repository | Commit | Branch | Commit date |
| --- | --- | --- | --- |
| `connector` | `8b938f9b` | `main` | 2026-09-30 |
| `relay` | `1765503` | `main` | 2026-09-29 |
| `toon` (`@toon-protocol/core`, `sdk`) | `bccc7ca` | `main` | 2026-08-28 |
| `toon-client` | `0a6019a` (`origin/main`, tag `@toon-protocol/client@4.2.0`) | worktree | 2026-09-30 |
| `TOON_Network` | `d5a1963` | `main` | 2026-09-24 |
| `provider` | `97a59b8` | `main` | 2026-09-22 |
| `console` | `76d9382` | `main` | 2026-09-24 |
| `infra` | `b607340` | `issue-42-dealer` | 2026-09-29 |
| `toon-meta` | `bb518c1` | `main` | 2026-09-30 |
| `swap` | `f7d092f` | `main` | 2026-09-30 |
| `store` | `1d9f018` | `main` | 2026-09-29 |
| `rig` | `70281f5` | `fix/relay-client-strictmode-error` | 2026-09-18 |
| `gas-station` | `8ddddd1` | `main` | 2026-09-29 |
| `gateway` | `ea3131e` | `issue-109-ci-note` | 2026-09-23 |

Paths below are relative to the repository named, and `announcer/` is short for
`connector/packages/announcer/`.

---

## 1. The answer

**No. The event is a contact card for one node, not a route advertisement.** It says where a node
is, what it settles in, the key a packet is sealed to, and what a list of addresses costs at that
node's own client edge. It says nothing about which prefixes the node terminates as opposed to
forwards, nothing about what it will carry for a peer, and nothing about peers, fees or caps.

Five things frame everything below:

1. **Most of the content is the sidecar's own configuration, not the node's answer.** Eight content
   fields are environment variables. Only the settlement facts, the prices and the sealing key are
   read from the connector (§2.2).
2. **It is signed by a key the connector does not know.** Nothing in the event, and nothing the
   connector answers, ties the signing key to the connector (§3).
3. **`routePrices` is not a list of routes.** The connector answers the announcer's probe for any
   address, routed or not. An address nobody routes appears with price `"0"` (§2.3, §4).
4. **Nothing publishes it and nothing current reads it.** No deploy file in the connector repository
   runs the sidecar, the devnet relay holds no event from it, and the only code that queries kind
   10032 is the legacy `@toon-protocol/core` library (§6, §7).
5. **The connector's self-description already carries more than the event does**, and `POST /peers`
   reads the self-description, never an event (§2.4, §8.1).

---

## 2. The event, exactly

### 2.1 The envelope

| Field | Value | Source |
| --- | --- | --- |
| `kind` | `10032` | constant, `announcer/src/event.ts:25` |
| `pubkey` | the announcer's own key | derived from `ANNOUNCER_IDENTITY_SECRET_KEY_HEX` or `_FILE` by `finalizeEvent`, `event.ts:104-112`; `config.ts:95-116` |
| `created_at` | now, unix seconds | `event.ts:98` |
| `tags` | `[["expiration", "<created_at + ttl>"]]` when the TTL is positive, otherwise `[]` | `event.ts:99-102` |
| `content` | `JSON.stringify(info)` | `event.ts:107` |
| `id`, `sig` | NIP-01 id and BIP-340 signature | `nostr-tools` `finalizeEvent`, `event.ts:104` |

The `expiration` tag is the only tag the code can emit. There is no `d`, no `p`, no label and no
topic tag. CODE.

### 2.2 The content

`buildAnnouncementInfo` (`announcer/src/announce-builder.ts:62-111`) builds the object. "Config"
means an environment variable of the sidecar. "Edge" means read from the connector at
`ANNOUNCER_RUST_EDGE_URL`, by `GET /ilp/identity` (`edge-client.ts:86-116`) or by an unpaid
`POST /ilp` that draws the x402 greeting (`edge-client.ts:129-175`, parsed at `:187-221`). CODE.

| Field | Present | Where the value comes from |
| --- | --- | --- |
| `ilpAddress` | always | Config. `ANNOUNCER_ILP_ADDRESS`, default `g.toon` (`config.ts:83`, `:185`) |
| `ilpAddresses` | when more than one | Config. `ANNOUNCER_ILP_ADDRESSES`, primary forced in (`config.ts:186-188`; `announce-builder.ts:95`) |
| `btpEndpoint` | always | Config. `ANNOUNCER_BTP_ENDPOINT`, default `wss://proxy.devnet.toonprotocol.dev/rust/ilp/btp` (`config.ts:85`, `:223`) |
| `httpEndpoint` | always | Config. `ANNOUNCER_HTTP_ENDPOINT`, default `https://proxy.devnet.toonprotocol.dev/rust/ilp` (`config.ts:84`, `:222`) |
| `relayUrl` | when resolvable | Config. `ANNOUNCER_RELAY_PUBLIC_URL`, else the first `ws://` or `wss://` entry of `ANNOUNCER_RELAY_URLS` (`config.ts:227-229`) |
| `assetCode` | always | Config. `ANNOUNCER_ASSET_CODE`, default `USDC` (`config.ts:231`) |
| `assetScale` | always | Config. `ANNOUNCER_ASSET_SCALE`, default `6` (`config.ts:232`) |
| `supportedChains` | when any greeting parsed | Edge. Each greeting `accepts[]` entry with `scheme: "batch-settlement"`; its CAIP-2 `network` rewritten: `eip155:<id>` to `evm:<id>`, any `solana:*` to the **config** value `ANNOUNCER_SOLANA_CHAIN_ID` (default `solana:devnet`) (`announce-builder.ts:74-78`, `:85-87`) |
| `settlementAddresses` | same | Edge. `{ <chain>: accepts[].payTo }` (`announce-builder.ts:88`) |
| `preferredTokens` | same | Edge. `{ <chain>: accepts[].asset }` (`announce-builder.ts:89`) |
| `routePrices` | when any greeting parsed | Edge. `{ <probed address>: extensions.toon.info.price }`, one entry per address in `ANNOUNCER_PROBE_ROUTES` (default: `ilpAddresses`) that answered `402` (`announce-builder.ts:81`; `config.ts:220`) |
| `edgeIdentity` | when `/ilp/identity` answered | Edge. `{ keyId, publicKey }` copied from `GET /ilp/identity` (`announce-builder.ts:105`) |
| `routes` | always | Config and a guess. `{ publish, store }` from `ANNOUNCER_ROUTE_PUBLISH` and `_STORE`, else derived by suffix: the first address ending `.relay`, the first ending `.store` or `.ario`, and when one is missing it is **invented** from the other by swapping the suffix (`config.ts:123-148`) |
| `notice` | when configured | Config. `{ id, severity, summary, url }` from four `ANNOUNCER_NOTICE_*` variables (`config.ts:160-181`) |

`tokenNetworks` is in the type (`event.ts:60`) and is never set by the builder. CODE.

A poll failure does not stop the publish. A failed identity fetch drops `edgeIdentity`; a failed
greeting drops that address from `routePrices`; the event goes out with what is left
(`service.ts:134-170`; `edge-client.ts:19-22`). CODE.

### 2.3 A real one

I ran `AnnouncerService.buildEvent()` unmodified, with a throwaway key (`0x11…11`), pointed at the
devnet relay's connector, probing its four published prefixes and one address nobody routes. It
was built and **not published**. RUN, 2026-10-01 13:59 UTC.

```json
{
  "kind": 10032,
  "pubkey": "4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa",
  "created_at": 1790863178,
  "tags": [["expiration", "1790863778"]],
  "content": {
    "ilpAddress": "g.toon.relay",
    "ilpAddresses": ["g.toon.relay", "g.toon.relay.ephemeral"],
    "btpEndpoint": "wss://proxy.relay.devnet.toonprotocol.dev/ilp/btp",
    "httpEndpoint": "https://proxy.relay.devnet.toonprotocol.dev/ilp",
    "relayUrl": "wss://relay-ws.devnet.toonprotocol.dev",
    "assetCode": "USDC",
    "assetScale": 6,
    "supportedChains": ["evm:84532", "solana:devnet"],
    "settlementAddresses": {
      "evm:84532": "0x3f43d923a611bcb2d0bfb5d6ee2c3ac3efeaf308",
      "solana:devnet": "GzvGVjq3dnNM79MpWRvYCvVcAgPWzDdYisMwGxHF4u9F"
    },
    "preferredTokens": {
      "evm:84532": "0x0c996d7c934c79a6255254875607fe69df25c0e1",
      "solana:devnet": "34eSxY7qxQ4GzyhDJ8GpUcTz1WWzruGbJbR8q6TtxfQU"
    },
    "routePrices": {
      "g.toon.relay": "1",
      "g.toon.relay.ephemeral": "0",
      "g.toon.relay.store": "1001",
      "g.toon.relay.gas": "1001",
      "g.nobody.routes.this": "0"
    },
    "edgeIdentity": {
      "keyId": "connector-signer",
      "publicKey": "0x04915d29908235be4b53f8f23cd7ac72c88c99be3bcca876dadf5c1a449433b8f900bed774f10f2360fc01d27e92e0138f018e54c9558d2deb05efd9688d032bdd"
    },
    "routes": { "publish": "g.toon.relay", "store": "g.toon.store" }
  }
}
```

(`content` is a JSON string on the wire; it is shown parsed. `id` and `sig` are omitted.)

Three things this run shows:

- **The sidecar still works against the deployed connector.** Its hand-rolled PREPARE encoder
  (`announcer/src/oer.ts:84-93`) is accepted.
- **`g.nobody.routes.this` is in `routePrices` at `"0"`.** No route matches it.
- **`routes.store` is `g.toon.store`, which I never configured.** The suffix heuristic invented it
  from `g.toon.relay`.

### 2.4 What the node answers that the event drops

The same connector's `GET /ilp`, fetched at the same time (LIVE), answered the document defined by
`NodeSelfDescription` (`connector/crates/connector-domain/src/node.rs:211-275`). Set beside the
event:

| The connector answers | In the event? |
| --- | --- |
| `routes[].pricePerKib` (here `"10"` on `g.toon.relay.store`) | No. Only the base price is copied (`edge-client.ts:198-213`) |
| `routes[].requiredTransport` (here `"btp"` on `g.toon.relay`) | No |
| `routes[].request` (what to send a route) | No |
| `voucherSigners` (the key a peer binds this node's channel by) | No |
| `peerCarriages` (whether the node can be peered with at all; here `[]`) | No |
| `batchSettlements[]` beyond `network`, `asset`, `payTo`: `receiverAuthorizer`, `withdrawDelay`, `name`, `version`, `assetTransferMethod`, `facilitator`, `feePayer`, `tokenProgram`, `minDeposit`, `sponsorEndpoint` | No |
| `supportedVersions`, `defaultVersion` | No |
| The Solana network as a CAIP-2 genesis hash | Replaced by a configured label |

The announcer does not read `GET /ilp` at all. It reads `GET /ilp/identity` and the greeting, the
two surfaces that existed when it was written (2026-08-01, `b9d4595b`); the self-description
endpoint landed later (`connector/docs/protocol/self-description-spec.md:260-263`). CODE, DOC.

---

## 3. Which key signs it, and how a reader ties it to the connector

**The key.** A 32-byte secp256k1 secret read from `ANNOUNCER_IDENTITY_SECRET_KEY_HEX` or
`ANNOUNCER_IDENTITY_SECRET_KEY_FILE`, exactly one of the two, 64 hex characters, or the sidecar
refuses to start (`announcer/src/config.ts:95-116`). The README calls it the sidecar's "own
dedicated announce identity" and says it is never the connector's sealing key
(`announcer/README.md:30-39`; `event.ts:86-88`). CODE.

**The tie.** There is none that a reader can check. CODE, INFERRED.

- The event names the connector: `httpEndpoint` and `edgeIdentity` are in the content. Both are
  the signer's claim. `httpEndpoint` is a configured string, never compared with anything the
  connector says.
- The connector does not name the signer. Its self-description has no field for a Nostr pubkey
  (`node.rs:211-275`), and it is unsigned plain JSON.
- A reader can follow `httpEndpoint`, `GET` it, and compare the `edgeIdentity` it finds with the
  one in the event. That proves the signer copied a real node's public facts. Anybody can do that
  for any node.

The README's own remedy is a human one: the orchestrator "must confirm the configured key's pubkey
(logged at startup) is the CURRENT live identity for the box" (`announcer/README.md:36-39`). The
only machine binding that ever existed was a pinned pubkey in a genesis seed
(`connector/infra/linode-relay/.env.example:37`). DOC.

ADR 0046 names this exact property: an announce signed by someone other than the node is "that
controller's claim about the node rather than the node's claim about itself — a materially
different security property from what kind:10032 has meant"
(`connector/docs/adr/0046-…md:51-54`). The event that had the stronger property was the one
`connector announce` produced before ADR 0046 removed it, signed with the node's identity key;
an earlier note records one such stale event whose pubkey was the x-coordinate of the relay
connector's sealing key (`toon-client/docs/research/nostr-kinds-for-app-discovery.md`, §6.8
option B). That event is no longer on the relay (§6.2). DOC, LIVE.

---

## 4. Terminates, carries, peers, fees, cap

| Question | Answer | Evidence |
| --- | --- | --- |
| Does it say which routes the node **terminates**? | **No.** `ilpAddresses` is a configured list of names. `routePrices` is whatever the probe list drew a `402` for, and the connector answers `402` to a greeting probe for a terminated route, a forwarded route and an unrouted address alike. | CODE: `connector/crates/connector-client-edge/src/lib.rs:1302` (`!has_claim_header && (charge > 0 \|\| prepare.greeting)`), and the announcer always sets `greeting: true` (`edge-client.ts:134-140`). RUN: §2.3 |
| Does it say which prefixes the node **carries** for others? | **No.** | CODE: no such field in `IlpPeerInfo` (`event.ts:50-67`) or in the builder |
| Peers? | **No.** | CODE, same |
| Fees? | **No.** The legacy type in `@toon-protocol/core` has `feePerByte`; the announcer's type omits it and its builder never sets it. | CODE: `toon/packages/core/src/types.ts:56`; `announce-builder.ts:93-108` |
| Cap? | **No.** | CODE, same |

The announcer's own comment says a `402` comes back "exactly when the route is
locally-terminated and priced" (`edge-client.ts:121-124`). That is stale against the connector it
polls: the greeting branch says in terms "whether the work is an app's or a peering's carriage"
and answers a declared greeting probe "regardless of destination" (`lib.rs:1236-1254`). CODE.

**The self-description is no better on termination, and slightly more forthcoming on carrying.**
Its `routes` array lists every prefix the node prices at its client edge: terminated routes,
config-file forwarded routes and runtime forwarded routes, in one list, sorted, with no field
saying which is which (`connector/crates/connector-runtime/src/connector.rs:3479-3500`;
`node.rs:155-199`). The live devnet relay's document lists `g.toon.relay.store` and
`g.toon.relay.gas`, which `toon-client/docs/devnet.md:39` says are forwarded, beside its two
terminated prefixes, indistinguishably. CODE, LIVE. So a node already publishes prefixes it
forwards for paying *clients*. It never says who it forwards them to. A **leased** route is
absent from that list, because a lease carries no price (`connector.rs:3415-3419`, `:3477-3478`).

Peer identities, per-peering fees and caps are withheld by rule, not by omission: ND-09 and ND-10
(`self-description-spec.md:171-183`). A cost is learned by a probe and a cap by a `T04` reject
(`connector/CONTEXT.md:393-399`, `:465-475`). DOC.

---

## 5. Onion endpoint, and asking the terminating connector directly

**It can carry one, and nothing in it is onion-aware.** `httpEndpoint` and `btpEndpoint` are
configured strings with no validation, so an operator can set them to a `.anyone` or `.onion`
URL. That matches the connector, where an onion URL is "a legal value for the existing
`http_endpoint` and `btp_endpoint`" with no second key (`connector/docs/adr/0070-…md:129-133`).
CODE, DOC.

Two limits: CODE.

- The defaults are clearnet URLs under `/rust/ilp` (`config.ts:84-85`). The connector's own source
  says that path "answers 410 Gone on both devnet boxes"
  (`connector/crates/connector-config/src/error.rs:981`). An unset variable publishes a dead URL.
- The sidecar has no SOCKS support. It publishes with the platform `WebSocket` and `fetch`
  (`publisher.ts:72`, `:83-97`), so it cannot write to a relay that is itself an onion host. It
  polls the connector at an internal URL, so that half is unaffected.

**For ADR 0022's "ask direct, pay routed"** (`connector/docs/adr/0022-…md:57-61`): the event gives
a buyer the URL to ask, in `httpEndpoint`. It also carries the answer, `edgeIdentity`, which is
the sealing key. A buyer who seals to the key in the event has trusted the event's signer, not
the node. The connector's rule for its own hops is that a client "learns an identity from the
node that owns it" (ND-14, `self-description-spec.md:216-224`), and that "a URL is safe where a
key is not" (`:234-236`). ADR 0022 itself rejected a signed announce as the primary mechanism and
kept it as "the fallback if a terminating connector ever cannot be reached directly" (`:69-73`).
TOON Network takes the opposite position for its Provider Profile: the key in the event is the
pin and the URL is a hint (`TOON_Network/docs/spec/toon-network-v1.md`, §4.1). DOC.

The event describes only its own node. It carries no URL for the terminating connector of any
prefix that node forwards.

---

## 6. Replaceable or addressable, and expiry

**By NIP-01, replaceable.** Kind 10032 is in `10000–19999`, the event has no `d` tag, and the
announcer's source says a relay replaces it "by `(pubkey, kind)` alone"
(`announcer/src/event.ts:13-17`; `announcer/README.md:71-79`). CODE.

**On the TOON relay, addressable.** `relay` carves `10032–10099` out of the replaceable range and
stores those kinds by `(pubkey, kind, d)`:
`relay/packages/relay/src/storage/SqliteEventStore.ts:144-158`. With no `d` tag the value is the
empty string (`:163-166`, `:452-458`), so one announcer key still holds one event and the outcome
is the same. The difference would matter to any new kind placed in `10033–10099`: with a `d` tag
it would hold several events per author on a TOON relay and one on a stock relay. CODE.

**It expires.** Each event carries NIP-40 `["expiration", created_at + ttl]`. The TTL is
`ANNOUNCER_TTL_SECS`, default twice the refresh interval; the interval is
`ANNOUNCER_REFRESH_INTERVAL_SECS`, default 300 s. So by default an event is republished every
five minutes and expires after ten (`config.ts:82`, `:199-207`; `service.ts:60-82`). A TTL of zero
or less omits the tag and the event never expires (`event.ts:99-102`). CODE.

The TOON relay enforces NIP-40 on read and on fan-out by default
(`relay/packages/relay/src/launcher/relay.ts:135-158`; `nips/expiration.ts:1-14`). A relay that
does not enforce it serves the last event for ever.

---

## 7. What reads kind:10032 today

### 7.1 In source

Searched every plain-named checkout for `10032`, `IlpPeerInfo` and `ILP_PEER_INFO`.

| Repository | Reads kind:10032? | What was found |
| --- | --- | --- |
| `toon` (`@toon-protocol/core`, `sdk`) | **Yes, the only one.** | A parser, `parseIlpPeerInfo` (`packages/core/src/events/parsers.ts:78-326`), and four readers that query `{kinds:[10032]}`: `discovery/NostrPeerDiscovery.ts:116-208`, `discovery/seed-relay-discovery.ts:252-284`, `bootstrap/BootstrapService.ts:626-900`, `bootstrap/discovery-tracker.ts:163-197`; the SDK feeds accepted events to the tracker (`packages/sdk/src/create-node.ts:680-687`). This is the stack built around the retired TypeScript connector. |
| `toon-client` | No. | Two comments only. The file ADR 0046 names, `discovery-subscription.ts`, does not exist. `btp/transport-select.ts:16-20` says the client "keyed this decision on a peer discovered from a kind:10032 relay announce" and that this is "gone". |
| `relay` | Stores it; does not act on it. | Storage class in §6; NIP-40 comments. `README.md:237-240`: "There used to be a kind:10032 announce … It is gone". |
| `rig` | No. | Six comments. `src/standalone/connector-publisher.ts:9` and `cli/standalone-mode.ts:9` say it was removed. No filter names the kind. |
| `swap` | No. | `packages/swap/src/cli.ts:117-120` refuses four old `peerInfo*` options with "the kind:10032 announce is gone". |
| `store`, `gas-station` | No. | Prose and comments that still describe the announce as live (`store/README.md:259`; `gas-station/src/solana-gas-station-handler.ts:208`, `:874`). |
| `TOON_Network`, `provider`, `console`, `gateway` | No. | No match at all. |
| `infra` | No. | Matches only inside `node_modules`. |
| `toon-meta` | Documentation. | 63 files mention it, many describing it as live. |

The parser in `@toon-protocol/core` returns a fixed set of fields
(`parsers.ts:296-326`). It drops `routes`, `routePrices`, `edgeIdentity` and `relayUrl`, which are
four of the fields the announcer writes, and it defaults `feePerByte` to `"0"`, a field the
announcer never writes. So even the one reader does not read the announcer's event as written.
CODE.

### 7.2 On the devnet relay

`{"kinds":[10032]}` against `wss://relay-ws.devnet.toonprotocol.dev`, 2026-10-01 13:58 UTC,
returned two events. LIVE.

| Author | `created_at` | `ilpAddress` | Shape |
| --- | --- | --- | --- |
| `43d7e7a9…` | 2026-08-16 | `g.toon.swap.maker` | No tags, so no expiry. Has `pubkey`, `tokenNetworks`, `swapVerifyingContracts`, `swapPairs`. No `routes`, no `edgeIdentity`. |
| `b23599a6…` | 2026-08-15 | `g.toon.swap.sol` | Same shape. `btpEndpoint` is `ws://127.0.0.1:3401`. |

Neither is the announcer's shape. Both are swap-maker announces from before `swap` removed its
own (`swap/packages/swap/src/cli.ts:117-120`). Both are 46 days old and still served, because
they carry no `expiration`. **There is no event from the sidecar on the relay.**

### 7.3 Is the sidecar deployed?

Not from the connector repository. CODE, DOC.

- The package is a private npm workspace, lint-checked in CI and nothing more
  (`connector/package.json:7`; `.github/workflows/ci.yml:110`).
- The compose overlay that ran it is cited by a comment
  (`connector/infra/linode-relay/nginx/conf.d/node.conf:149-152`, naming
  `infra/linode-node/docker-compose.node.announcer.yml`) and does not exist; `connector/infra/` has
  no `linode-node` directory.
- The connector's own code calls it "the retired announcer sidecar"
  (`crates/connector-config/src/error.rs:981`; `connector/CLAUDE.md:182`).
- Its last functional change was 2026-09-28 (`20c2fb40`, the ADR 0075 greeting shape), so it is
  kept compiling against the connector, and §2.3 shows it still runs.

It also cannot publish to a TOON relay from outside. The relay's websocket refuses every write, so
the sidecar must use the relay's private `POST /write` ingress
(`announcer/src/publisher.ts:6-21`, `:78-114`), and it holds no channel to pay a remote relay with
(`:23-30`). For a node whose relay sits beside its connector, that ingress is local and the limit
does not bite.

---

## 8. What route gossip would still be missing — analysis

Everything in this section is INFERRED from the facts above. It lists what is missing. It does
not propose events.

### 8.1 What the node's operator surface needs

An agent acting as controller makes three writes. CODE, DOC.

| Write | Body | What the agent has to know first |
| --- | --- | --- |
| `POST /peers` | `{ id, url, fee, max_packet_amount, deposit, chain? }` (`connector/docs/protocol/operator-spec.md:149-151`, `:189-193`, `:207-208`) | The counterparty's **self-description URL**. Everything else is read from that URL by the connector itself, or is the agent's own policy. The counterparty must make the same write naming this node. |
| `POST /routes/leased` | `{ prefix, peer_id, ttl_seconds }` (`connector/crates/connector-operator/src/lib.rs:462-479`) | A **prefix**, and **which of its own peerings** leads toward it. `peer_id` is the agent's local label. No fee and no price. |
| the same write again | same | That the route is **still good**, before the lease lapses. There is no `DELETE /routes/leased` (`lib.rs:220-229`); a lease is withdrawn by not renewing it. |

`upsert_leased_route` validates the prefix and nothing else: the only error is `InvalidPrefix`
(`connector/crates/connector-runtime/src/connector.rs:69-72`, `:1519-1537`). A static or runtime
route for the same prefix beats a lease of the same length (`connector/CONTEXT.md:103-105`;
`connector.rs:3556-3574`).

To then **pay** a route more than one hop away, the buyer's side needs one more fact: the URL of
the connector that terminates it, so it can fetch the sealing key from that node (ND-13, ND-14).
The connector was meant to supply that URL in an unsealed reject (ND-15). That is not built
(`self-description-spec.md:265-266`), and its issue,
[connector#1083](https://github.com/toon-protocol/connector/issues/1083), was closed
`NOT_PLANNED` on 2026-08-28. The spec's own conclusion: "a forwarded route is reachable only by a
client that already knows the terminating node's URL out of band" (`:273-278`).

### 8.2 The facts, and who carries each today

"Self-description" is `GET /ilp`. "10432" is TOON Network's Provider Profile
(`TOON_Network/docs/spec/toon-network-v1.md`, §4.1), read as a specification, not run.

| # | Fact an agent needs | kind:10032 (announcer) | Self-description | Any other event | Verdict |
| --- | --- | --- | --- | --- | --- |
| 1 | Where a node's self-description is (its URL, onion or not) | `httpEndpoint`, a configured string | It *is* that URL | 10432 `connector_url`; the relay's NIP-11 document | **Carried**, unbound to a key |
| 2 | That a Nostr author speaks for that connector | No | No field for a Nostr pubkey | 10432 pins the sealing key one way (event names connector); nothing runs the other way | **Missing everywhere** |
| 3 | The node can be peered with at all | No | `peerCarriages` | No | Self-description only |
| 4 | Channel terms and voucher signer for a peering | Partly (`payTo`, `asset`, chain) | `batchSettlements`, `voucherSigners` | 10432 `settlement` (chain, token, decimals) | Not needed in an event: `POST /peers` reads the URL |
| 5 | Prefixes the node **terminates** | No. `ilpAddresses` is a configured name list | No. `routes` mixes terminated and forwarded | 10432 `ilp_address`, one per provider, self-asserted | **Missing as a checkable fact** |
| 6 | Prefixes the node will **carry for a peer** | No | No. `routes` lists what it prices for *clients*, and omits leases | No | **Missing everywhere** |
| 7 | Which peer a prefix is reached **through** (next hop, path, distance) | No | No, by rule (ND-09) | No | **Missing everywhere**, and the connector will not say |
| 8 | What a hop **charges** to carry (its fee) | No | No, by rule (ND-09). A fee is per peering, so it is not one number per node | No | **Missing**; learned by probing |
| 9 | A hop's **cap** | No | No, by rule (ND-10) | No | **Missing**; learned by a `T04` |
| 10 | What a terminated route **costs** | Base price only | `price` and `pricePerKib` | 30432 `price` (TOON Network listings) | Carried by the self-description; the event is lossy |
| 11 | The **terminating connector's URL** for a prefix several hops away | No. Describes its own node only | No. A node never names another node's key or URL | 10432, for a provider's own address | **Missing for a forwarded prefix**; ND-15 unbuilt |
| 12 | How long to believe it, and how it is **withdrawn** | NIP-40 expiry, ten minutes by default | None: pulled, so no TTL (ND-04) | 10433 Liveness, with expiry | Mechanism exists; no route-level withdrawal |
| 13 | That an advertised prefix does not **loop** back through the reader | No | No | No | **Missing everywhere** |
| 14 | The denomination of each hop | `supportedChains`, `assetCode` | `batchSettlements[].network`, `.asset` | 10432 `settlement` | Carried per node; nothing says it per path |

### 8.3 What no existing event carries

Read down the last column:

- **A binding between a Nostr author and a connector** (row 2). Without it, any event is "text
  from a stranger" about a node, and the agent cannot map an event to one of its own peerings.
  A peering's proven identity is its voucher signer and its URL; a gossip author is a Nostr key.
  Nothing joins them.
- **Reachability** (rows 6 and 7): "I will carry prefix P for my peers." This is the one fact
  route gossip exists to move, and it is the one fact the connector's records forbid the
  connector to publish. It can only come from the controller.
- **Termination** as a distinct, checkable statement (row 5).
- **The terminating connector's URL travelling with a prefix** (row 11). A next hop is not enough
  to pay; the buyer has to ask the far end directly.
- **Loop avoidance** (row 13). Leases expire, which bounds how long a loop lasts, and nothing
  prevents one forming.

Fees and caps (rows 8 and 9) are missing too, and the connector's answer is that they stay
missing: cost is a probe's sum and a cap is a refusal. Gossip that restated them would be a hint
(`connector/docs/adr/0046-…md:51-54`; `toon-meta/docs/route-discovery-law-research.md`, §2.10).

### 8.4 What kind:10032 could still be good for

As a signed, expiring pointer from a Nostr key to a self-description URL (row 1), and nothing
more. Even for that, the announcer as written gets the URL from an environment variable with a
dead default, and reads none of the document the URL serves.

---

## 9. Where the records disagree

- **The map's Notes say `packages/announcer` "still does" produce the announce.** True of the
  source, which builds and runs. Not true of any deployment found: no deploy file runs it, the
  connector's own code calls it retired, and the relay holds no event from it (§7.3, §7.2).
- **ADR 0046's list of readers is out of date** (`connector/docs/adr/0046-…md:56-59`, `:90-93`).
  `toon-client`'s `discovery-subscription.ts` does not exist and `rig` no longer reads the kind.
  `@toon-protocol/core`'s `parseIlpPeerInfo` is the one that remains.
- **ADR 0046 says the event "is no longer produced by this implementation"** while the same
  repository ships a package that produces it. Already noted in
  `connector/docs/research/http-native-discoverability.md:544-548`.
- **The announcer says a greeting comes back only for a terminated, priced route**
  (`edge-client.ts:121-124`). The connector answers it for any address (§4).
- **The announcer says kind 10032 is regular replaceable; the TOON relay stores it as
  addressable** (§6). Same outcome for an event with no `d` tag.
- **The ticket says the self-description "says nothing about who a node peers with".** Correct.
  It does, though, list the prefixes a node forwards for paying clients, unlabelled (§4).
- **`store` and `gas-station` still tell readers to consult "the live kind:10032 announce"** for
  settlement addresses. There is none.

---

## 10. What I could not verify

- **Whether the sidecar runs anywhere outside the connector repository's deploy files.** I searched
  the sibling checkouts for `ANNOUNCER_` and found only `toon-meta` prototype notes. A box could
  run it from a file that is in no repository. The relay holding no event from it is the stronger
  evidence.
- **Whether the local checkouts are current.** None was fetched. `toon` is at a commit from
  2026-08-28, and its kind:10032 readers may have been removed upstream since.
- **Who depends on `@toon-protocol/core`'s discovery code at run time.** I found the readers; I did
  not trace which shipped product, if any, still calls them.
- **What a leased route charges an attached client.** `client_route` ignores leases, so the client
  edge prices a leased-only prefix as free (`connector.rs:3415-3419`). Comments there refer to
  packets that would "ride for free" and to checks added against it (`:3556-3563`). I did not
  trace whether an attached client can be forwarded over a lease unpaid. This belongs to the
  forwarding ticket.
- **What happens when a lease names a `peer_id` that is not a peering.** The write accepts it; I
  did not read the forward path's handling.
- **TOON Network's events as run.** Rows citing kinds 10432, 10433 and 30432 are from the
  specification text.
- **Other relays.** Only the devnet relay was queried. Public Nostr relays were not checked for
  kind 10032.
- **The announcer's tests were not run.** One real build was (§2.3).

---

## 11. Sources

- `connector@8b938f9b`: `packages/announcer/` (all of `src/`, `README.md`, `package.json`);
  `docs/adr/0006`, `0022`, `0046`, `0058`, `0070`; `CONTEXT.md`;
  `docs/protocol/self-description-spec.md`, `operator-spec.md`;
  `crates/connector-domain/src/node.rs`; `crates/connector-client-edge/src/lib.rs`;
  `crates/connector-runtime/src/connector.rs`, `self_description.rs`;
  `crates/connector-operator/src/lib.rs`; `crates/connector-config/src/error.rs`;
  `infra/linode-relay/`; `docs/research/http-native-discoverability.md`.
- `relay@1765503`: `packages/relay/src/storage/SqliteEventStore.ts`, `nips/expiration.ts`,
  `launcher/relay.ts`; `README.md`.
- `toon@bccc7ca`: `packages/core/src/types.ts`, `constants.ts`, `events/parsers.ts`,
  `discovery/`, `bootstrap/`; `packages/sdk/src/create-node.ts`.
- `TOON_Network@d5a1963`: `docs/spec/toon-network-v1.md` §4.
- `toon-meta@bb518c1`: `docs/route-discovery-law-research.md`.
- Live, 2026-10-01: `GET https://proxy.relay.devnet.toonprotocol.dev/ilp`;
  `REQ {"kinds":[10032]}` on `wss://relay-ws.devnet.toonprotocol.dev`; `GET /ilp/identity` and
  five unpaid greeting probes against the same connector, made by the announcer's own code.
- Leads followed, then checked: `toon-client/docs/research/nostr-kinds-for-app-discovery.md`
  (untracked on `main`).
