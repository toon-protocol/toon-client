# What running a store per agent requires

Research for [toon-client#721](https://github.com/toon-protocol/toon-client/issues/721), part of the
map [toon-client#715](https://github.com/toon-protocol/toon-client/issues/715). Written 2026-10-01.

The product puts a store behind every agent's node. That choice is taken as given here. This note
establishes what it costs.

## How to read this note

Every claim carries one of four marks.

- **[S]** read in source, at the commit named below.
- **[M]** measured on one workstation on 2026-10-01 (method in §11). Nothing was uploaded: every
  measured container ran with `--network none`.
- **[W]** read from a first-party web source on 2026-10-01 (UTC), URL given.
- **[I]** inferred. Not run, not read as a statement anywhere. Treat as a lead.

"Facts" sections hold S, M and W only. "Analysis" sections are mine.

### Sources and the commits read

| Tag | What | Commit, branch |
| --- | --- | --- |
| `store/` | `toon-protocol/store`, local checkout | `1d9f018`, `main`. `origin/main` is `2de7b9a`, 9 commits ahead; they touch CI, the agent factory, `README.md`, `CLAUDE.md`, `package.json` and `deploy/auto-apply.sh`, and no file under `src/` (GitHub compare, 2026-10-01) |
| `sdk/` | `@toon-protocol/sdk` 3.3.0, the version `store/` installs; read as source in `toon-protocol/toon` `packages/sdk` | `bccc7ca`, `main` |
| `turbo-sdk/` | `@ardrive/turbo-sdk` 1.42.0 as installed in `store/node_modules` | the lockfile's resolution |
| `infra/` | `toon-protocol/infra` | `dcb4cb1` (the local `origin/main` ref; the working tree is on another branch and was not touched). Remote `main` is `839542a`, one commit ahead, which does not touch `docs/devnet.md` or `sandbox/conf/store.conf` |
| `connector/` | `toon-protocol/connector` | `8b938f9`, `main` |
| `relay/` | `toon-protocol/relay` | `1765503`, `main` |
| image | `ghcr.io/toon-protocol/store@sha256:5643…0cfec`, built 2026-09-03T17:29Z. The last commit to touch `store/src`, `Dockerfile.store` or `package.json` is `fbae37c` of 2026-09-03, so this image is current source | |

---

## 1. Short answer

A per-agent store is one more container and one more route. It starts with one environment variable,
no wallet, no funds and no network, and it answers `/health` in about 1.3 s.

Three things make it less cheap than that sentence sounds.

1. **It needs no Arweave wallet and no AR. It needs a Solana key and `$ARIO`, on Solana mainnet, and
   SOL for fees.** Unfunded, it serves only uploads up to 107,520 signed bytes, and only until a
   10 MiB lifetime free allowance runs out. That allowance is counted per wallet and per subnet and
   never resets.
2. **A refusal is not free for the payer.** The store refuses with HTTP 502. The connector fulfils
   every answer an app gives, so the payer is charged the full route price for an upload that did
   not happen. A dry store bills its customers for nothing.
3. **Its outbound calls do not ride a proxy.** There is no proxy code in the store. It dials
   `upload.ardrive.io`, `payment.ardrive.io` and a Solana RPC directly, from the node's own address.

At the price the devnet store charges, a paid upload costs the operator about four to five times
what the payer pays (§3).

---

## 2. What the store needs to run

### Facts

**Process.** One Node 22 process, two HTTP listeners: `POST /store` on 3300 (the job backend the
connector delivers to) and `GET /health` on 3400 [S `store/src/entrypoint-store.ts:17-18,648-712`,
`store/src/store-backend.ts:92-97`].

**The only required setting is `NODE_NOSTR_SECRET_KEY`**, 64 hex characters
[S `store/src/entrypoint-store.ts:506-508`]. The store uses it for one thing: the `nodePubkey` field
on `/health` [S `:647,683`]. It signs nothing with it.

**Arweave wallet: none. AR: none.** The JWK credential was removed, and a box that still sets
`STORE_ARWEAVE_JWK_B64` or `TURBO_TOKEN` is refused at boot by name
[S `store/src/entrypoint-store.ts:159-180`].

**The one upload credential is a Solana key**, `STORE_TURBO_SOLANA_KEY`, base58 of a 64-byte secret.
It signs each ANS-104 data item, so it is the public owner of every upload, and it pays for paid
uploads in `$ARIO` [S `store/src/entrypoint-store.ts:255-274`]. With no key the store generates an
ephemeral Solana key at each start [S `:276-291`].

**Bundler balance: none standing.** Payment is per upload. turbo-sdk's `OnDemandFunding` reads the
Turbo balance, buys the shortfall with an `$ARIO` transfer, and throws if the purchase would exceed
`STORE_TURBO_MAX_ARIO_PER_UPLOAD` [S `store/src/turbo-funding.ts:24-33,287-289`;
`turbo-sdk/lib/esm/common/upload.js:609-652`]. Setting that variable is what turns paid uploads on;
unset, they are off [S `store/src/turbo-funding.ts:204-216`]. Setting it without the Solana key
refuses to start [S `store/src/entrypoint-store.ts:527-532`].

**SOL is needed too, for a paid upload.** The `$ARIO` transfer names the store's key as `feePayer`
and includes an idempotent associated-token-account create
[S `turbo-sdk/lib/esm/common/token/ario.js:43-54`].

**Endpoints.** All are defaults inside turbo-sdk; the store on `main` can change only the Solana one.

| Endpoint | When | Source |
| --- | --- | --- |
| `https://upload.ardrive.io` | every upload | S `turbo-sdk/lib/esm/common/upload.js:42` |
| `https://payment.ardrive.io` | every paid upload: balance, price, fund submit | S `turbo-sdk/lib/esm/common/payment.js:23`, `upload.js:611-652` |
| `https://api.mainnet-beta.solana.com`, or `STORE_TURBO_SOLANA_GATEWAY` | every paid upload that has to buy credits | S `turbo-sdk/lib/esm/utils/common.js:51`; `store/src/turbo-funding.ts:99-131` |
| Solana RPC + websocket (`@ar.io/sdk` defaults) | `kind:5095 op=buy` only | S `store/src/arns-buy-handler.ts:122-123,210-228` |

There is no Arweave gateway or Arweave node endpoint in the store. `STORE_TURBO_UPLOAD_URL` and
`STORE_TURBO_PAYMENT_URL`, which the infra sandbox sets, exist only on an unmerged branch
(`feat/local-endpoint-overrides`); a grep of `store/src` at `1d9f018` finds neither
[S `infra/sandbox/conf/store.conf:14-20`, `infra/sandbox/docker-compose.yml:826-837`].

**Boot touches no network.** The store, started with `--network none` and no credential, reaches
`store ready` and answers `/health` [M].

**Disk: none.** No file under `store/src` writes to disk (grep for `writeFile`, `mkdir`,
`appendFile`, `sqlite`: no match outside tests). The image declares `VOLUME /data`
[S `store/Dockerfile.store:83`], and after boot and three jobs `/data` was empty and `docker diff`
showed no change [M].

**Memory.**

| Figure | Source |
| --- | --- |
| 39 MB idle, store, on the devnet host, 2026-09-25 | S `store/deploy/docker-compose.shared-edge.yml:76-80,104` |
| `mem_limit: 256m`, `--max-old-space-size=192` on devnet | S `store/deploy/docker-compose.shared-edge.yml:111-113` |
| 94 to 95 MiB idle (`docker stats`), 150 MB RSS, 20 s after start; same at a 128 MiB limit | M |
| 2 MB idle, connector; 46 MB idle, relay; same host and date | S `relay/deploy/docker-compose.shared-edge.yml:104-121` |

The devnet figure and mine disagree by more than two times. I did not find out why (§12).

**Chunked uploads are held in memory.** `ChunkManager` keeps up to 100 uploads of up to 50 MB each,
with a 5-minute timeout [S `sdk/packages/sdk/src/arweave/chunk-manager.ts:41-45`]; the store
constructs it with defaults [S `store/src/entrypoint-store.ts:581`].

**How devnet deploys it.** One host, a 961 MB Linode, runs relay, store, gas station and gateway,
each with its own connector [S `infra/docs/devnet.md:19-50`]. The store's bundle is
`store/deploy/`: connector + store, with nginx, certbot and watchtower switched off under the shared
edge [S `store/deploy/docker-compose.shared-edge.yml:19-27`]. **No proxy variable is set anywhere in
that bundle** (`socks`, `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`: no match in `store/deploy/` or in
the store service of `infra/sandbox/docker-compose.yml`).

---

## 3. Who pays Arweave, and how the price relates to the cost

### Facts

**The store's operator pays.** The payer pays the connector in the settlement token. The store pays
Turbo in `$ARIO` from its own wallet. The two are not linked: the store is "payment-oblivious" and
is told the amount only as a header it does not act on
[S `store/src/store-backend.ts:117-120,134`; `connector/CONTEXT.md:24-32`].

**The price is the connector's, not the store's.** Devnet's route is
`price = { base = 1000, per_kib = 10 }`, counted over the sealed payload's length, not the blob's
[S `store/deploy/connector.toml.template:114-117`; `connector/CONTEXT.md:441-454`]. The store's own
`FEE_PER_JOB` is "informational only" [S `store/src/entrypoint-store.ts:415-417`;
`store/deploy/README.md:381-386`]. Nothing in the store reads the price, and nothing in the
connector reads Turbo's.

**The free tier.** Turbo's upload service reports [W `https://upload.ardrive.io/`]:

```json
"freeUploadLimitBytes":107520,
"freeTier":{"lifetimeBytes":10485760,"ipBytes":10485760,"maxItemBytes":107520}
```

ar.io's docs say: "Items up to **105 KiB** are eligible for the free tier, subject to a **10 MiB**
lifetime allowance tracked per-wallet **and** per-subnet. An upload must fit under both, and the
allowance never resets." [W `ar-io/docs` `content/build/upload/turbo-credits.mdx:262` at `8367f92`,
rendered at `https://docs.ar.io/build/upload/turbo-credits`]. A wallet's remainder is public:
`GET https://payment.ardrive.io/v1/account/free?address=…` answers `{"bytesRemaining":10485760}`
for an unused address [W].

The store's source describes the free tier as a size route with no limit
[S `store/src/turbo-funding.ts:17-22`]. [store#135](https://github.com/toon-protocol/store/issues/135)
(open) already records the gap. turbo-sdk 1.42.0 as installed has no `getFreeStatus` (grep: no match).

**The ceiling is on the signed item.** The store adds 116 bytes of envelope plus the tag block before
comparing [S `store/src/turbo-funding.ts:156-182,301-302`]. A 107,520-byte blob with a
`Content-Type: text/plain` tag is ~107,665 signed bytes and is refused [M].

**Prices on 2026-10-01, about 14:00 UTC** [W].

| Reading | Value | From |
| --- | --- | --- |
| Arweave network price, 1 GiB | 13.32 AR | `https://arweave.net/price/1073741824` |
| Turbo, 1 GiB | 13,319,885,859,165 winc; fiat `usd: 90.93` | `https://payment.ardrive.io/v1/price/bytes/1073741824`, `/v1/rates` |
| Turbo, 1 `$ARIO` | 265,813,913 winc after a 25% fee | `https://payment.ardrive.io/v1/price/ario/1000000` |
| Per-item fee | 4,507,447 winc | `/v1/rates` |
| AR, `$ARIO`, SOL | $4.39, $0.00157, $117.54 | CoinGecko simple price API |

The 25% fee on `$ARIO` top-ups, against 35% on other tokens, is documented
[W `turbo-credits.mdx:249-256`].

| Blob | winc | `$ARIO` | ≈ USD | With the SDK's 1.1 buffer |
| --- | --- | --- | --- | --- |
| 107,521 bytes (smallest paid) | 1,339,419,375 | 5.04 | $0.0079 | 5.54 `$ARIO` |
| 1 MiB | 13,022,956,020 | 48.99 | $0.077 | 53.9 |
| 2 MiB | 26,019,900,713 | 97.89 | $0.154 | 107.7 |
| 50 MiB | 650,926,936,059 | 2,448.8 | $3.85 | 2,693.7 |

(`/v1/price/bytes/<n>` for each row; `$ARIO` = winc ÷ 265,813,913; USD at $0.00157.)

**Buffer.** The store leaves turbo-sdk's top-up multiplier at 1.1 and records why
[S `store/src/turbo-funding.ts:277-289`].

### Analysis

**The devnet price is below cost for every paid upload.** [I] The route charges per KiB of sealed
payload. The blob travels base64-encoded inside the event, so the payload is at least 4/3 of the
blob. A 1 MiB blob is charged at least `1000 + 10 × 1366 = 14,660` base units, $0.0147. It costs the
store $0.077. That is a loss of about five times. Break-even at today's prices is roughly
`per_kib = 56`. The store's bundle says `per_kib = 10` is "about $10.7/GB, which tracks what
permanent Arweave storage costs plus a margin" [S `store/deploy/README.md:374-376`]; the network
price alone is $58 per GiB today.

**On devnet the loss is total.** [I] The store earns mock USDC and spends real `$ARIO`: its Solana
network defaults to mainnet [S `store/src/turbo-funding.ts:89-102`], and the store's README says TOON
"has no mainnet deployment" [S `store/README.md:265`].

**Inside the free allowance the store earns.** [I] An upload under the ceiling costs nothing and the
route still charges, 1,000 to about 2,440 base units. That lasts for 10 MiB, which is about 100
full-size items.

**The example ceiling refuses everything.** [I] `deploy/.env.example` suggests
`STORE_TURBO_MAX_ARIO_PER_UPLOAD=5` [S `store/deploy/.env.example:59`]. At today's rate the smallest
paid upload wants 5.54 `$ARIO` with the buffer, so that ceiling refuses every paid upload.
store#135 records devnet choosing 120.

**The price cannot track the cost.** [I] The cost moves with two market prices (AR and `$ARIO`).
The price is a constant in the connector's config, or a runtime write by the controller. Nothing
connects them.

---

## 4. Can it run at a loss? Can it run dry?

### Facts

**At a loss: yes**, by §3. The only bound is per upload: `maxTokenAmount`
[S `store/src/turbo-funding.ts:24-33`]. There is no daily or total cap in the store.

**Dry: yes, in three ways, and all three look the same to the payer.**

| Condition | What the store does | Source |
| --- | --- | --- |
| Above the free ceiling, paid uploads off | throws before contacting Turbo; answered `502 {"accept":false,"code":"T00","message":"Arweave upload failed"}` in 9 to 54 ms | S `store/src/turbo-funding.ts:310-316`; `sdk/…/arweave-dvm-handler.ts:146-166`; `store/src/store-backend.ts:198-206`; M |
| Wallet short of `$ARIO` or SOL, or price above the ceiling | turbo-sdk throws; same `502 T00` | S `turbo-sdk/…/upload.js:644-652`; same handler path. Not run |
| Free allowance spent, paid uploads off | Turbo refuses the upload; same `502 T00` | W the docs line above; same handler path. Not run |

The reason is written to the store's log only. The payer gets the generic message
[S `sdk/…/arweave-dvm-handler.ts:147-165`; M: the log line names the cause, the HTTP body does not].

**The payer is charged for each of them.** "Value moves whenever the app answered, whatever it
answered. An HTTP status is envelope content, never a packet outcome"
[S `connector/docs/adr/0020-a-price-is-flat-and-attaches-to-a-handler.md:82-84`]. The connector's
test `a_non_2xx_response_from_the_app_still_fulfils` holds it
[S `connector/crates/connector-runtime/src/connector.rs:4251`]. The store's own header comment says
the same: "it FULFILLs even on 5xx" [S `store/src/store-backend.ts:13-14`].
[store#132](https://github.com/toon-protocol/store/issues/132) (open) reports it from a mainnet
node: a refused 1 MiB part, payer charged 41,980 units.

**A payer cannot learn the store's limits before paying.** `/health` states `freeTierMaxBytes`,
`paidUploads` and `maxArioPerUpload` [S `store/src/entrypoint-store.ts:691-704`], but it is on port
3400, which is not behind the paid route. It states no remaining free allowance and no wallet
balance.

---

## 5. Can it start with no Arweave funds and refuse cleanly?

### Facts

**It starts.** With only `NODE_NOSTR_SECRET_KEY` and no network, `/health` answers about 1.3 s after
the container is created, with `"turbo":{"source":"ephemeral-free-tier",…,"paidUploads":"off"}` [M].

**It is not a store that refuses everything.** With no credential it still accepts items up to
107,520 signed bytes and sends them to Turbo under the ephemeral key
[S `store/src/entrypoint-store.ts:276-291`, `store/src/turbo-funding.ts:302-308`].

**Its refusals are fast and well-formed, and cost the payer** (§4).

**With no network at all, a small upload hangs for 56 s** before answering `502 T00`, while
turbo-sdk retries [M: "Failed to upload file after 6 attempts / fetch failed"]. A terminating
connector abandons an app that has not answered by the packet's expiry and refuses `R00`
[S `connector/docs/adr/0064-a-deadline-bounds-the-wait-for-an-app-not-the-answer.md:7-9`].

### Analysis

**"A node is still a node": yes.** [I] The connector does not depend on the store. A store that is
absent, stopped or unreachable makes its route answer with a reject, which is unpaid ("Only the
absence of an answer rejects — unreachable, timed out, undecodable, no route", ADR 0020 `:84`).
Nothing else on the node reads the store.

**The clean way to have no store is to have no route.** [I] A running store that refuses is the
worst of the three states for a payer: an absent route rejects unpaid, a working store delivers, a
dry store charges and delivers nothing. A node whose store cannot serve should not advertise the
route. Nothing does that today; the route is static config or an operator write.

**The ephemeral key and the allowance.** [I] The per-wallet allowance follows the key, and the
ephemeral key changes at each restart. The per-subnet allowance does not. Whether a restart buys a
fresh 10 MiB therefore depends on the subnet counter, which I did not test.

---

## 6. Can its outbound calls ride a SOCKS5h proxy?

### Facts

**Not as built.** There is no proxy option and no proxy code in `store/src` (grep for `proxy`,
`socks`, `agent`: only the phrase "payment proxy").

**Every outbound call is Node's global `fetch`.** turbo-sdk: `fetch(this.baseURL + endpoint, …)`
[S `turbo-sdk/lib/esm/common/http.js:40,63`]. `@solana/web3.js` 1.98.4 uses `globalThis.fetch` when
it exists and passes it an `agent` option
[S `…/@solana/web3.js/lib/index.esm.js:4245-4251,4970-5030`]. turbo-sdk constructs its `Connection`
with no custom fetch [S `turbo-sdk/lib/esm/common/token/ario.js:33`].

**The connector's proxy does not cover it.** "The proxy covers the ILP wire only. Settlement RPC and
`handler_url` dial direct" [S `connector/docs/adr/0070-an-onion-address-is-a-host-not-a-carriage.md:109`].
ADR 0073 later let settlement RPC ride the proxy; `handler_url` still dials direct [S `0070:117-121`].
Neither concerns what the app itself dials.

**Node's own proxy switch speaks HTTP proxies.** `NODE_USE_ENV_PROXY=1`, added in v22.21.0,
stability 1.1: "Node.js parses the `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` environment variables
during startup, and tunnels requests over the specified proxy"
[W `nodejs/node` `v22.x` `doc/api/cli.md:3654-3667`]. The store image runs Node v22.23.2 [M].
SOCKS is not mentioned.

**So today a store reveals the node's address** to `upload.ardrive.io` on every upload, and to
`payment.ardrive.io` and a Solana RPC on every paid one. Not to an Arweave gateway: it never talks
to one.

### Analysis

**Three ways to close it, none tried.** [I]

1. A code change in the store: install a SOCKS dispatcher for global `fetch` at start. This client
   already does that for its hidden-service transport with `undici` + `socks`
   (`packages/client`, see `CLAUDE.md` § Dependencies). It is the only option that is `socks5h` by
   construction. It would not cover the websocket `kind:5095 op=buy` opens.
2. No code change: `NODE_USE_ENV_PROXY=1` with `HTTPS_PROXY` naming an HTTP CONNECT port on the
   node's anonymity daemon. A CONNECT carries the hostname, so the proxy resolves it. Whether
   `anon` offers such a port, and whether Node 22's switch covers `fetch`, are unverified.
3. No code change: give the store container no route but a transparent proxy. The infra sandbox has
   a "SOCKS + transparent-proxy egress" arrangement for the hidden provider
   [S `infra/sandbox/docker-compose.yml:1860`], which I did not read further.

**A proxy weakens the free tier.** [I] The allowance is also counted per subnet. Behind an exit, the
subnet is the exit's, shared with every other user of it.

**The upload key is a second identifier.** [S+I] The store's Solana key signs every data item, so it
is the public owner of everything the store uploads for anyone
[S `store/src/entrypoint-store.ts:255-260`]. A paid upload also leaves a Solana mainnet transfer
from that key. Hiding the address does not unlink a node's uploads from each other.

---

## 7. What it stores locally, and what is retrievable through it

### Facts

**Nothing persistent.** No disk writes (§2). In memory: the chunks of uploads in progress, and a
five-minute window of job counters [S `store/src/entrypoint-store.ts:103-150,581`]. A restart loses
both.

**Nothing is retrievable through it.** The backend has two routes, `GET /health` and `POST /store`
[S `store/src/store-backend.ts:95-97`]; any other path is 404 [M]. The answer to a job is the
identifier and nothing else [S `store/src/store-backend.ts:184-195`].

**Reading is somebody else's service.** Turbo names `https://turbo-gateway.com` as its gateway
[W `https://upload.ardrive.io/`]. The rig's README says fresh objects "can take **10–20 minutes** to
become fetchable from Arweave gateways" [S `rig/packages/rig/README.md:163-166`];
[store#125](https://github.com/toon-protocol/store/issues/125) (open) notes the store's README does
not say so.

**The store keeps no record of what it uploaded.** A successful job is one log line
[S `store/src/store-backend.ts:179-183`].

---

## 8. Image size and start-up cost beside the connector and relay

### Facts

| | store | relay | connector |
| --- | --- | --- | --- |
| Tag | `:release` (`bee839c…`) | `:release` (`5b7aac4…`) | `:rust-2026.09.29.1` (`eb8e241…`) |
| Compressed layers (registry manifest) [W/M] | 101.6 MB | 53.7 MB | 15.6 MB |
| Platforms in the manifest [W/M] | linux/amd64 only | linux/amd64 only | linux/amd64 only |
| On disk, `docker images` [M] | 579 MB (the 2026-09-03 image) | not pulled | 55 MB |
| Idle memory on the devnet host [S] | 39 MB | 46 MB | 2 MB |
| Devnet `mem_limit` [S] | 256m | 192m | 64m |

Inside the store image: `node_modules` 292.8 MB, the Node binary 123.3 MB, the store's own bundle
28 KB [M]. The dependencies are left external on purpose
[S `store/esbuild.config.mjs:4-14`, `store/Dockerfile.store:15-23`]. They include `@ar.io/sdk`,
`@ardrive/turbo-sdk`, `@solana/kit` and `arweave` [S `store/package.json:20-30`], and turbo-sdk
brings `ethers`, `@cosmjs/*` and `@solana/web3.js` [S `turbo-sdk/package.json` dependencies].

**Start-up:** `/health` answers 1.25 to 1.35 s after the container exists, in three runs, including
under a 128 MiB limit [M]. No migration, no key generation on disk, no network call.

### Analysis

[I] The store is the largest image of the three by a wide margin, about two thirds of the node's
download, and nearly all of it is other chains' SDKs that the `kind:5094` path does not use. In
memory it is level with the relay. It is the quickest of the three to be ready, because it has no
chain to read at boot: the connector's Solana backend transacts at boot
[S `infra/docs/devnet.md:132-144`].

All three images are amd64 only. That is a property of the whole node, not of the store, and it
bears on "one install" for an agent on an ARM machine.

---

## 9. What a store adds for an agent that sells a service and never sells storage

### Facts

- The connector needs no store. A route is one `[[routes]]` row naming a `handler_url`
  [S `store/deploy/connector.toml.template:114-117`]; a node's own service is another such row.
- The store's backend is unauthenticated plain HTTP. Whoever can reach port 3300 can upload without
  paying; the bundle keeps it off every published port for that reason
  [S `store/deploy/docker-compose.yml:62-66,96`; `store/README.md:139-171`].
- This client has no `kind:5094` builder and no upload command. The only matches for `5094` in
  `packages/client/src` are comments in `jobs/send-job.ts:88,169` and its test [S, this repository at
  `0a6019a`].
- The store also answers `kind:5095`: `op=prepare` composes an unsigned ArNS transaction and needs
  no key; `op=buy` needs a second funded Solana key [S `store/src/entrypoint-store.ts:449-494`].

### Analysis

[I] For such an agent the store adds:

- **Cost:** 100 MB of download, about 95 to 150 MB of memory, one more process to keep alive, one to
  three more secrets, and a clearnet egress the rest of the node does not have.
- **One capability for itself:** permanent public bytes. As the node's operator it can post a signed
  event to its own store on the loopback and pay nothing to a connector. For that use the store is a
  thin wrapper over turbo-sdk, and the first 10 MiB are free.
- **One thing to sell:** a storage route, which runs at a loss at the devnet price once the free
  allowance is gone, and which bills payers for refusals.
- **A liability if left on by default:** an advertised storage route on a node that never funded it
  will, after 10 MiB, charge every payer for a `502`.

It adds nothing to discovery or to payment. Whether a service listing or an artifact needs a
permanent address is a question for the listing ticket, not answered here.

---

## 10. The smallest per-agent store

### Facts, assembled

One container from `ghcr.io/toon-protocol/store`, with:

- `NODE_NOSTR_SECRET_KEY` set to 32 random bytes in hex. Nothing else.
- No volume, no published port.
- One row in the node's connector: a prefix, `handler_url = "http://<store>:3300/store"`, and a
  price. The `/store` suffix is required; a bare origin answers 404
  [S `store/deploy/connector.toml.template:89-93`].
- Outbound HTTPS to `upload.ardrive.io`.

That serves `kind:5094` items up to 107,520 signed bytes, about 107,375 bytes of blob with a short
content type, until 10 MiB have gone through that key or that subnet. It starts in about 1.3 s and
sits at about 95 MiB.

### What a user would have to fund or configure beyond the node itself

For the free tier: **nothing.** No funds, no account, no wallet.

To serve anything larger, or anything at all after the first 10 MiB:

| What | Detail |
| --- | --- |
| A Solana keypair | `STORE_TURBO_SOLANA_KEY`, base58 of the 64-byte secret. A persistent secret to back up; it owns every upload |
| `$ARIO` on **Solana mainnet**, in that key's token account | About 49 `$ARIO` ($0.077) per MiB on 2026-10-01. It moves with AR and `$ARIO` |
| SOL on mainnet, in the same key | Transaction fees for each top-up. Amount per top-up not measured |
| `STORE_TURBO_MAX_ARIO_PER_UPLOAD` | The per-upload bound. It must exceed the largest upload's cost times 1.1, or that upload is refused and the payer charged. About 110 for a 2 MiB item today |
| A route price that covers the cost | `per_kib` near 56 at today's prices, against devnet's 10 |
| Optionally a Solana RPC | `STORE_TURBO_SOLANA_GATEWAY`; the default is the public mainnet endpoint |
| A proxy arrangement | Not available as configuration today (§6) |

The node's settlement side is funded in one token on one chain. A store that sells paid uploads is
funded in a different token, on Solana mainnet, in real money, whatever network the node settles on.

---

## 11. How the measurements were made

All on one x86-64 Linux workstation, 2026-10-01, Docker, image
`ghcr.io/toon-protocol/store@sha256:5643…0cfec`.

- **Start and memory.** `docker run -d --network none -e NODE_NOSTR_SECRET_KEY=<random>`, then
  `docker exec … wget http://127.0.0.1:3400/health` every 50 ms until it answered; `docker stats` and
  `/proc/1/status` 20 s later. Three runs: no limit; `--memory 256m` with
  `--max-old-space-size=192`; `--memory 128m` with `--max-old-space-size=96`. Container creation took
  1.5 to 2.8 s; health followed 1.25 to 1.35 s later.
- **Refusals.** A script inside the same network-less container signed `kind:5094` events with
  `nostr-tools` and posted `{ "event": … }` to `http://127.0.0.1:3300/store`: 200,000 bytes,
  107,520 bytes, 1,000 bytes, then a plain-text body and a `GET` to another path. Results: 502 in
  54 ms, 502 in 9 ms, 502 in 56,130 ms, 422, 404.
- **Sizes.** `docker manifest inspect -v` for the three tags, layer sizes summed; `docker images`;
  `du` inside the store image.
- **Nothing was uploaded.** A free-tier upload goes to Arweave mainnet and is permanent, so the
  success path was not run.

---

## 12. What I could not verify

- **The success path, free or paid.** Not run. That a free-tier upload succeeds under an ephemeral
  key rests on the store's own comment (verified on mainnet 2026-08-29) and store#132's report.
- **What Turbo answers when the free allowance is spent**, and what "per subnet" means in prefix
  length. The docs give the rule, not the mechanism.
- **Whether a restart's new ephemeral key gets a fresh allowance** in practice.
- **Why devnet reports 39 MB idle and I measured about 95 MiB.**
- **How much SOL a top-up costs**, and whether the destination token account already exists.
- **How long a paid upload takes.** The transfer is confirmed at `finalized` and then polled for up
  to two minutes [S `turbo-sdk/…/token/ario.js:87-91`, `upload.js:654-684`]. If that outlasts the
  packet's expiry, the connector refuses `R00`, the payer is not charged, and the store has already
  bought credits. I did not measure it.
- **Whether `NODE_USE_ENV_PROXY` covers global `fetch` in Node 22**, whether the `anon` daemon offers
  an HTTP CONNECT port, and the sandbox's transparent-proxy arrangement.
- **How the devnet store is configured today.** Its `.env` is on the host. store#135 says paid
  uploads were being turned on with about $5 of `$ARIO` and a ceiling of 120.
- **The exact payload expansion** from blob to sealed payload. I used the 4/3 of one base64 pass as
  a lower bound.
- **`STORE_TURBO_SOLANA_NETWORK=devnet`.** Whether Turbo credits devnet `$ARIO` against real uploads
  was not checked.
- **A chunked upload against the memory limit.** `Buffer`s are outside the V8 heap the limit flags
  cap; 100 uploads of 50 MB against `mem_limit: 256m` was not tried.
