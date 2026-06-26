---
name: toon-client
description: Act as a TOON Protocol client from a Claude agent (Desktop or Code)
  via the toon-* MCP tools backed by the toon-clientd daemon. Covers pay-to-write
  publishing ("how do I publish to TOON?", "how do I post a note on TOON?",
  toon_publish, toon_publish_unsigned, paid write, payment-channel claim, balance
  proof, ILP/BTP), free reads ("how do I read from TOON?", "how do I subscribe to
  a TOON relay?", toon_subscribe, toon_read, toon_query, NIP-01 filter, event
  buffer, cursor), media ("how do I attach an image?", "how do I post a picture
  on TOON?", toon_upload, toon_upload_media, Arweave, NIP-94), rendering an
  in-host agent UI ("how do I render a feed on TOON?", "show me a TOON profile as
  a UI", toon_render, toon_atoms, ViewSpec, ui://toon/app), the open-world render
  trust gradient ("what is kind:31036?", "render trust gradient", "open-world
  UI", "how does the client render an unknown kind?"), channel and balance
  management ("how do I open a payment channel?", "how do I check my channel
  nonce/balance?", toon_open_channel, toon_channels, nonce watermark), swaps
  ("how do I swap tokens on TOON?", toon_swap, multi-chain swap), paid HTTP
  ("toon_http_fetch_paid", x402/402 pay-and-retry), faucet/funding
  ("toon_fund_wallet", drip devnet funds), target management ("toon_targets",
  toon_add_relay/toon_remove_relay, toon_add_apex/toon_remove_apex, many relays
  to read, many apexes to write), client status/identity ("am I connected to
  TOON?", "what is my TOON address?", toon_status, toon_identity, bootstrapping),
  and threshold/off-chain settlement semantics ("how does paying per write work
  on TOON?", "why is reading free?"). Use whenever the user wants to publish,
  read, pay, render, swap, or manage targets on the TOON network through the
  toon-* tools.
---

# TOON Client (agent surface)

This skill lets a Claude agent act as a **TOON Protocol client** through the
`toon-*` MCP tools. TOON is **pay-to-write Nostr over Interledger (ILP)**: a
write is an ILP packet carrying a TOON-encoded Nostr event plus a signed
off-chain payment-channel claim; reads are free. The tools are backed by an
always-on local daemon (`toon-clientd`) that owns the BTP session, payment
channels, signer keys, and persistent relay subscriptions — the agent never
sees private keys.

Composes with `nostr-protocol-core` (event structure/kinds), `public-chat` and
`relay-discovery` (what to publish/where), `nip-on-toon-discovery` (the
render-trust-gradient spec these tools implement), and the RFC skills
(`rfc-0001`, `rfc-0027`, `rfc-0023`) for ILP/BTP internals.

## Mental model: pay-to-write, free-read

- **Write = pay.** Every publish signs a payment-channel **claim** (an EIP-712 /
  chain-specific balance proof) for a small fee and sends it with the event over
  BTP to the apex/connector. The apex validates the claim, takes its fee, and
  forwards the event to the town relay, which returns FULFILL (accepted) or
  REJECT. Cost scales with encoded byte size — **be concise**.
- **Read = free.** `toon_subscribe` opens a persistent NIP-01 subscription;
  `toon_read` drains buffered events; `toon_query` does a one-shot bounded read.
  No payment, no claim.
- **Settlement is off-chain + threshold.** Each paid write advances a monotonic
  **nonce** and a cumulative amount on the channel; the connector settles
  on-chain only when a threshold is crossed. The nonce watermark is persisted by
  the daemon and **must never go backwards** (a regressed nonce invalidates the
  proof) — this is why a single daemon instance owns the channel.
- **1-to-many targets.** The client writes through many **apexes** (BTP write
  targets) and reads from many **relays** (read sources). `toon_targets` lists
  both; `toon_add_apex` / `toon_add_relay` register more at runtime.

The full set of paid (SPENDY) tools is `toon_publish`, `toon_publish_unsigned`,
`toon_upload_media`, `toon_swap`, and `toon_http_fetch_paid` (only when the
remote returns 402). Everything else — reads, status, targets, channel listing,
rendering, and the devnet faucet — is free.

## First call: check status

Always start with `toon_status`. The daemon's first bootstrap pays a one-time
anon-proxy + BTP warm-up (~30–90s). While it comes up, write tools return a
"still bootstrapping — retry shortly" message. `toon_status` reports:

- `bootstrapping` / `ready` — whether paid writes can go through yet,
- `identity` — your Nostr pubkey + EVM/Solana/Mina addresses,
- `relay` — connection + buffered-event count + active subscriptions,
- `network` — per-chain settlement readiness.

`toon_identity` returns just the public addresses (e.g. to fund a testnet wallet
or share an npub). It never returns private keys. On devnet, `toon_fund_wallet`
drips test funds (ETH/SOL/MINA + USDC) to your own address so you can open a
channel and pay for writes — the usual "fund me first" step before publishing.

## Rendering is the default surface

**The generative UI is the product; a text dump is the fallback, not the
default.** When the user asks to **see / show / open / browse / view / display**
events, a profile, a feed, a thread, channels, balances, or a swap → **render it
with `toon_atoms` → `toon_render`.** Do **not** reply with a text list of events,
and do **not** deliberate between "render or describe in text" — for any display
request, **rendering wins.** Examples that mean "render it": "show me kind:1
events", "open toon", "I want a feed", "show my profile", "let me browse the
channel", "view my balances". Render first; don't merely offer to.

Rules of the road:

- **Always call `toon_atoms` first** to get the real atom vocabulary (ids,
  kinds, props, write actions) before composing a ViewSpec. Never guess or
  brute-force atom ids or kinds — bind to what the catalog actually exposes.
- **Then call `toon_render`** with a ViewSpec built from catalog atoms. The host
  paints it inline as `ui://toon/app`. Composing and rendering are **free**.
- **Fall back to text only** when the user *explicitly* asks for raw text/JSON,
  or when rendering is unavailable/failed in the host — and when you fall back,
  **say so** ("the host can't render here, so here's the text").
- After rendering, a **one-line caption** is fine ("Here's your kind:1 feed"),
  but the **rendered view is the primary response** — not a re-listing of its
  contents in prose.

See **Rendering & the agent UI** below for the ViewSpec grammar and atom
catalog. This policy governs *display* requests; pure write requests ("publish a
note") and one-shot lookups the user explicitly wants as text are unaffected.

## Publishing (paid)

There are two write paths:

- `toon_publish({ event, destination?, fee?, btpUrl? })` — when you already hold
  a **fully-signed** Nostr event (id + sig + pubkey + kind + created_at + tags +
  content). Build/sign it using the Nostr event rules from `nostr-protocol-core`.
- `toon_publish_unsigned({ kind, content?, tags?, destination?, fee?, btpUrl? })`
  — when you do **not** hold a key: supply only the event shell and the daemon
  signs it with the held Nostr key. For replaceable kinds (0 profile, 3 follow
  list) the daemon merges the latest known tags first. This is the path the
  in-host UI atoms use (likes, follows, posts) so the iframe never signs.

`destination` defaults to the configured apex; `btpUrl` selects which registered
apex to publish through (writes always go through BTP, never a relay directly);
`fee` overrides the per-write fee (base units).

Returns `{ eventId, channelId, nonce, data? }`. `nonce` advances by one per
successful publish. `data` carries FULFILL response bytes (e.g. an Arweave tx id
from a DVM job). A rejected write surfaces the relay/connector error (e.g. F06 =
parent/child mis-tagging) — report it; do not silently retry a rejected claim.

If the tool says it is bootstrapping, wait a few seconds and call `toon_status`
before retrying.

## Media (paid)

`toon_upload_media({ dataBase64, mime?, kind?, caption?, tags?, fee?, btpUrl? })`
is the two-step, SPENDY path for attaching an image or video. It uploads the
base64 bytes to **Arweave** via the kind:5094 blob-storage DVM (the store DVM),
then signs and publishes a media event referencing the resulting Arweave URL.
Default kind is 1063 (NIP-94); use 20 for a picture, 21/22 for video, or 1 for a
note with a NIP-92 `imeta` tag. Single-packet only (one upload per call). Returns
the published media event (with its eventId, nonce, and the Arweave URL).

## Reading (free)

Persistent / long-poll:

1. `toon_subscribe({ filters, subId?, relayUrl? })` — `filters` is a NIP-01
   filter object or array (e.g. `{ "kinds": [1], "authors": ["<hex>"] }`,
   `{ "#e": ["<id>"] }`). Omit `relayUrl` to FAN OUT across every registered
   relay; supply it to restrict to one. Returns `{ subId }`.
2. `toon_read({ subId?, cursor?, limit?, relayUrl? })` — drains events newer than
   `cursor`. Pass the returned `cursor` back on the next call to get only new
   events (long-poll style). Without `subId`, drains across all subscriptions.

One-shot:

- `toon_query({ filter, timeoutMs? })` — resolve a single NIP-01 filter to its
  matching events (subscribes, waits briefly, returns matches). This is the
  structured read used to fill in a rendered view's data binds; prefer it over
  subscribe/read when you just need "the current matches" once.

The daemon de-duplicates by `event.id` and auto-reconnects relay sockets, so a
subscription survives transient drops. Events are buffered (bounded ring); read
promptly if you expect high volume.

## Rendering & the agent UI

TOON ships an in-host **generative UI**: the agent composes a **ViewSpec** (a
tree of atoms with data binds and write actions) and the host renders it inline
as `ui://toon/app`. This is the **default response to any display request** —
see **Rendering is the default surface** above for when to render (always, for
see/show/open/view/browse) versus fall back to text (only on explicit text
requests or render failure).

1. `toon_atoms()` — list the atom vocabulary (ids, the kinds each atom renders,
   its props, and which write tools it can fire) plus ready-made example
   ViewSpecs. **Always call this first** to learn the grammar — never guess atom
   ids or kinds.
2. Compose a `ViewSpec` — `{ title?, root: ViewNode }`, where a `ViewNode` is
   `{ atom, props?, children?, bind?, actions? }`. `bind` carries a NIP-01
   `query` (filled via `toon_query`) and an optional `kindAuto` flag (route each
   bound event through its default atom); `actions` wire a named event to a write
   tool, e.g. `{ post: { tool: "toon_publish_unsigned", args: { kind: 1 } } }`.
3. `toon_render({ spec })` — the ViewSpec is validated against the atom +
   write-tool allowlist, then the host renders the app with it. The tool is
   tagged with `_meta.ui.resourceUri = ui://toon/app` so the host loads the app
   bundle.

**The atom vocabulary** (from `toon_atoms`):

- *layout* — `stack`, `section`, `card`, `tabs`.
- *social* — `profile-header` (kind:0), `note-card` (kind:1),
  `reaction-bar` (kind:7), `follow-button` (publishes kind:3), `composer`
  (publishes kind:1), `pay-confirm` (compose → confirm live fee + chain →
  publish → receipt; "the message is the money").
- *media* — `media-embed` (kinds 20/21/22/1063 streamed from Arweave),
  `media-uploader` (SPENDY — upload + publish).
- *forge (NIP-34)* — `repo-card` (30617), `issue-card` (1621),
  `pr-card` (1617), `comment-thread` (1622).
- *defi* — `channel-card` (lists channels, optional pre-open), `swap-form`
  (SPENDY cross-asset swap), `settlement-receipt`.
- *onboard* — `onboard-card` (claim identity + open channel + publish profile).
- *fallback* — `generic-event` (decoded JSON + tags for any kind without a
  bespoke atom).

Renders are **free** to compose and display; the writes the atoms fire (post,
follow, react, upload, swap) are paid exactly like a direct publish — atoms
marked SPENDY (`media-uploader`, `swap-form`) cost real value when their action
runs, and the `pay-confirm` atom is the canonical "show the fee before you
spend" surface.

## Open-world UI: the render trust gradient

TOON treats a Nostr **kind as an open component-catalog key**, so "I've never
seen this kind" is a first-class branch, not an error. The client forks on one
question — *do I know this kind?* — and that answer selects both the render
strategy and the trust level (see the `nip-on-toon-discovery` spec):

| Branch | Condition | Strategy | Trust |
|---|---|---|---|
| 1 | known kind | native component (audited atom) | **full** |
| 2 | unknown + A2UI declarative spec | client's A2UI "Basic" catalog (data, not code) | **medium** |
| 3 | unknown + provider raw widget | sandboxed mcp-ui iframe (arbitrary HTML, consent-gated) | **low** |
| 4 | unknown + no renderer | model-generated fallback renderer | **low** |

Trust runs **opposite** to flexibility: native is safest and least expressive;
the sandboxed iframe is most expressive and least safe.

How an unknown kind resolves a renderer:

- A rendered event can carry a `ui` tag pointing at an addressable
  **`kind:31036`** renderer event whose `d` tag = the target kind and whose
  **author is the event author** (no third-party renderers). The bare `ui` tag
  form `["ui","42"]` anchors to the event author; a full
  `31036:<pubkey>:<kind>` coordinate is accepted only if its pubkey equals the
  event author.
- The client fetches candidate `kind:31036` events (`toon_query` with
  `kinds:[31036]`, `authors:[author]`, `#d:[kind]`), picks the latest
  addressable one, and **re-verifies its signature** before trusting it.
- The renderer's **`m` (mimeType) tag is the branch selector**:
  `application/a2ui+json` → branch 2 (A2UI), `text/html;profile=mcp-app` →
  branch 3 (sandboxed mcp-ui). No usable renderer → branch 4 (generative).
- A **swap-defense** guard runs first and **fails closed**: a wrong-author, bad
  signature, trust-downgrading swap, or a high-trust id change drops to the safe
  branch (native for a known kind; generative for an unknown one). Known kinds
  always short-circuit to branch 1 — no renderer fetch on the hot feed path.

**Consent invariant.** A sandboxed (branch 3/4) widget may only *request* an
action via an intent; the authorization/confirm surface is rendered by the
trusted client **outside** the iframe and is never themeable by the widget.

A client can also **publish a `kind:31036` renderer** (addressable, `d` = target
kind, author = the event author) — including publishing back a generative
branch-4 renderer so the next client has a "known" renderer. The render layer
accretes permissionlessly, the same way the kind vocabulary does.

## Channels & balances

- `toon_open_channel({ destination? })` — pre-open (or fetch) the payment channel
  for a peer. Channels open lazily on the first publish; pre-open only when you
  need the `channelId` first.
- `toon_channels()` — list tracked channels with `nonce` (watermark) and
  cumulative transferred amount. Use this to confirm a publish advanced the
  nonce or to inspect spend.

## Swaps (multi-chain)

`toon_swap({ destination, amount, swapPubkey, pair, chainRecipient, packetCount? })`
pays a swap peer `amount` of asset A and receives asset B plus a signed
target-chain claim. It builds the NIP-59 gift-wrapped kind:20032 swap rumor;
`pair` is the swap pair (from kind:10032 discovery), `chainRecipient` is your
payout address on `pair.to.chain`, and the swap peer must be routed via the apex's
child peers. Returns the decrypted target-chain claim(s) + settlement metadata.

## Paid HTTP (x402)

`toon_http_fetch_paid({ url, method?, headers?, body?, timeout? })` fetches a
paid HTTP resource: it issues the request, and if the server returns **402
Payment Required**, transparently pays over TOON against the open apex channel
and retries, returning the settled `{ status, headers, body }`. The caller never
holds chain keys; settlement happens inside the daemon.

## Targets (relays & apexes)

The client is 1-to-many. `toon_targets()` lists every relay (read source, with
connection + buffered-event status) and every apex (BTP write target, with
ready/channel status). Manage them at runtime (changes persist across restarts):

- `toon_add_relay({ relayUrl })` / `toon_remove_relay({ relayUrl })` — add/remove
  a read source. A new relay joins all fan-out reads immediately. The
  config-seeded default relay cannot be removed.
- `toon_add_apex({ ilpAddress, relayUrl, pubkey?, chain?, childPeers?, feePerEvent? })`
  — add a write target. Settlement params are **discovered** by reading the
  apex's kind:10032 announcement off the given relay — you do not supply
  chain/settlement details. `toon_remove_apex({ btpUrl })` removes one (not the
  config-seeded default).

## Failure & retry guidance

- **bootstrapping** → not an error; wait and retry after `toon_status` shows
  `ready: true`.
- **daemon not reachable** → the daemon failed to start; tell the user to check
  `~/.toon-client/daemon.log` and that their config (mnemonic/keystore + btpUrl)
  is set.
- **504 (apex discovery timeout)** → retry once the relay is reachable and the
  apex is online (common with `toon_add_apex`).
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
  loop the write tools on failures without surfacing why. Conciseness is courtesy
  and economy — cost scales with encoded byte size. The same applies to
  rendered-UI actions and SPENDY atoms: a `media-uploader` or `swap-form` action
  spends just like a direct publish.
- **Reads are free, so read before you pay.** This is a *payment-economics* rule,
  not a "describe it in text" rule: use `toon_query` / `toon_subscribe` /
  `toon_read` to check whether something already exists before paying to publish
  it again. When a read backs a display request, its results **fill a rendered
  view's data binds** (`toon_render`) — they are not a substitute for rendering.
- **The daemon holds the user's keys; the agent does not.** Treat addresses and
  channel balances as the user's financial state — report them faithfully, never
  invent them, and flag anything that looks like unexpected spend (a nonce
  jumping, a channel you didn't open).
- **A rejected write is the operator's network telling you something.** Surface
  the connector/relay `code` + `message` verbatim (e.g. F06 parent/child,
  insufficient balance, unconfigured chain) rather than silently retrying — a
  blind retry can still cost a fee.
- **Untrusted renderers are sandboxed for a reason.** When the render gradient
  drops to branch 3/4, the widget is untrusted code; never let it paint the
  authorization surface for a paid action — the trusted host renders that,
  outside the iframe.
