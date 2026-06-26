# @toon-protocol/client-mcp

## 0.8.2

### Patch Changes

- 3719af8: Republish client-mcp so it re-bakes the current `@toon-protocol/views` MCP-app
  bundle into `dist/app/index.html`. views is a bundled **devDependency** (its
  prebuilt `app/index.html` is copied in at build time via tsup `onSuccess`), so
  a views-only release — like the jade/Geist-Mono theme refresh in views@0.8.1
  (#159) — never propagates to the published client-mcp. The last published
  client-mcp (0.8.0) therefore still serves the pre-theme bundle, so Claude
  Desktop shows the old UI even though views@0.8.1 is on npm. This forces a fresh
  client-mcp release that picks up the new bundle.

  To stop this from recurring, `views` and `client-mcp` are now a `fixed` group
  in `.changeset/config.json`, so any `views` release co-releases `client-mcp`
  and re-bakes the bundle. (`updateInternalDependencies` cannot do this — it only
  propagates through `dependencies`/`peerDependencies`, and `views` is a
  `devDependency` here by design so it stays out of the published runtime deps.)

## 0.8.0

### Minor Changes

- 83eb81b: Rename legacy vocabulary: the swap-peer node concept is now consistently called "swap" across all packages (part of #134).

  `SwapRequest.millPubkey` → `swapPubkey`, `SwapClaim.millSignerAddress` → `swapSignerAddress`, `TOON_MILL_PUBKEY` env var → `TOON_SWAP_PUBKEY`, ILP address segments updated (e.g. `g.townhouse.swap`), and all prose/doc references updated.

### Patch Changes

- 0bca511: Purge legacy `townhouse` vocabulary: replace `g.townhouse.town` default destination with `g.proxy`, update `g.townhouse.mill`/`g.townhouse.dvm` example addresses to `g.proxy.mill`/`g.proxy.dvm`, and remove all remaining `townhouse` references from source, docs, and tests.
- 9a917f5: Rename non-NIP-90 `dvm` vocabulary to `store` across the repo (issue #139).
- 6c18a4b: Surface the real media-upload error instead of a generic "Upload failed." The
  `media-uploader` atom now renders the underlying error string from the action
  outcome (degrading to a generic message only when none is present), and the
  daemon's `uploadMedia` labels which of the two legs failed — the Arweave blob
  upload (`store` destination) vs. the post-upload kind:20/1063 reference-event
  publish (`relay` destination) — so the failing leg is diagnosable from the UI
  without a behavioral change to the upload itself (#148).

## 0.7.1

### Patch Changes

- 26537fd: Make the daemon faucet request timeout chain-aware. The Mina faucet settles much
  slower than EVM/Solana and routinely takes longer than the flat 30s HTTP budget
  to respond even though the drip succeeds server-side, so `toon_fund_wallet({chain:"mina"})`
  reported `Faucet request timed out after 30000ms` on a request that actually
  funded the wallet. `fundWallet` now defaults to 30s for evm/solana and 120s for
  mina (`defaultFaucetTimeout`), and the daemon accepts an explicit override via
  `faucetTimeoutMs` / the `TOON_CLIENT_FAUCET_TIMEOUT_MS` env var.

## 0.7.0

### Minor Changes

- 427f799: Default `destination`/`relayUrl` from the committed genesis peer seed (`@toon-protocol/core` `GenesisPeerLoader`) instead of hardcoded apex literals — env/file values still win, falling back to the legacy literals only when the seed list is empty. Add `deriveRouteDestinations()` so `publishDestination`/`storeDestination` split from the `*.relay.store` anchor (`g.proxy.relay.store` → `g.proxy.relay` / `g.proxy.store`) rather than reusing the anchor as a `/write` target (which the proxy 404s); anchors that don't match the convention fall back unchanged.

## 0.6.0

### Minor Changes

- 44da9c9: Rename the `toon_upload_media` MCP tool to `toon_upload` and generalize it from media-only to any blob.

  The tool still does the spendy two-step upload (base64 bytes → Arweave via the kind:5094 store/DVM over `POST /store`, then sign+publish a referencing event), but its description and naming no longer imply media: the reference event `kind` defaults to 1063 (NIP-94; 20=picture, 21/22=video, 1=note w/ NIP-92 imeta) and can be set to suit any blob type. Callers using the old `toon_upload_media` name must switch to `toon_upload`.

### Patch Changes

- fec8793: Extract the Arweave gateway preference list into a single shared package `@toon-protocol/arweave` (was hand-duplicated in `views`, `rig`, and `client-mcp`).

  - New private, zero-dep `@toon-protocol/arweave` owns `ARWEAVE_GATEWAYS` + `arweaveTxId` / `arweaveUrls` / `arweaveGatewayCandidates`; `client-mcp` inlines it via tsup `noExternal` so the published bundle keeps zero `@toon-protocol/*` runtime deps.
  - `client-mcp`: upload-side gateway list is now configurable via `TOON_CLIENT_ARWEAVE_GATEWAYS` (comma-separated) > config file > shared default, threaded into `uploadMedia`.
  - `views`: media render imports the shared package (`parsers/arweave.ts` removed); the sandboxed-app CSP `connect`/`resource` domains default to the full gateway list (was `arweave.net` only, which would block ar.io media in the iframe).
  - `rig`: re-exports the shared list/timeout (importers unchanged).

- 39beb37: Tolerate the 2-part `evm:{chainId}` chain-key form some connectors advertise (e.g. `evm:31337`), not only the canonical 3-part `evm:{network}:{chainId}`.

  `parseChainId` (`OnChainChannelClient`) and the chainId-from-chainKey parsing in `ToonClient` (peer negotiations + `getChainContext`), `client-mcp/config`, and `apex-discovery` now accept both forms. A mis-parsed 2-part key previously produced `chainId: 0`, which the store connector rejects ("Invalid chainId").

- ca5711c: Split the daemon's write destination so relay publishes and store uploads route to the correct backend. Adds resolved `publishDestination` (relay writes → `POST /write`) and `storeDestination` (kind:5094 blob → `POST /store`) config fields — plus `TOON_CLIENT_PUBLISH_DESTINATION` / `TOON_CLIENT_STORE_DESTINATION` env overrides — each falling back to `destination` for backward-compat. `publish` (and `uploadMedia`'s NIP-94 reference event) default to `publishDestination`; the blob defaults to `storeDestination`, so uploads work via the default apex without the caller hand-passing a store `btpUrl`. An explicit per-call `destination` still wins; settlement is unchanged (pure ILP routing on the pre-signed apex claim).
- 2bdb1b5: Fix `toon_upload` against a discovered store/DVM apex (e.g. `g.proxy.store`), which failed at several independent points on the payment path:

  - **No route to destination (F02):** `deriveApexClientConfig` now derives a per-apex `proxyUrl` from the apex `btpUrl`, so paid packets POST to the discovered apex's connector instead of the default (relay) connector, which has no route to the store's ILP prefix.
  - **Wrong apex for the ref event:** `uploadMedia` now publishes the NIP-94 reference event through the default (relay) apex rather than the upload's `btpUrl`, since a store/DVM apex only serves `POST /store`.
  - **ar.io gateway:** media URLs and the views CSP default to `https://ar-io.dev` (the canonical gateway) so uploaded media renders; `arweave.net` is retained in the CSP for back-compat.

## 0.5.3

### Patch Changes

- 68e1a59: Parse the HTTP-over-ILP response carried in an ILP FULFILL packet's `data` on the paid-write and blob-upload paths.

  The deployed connector is a payment-proxy: an accepted ILP FULFILL only means the payment cleared — the FULFILL `data` carries the relay/DVM's verbatim HTTP/1.1 response, so a write can fail inside a successful FULFILL.

  - **Publish (`ToonClient.publishEvent`):** previously reported `success` with a real `eventId` for ANY accepted FULFILL, even when the embedded HTTP status was `404 Not Found` and the event never persisted. It now parses the FULFILL envelope and fails the publish on a non-2xx status (no fake `eventId`).
  - **Blob upload (`ToonClient.uploadBlob` / `requestBlobStorage`):** previously base64-decoded the WHOLE FULFILL data as a bare Arweave tx id, erroring on the real `HTTP/1.1 200 OK ... {"accept":true,"txId":"…"}` body. It now parses the HTTP envelope, JSON-decodes the body, and reads `txId` (falling back to base64-decoding `data`), failing on non-2xx or `accept:false`.

  A shared `parseFulfillHttp` helper backs both paths and falls back to prior behavior for non-HTTP-enveloped FULFILLs (no regression for legacy/non-proxy relays). The MCP daemon's `upload-media` path now surfaces these upload failures instead of returning a fake tx id.

## 0.5.2

### Patch Changes

- 9aef6b9: Redesign `note-card` as an X-style post with clear Like and Follow affordances.

  - **Header row** now reads like an X post: avatar → display name (bold) ·
    `@handle`/npub (muted, via MonoId) · "·" · relative timestamp, with a compact
    **Follow** button (outline pill) on the right for the author.
  - **Action bar** is an X-style left-aligned icon row: **Reply**
    (speech-bubble) → `reply`; **Like** (lucide `Heart`, with the live reaction
    count) → the existing `react` action publishing kind:7 `"+"` — the "React"
    label is now surfaced as **Like**, and the heart fills + tints accent on an
    optimistic toggle. Repost stays an icon-less no-op tracked in #103 (kind:6
    publishing is out of scope here).
  - **Follow** is a new action on `note-card`: it publishes a NIP-02 kind:3
    follow list adding the author's pubkey, by passing `tags: [['p', author]]`
    as a runtime arg that the runtime merges over the spec's static publish args
    (mirrors `follow-button`). The button toggles to "Following" optimistically.
  - Like and Follow are paid writes; a subtle footnote notes that each action
    spends the per-event channel fee. No heavy pay-confirm is forced for a like.
  - `note-card` now declares the `toon_publish_unsigned` write in both the React
    registry and the catalog (so `toon_atoms` advertises it and the ViewSpec
    validator allows reply/react/follow); description/propsSchema updated. Atom id
    and registered kind (1) are unchanged; built on the existing shadcn/OKLCH
    tokens + lucide-react with no new deps.

  `client-mcp` reships the refreshed app bundle that includes the redesigned card.

## 0.5.1

### Patch Changes

- f188433: Add a status dashboard + generic content atoms so the agent can render
  non-event data (daemon status, write targets, balances, identity) instead of
  falling back to plain text.

  - New generic content primitives — `heading`, `text`, `stat`, `key-value`,
    `badge` — props-driven (no event kinds), so any structured data composes from
    the atom vocabulary.
  - New `client-status` dashboard atom: reads live `toon_status` via the existing
    `readStatus()` seam and renders ready/bootstrapping state, uptime, settlement
    chain + fee, relay (url/connected/buffered/subscriptions), transport,
    per-chain readiness, and identity (npub + chain addresses); handles the
    loading/unavailable states gracefully.
  - New example ViewSpecs (`client-status`, `info`) so the agent learns the
    render-first pattern for non-event surfaces.

  `client-mcp` ships a refreshed app bundle that includes the new atoms.

## 0.5.0

### Minor Changes

- a0903d6: Move the render-first policy onto the MCP server itself so it reaches every host — including claude.ai chat, which never loads the Claude Code plugin skill and only sees tool descriptions + the server `instructions` field.

  - `toon_render` description rewritten to claim the PRIMARY display surface for all TOON data, explicitly beating generic HTML/SVG/chart/widget tools, naming the trigger verbs (see/show/open/view/browse/render/compose), and mandating an atoms-first flow.
  - Server `instructions` set on the `Server` options in `mcp.ts` (returned in the `initialize` result) with a condensed render-first policy.
  - Read/status tools (`toon_status`, `toon_query`, `toon_channels`, `toon_targets`, `toon_read`) gained a one-line nudge to display results via `toon_render` rather than a generic widget or plain text.
  - `toon_atoms` strengthened to an imperative precursor: REQUIRED first call before any `toon_render`; never guess atom ids/kinds.

  Descriptions/instructions only — no tool behavior, params, handlers, or ViewSpec validation changed. Complements the Claude Code skill render-first policy (PR #110).

## 0.4.2

### Patch Changes

- 1db36cb: Polished social feed + composer UI. NoteCard is now a real feed item — identity avatar (profile picture, else a deterministic gradient fallback with npub initials), display name (joined from kind:0 profile binds, else MonoId npub), a relative timestamp, the note body, inline media, and an engagement footer (Reply + React with live reaction counts) wired to the existing `reply`/`react` actions. The composer and pay-confirm atoms get a card surface with an auto-sizing textarea and a footer toolbar that surfaces a UTF-8 byte counter (TOON fees scale with encoded bytes); the pay-to-write flow keeps its idle→confirm→publishing→receipt phases, now restyled so the confirm step clearly shows fee + settlement chain + size and the receipt reads as a success state. Built on the existing shadcn/OKLCH tokens and lucide-react — no new deps; the atom contract, registered kinds, and inline-media rendering are unchanged. (client-mcp serves the refreshed app bundle.)

## 0.4.1

### Patch Changes

- 25d0473: Wire the NIP-on-TOON render trust gradient into the live app render path (toon-meta#58). The gradient was previously dead code; it is now the real render path for every incoming event.

  **`@toon-protocol/views` — the gradient is now the live event render path.**

  - `buildKindRegistry()` (in `atoms/registry.ts`) builds the branch-1 `KindRegistry<Atom>` from the catalog's atom→kind metadata — the registry `guardedRenderDispatch` consults first. The generic fallback atom is deliberately not registered, so an unknown kind misses and falls through to the unknown-kind branches.
  - A new renderer resolver (`render/resolve.tsx`): `useRenderDecision(event, bridge, registry, pins)` runs the gradient per event. Known kinds short-circuit to branch 1 (native) with no relay round-trip; for an unknown kind with a `ui` coordinate it fetches candidate `kind:31036` renderers over the bridge — `toon_query { kinds: [31036], '#d': [targetKind], authors: [eventAuthor] }` — and drives `guardedRenderDispatch` once they arrive (async loading state). `rendererQueryFilter(event)` is exported.
  - `runtime.tsx`'s `EventAtom` (the kindAuto / feed render seam) now switches on the `RenderDecision`: `native` → the atom component (full trust, today's behaviour); `a2ui` → `A2UIRenderer` (medium, with generative fall-through on a gate refusal); `mcp-ui` → `SandboxedAppRenderer` with the host-rendered consent prompt (low); `generative` → `GenerativeFallbackRenderer` (low, deterministic generator; no model is wired in the app and publish-back stays off). Dispatch goes through `guardedRenderDispatch` (not bare `renderDispatch`), so author-binding + signature + anti-swap pinning apply; a session-scoped `RendererPinStore` is seeded at app scope. The explicit atom-by-id ViewSpec path (`NodeView`) is unchanged.

  **`@toon-protocol/client` — browser-safe `./render` subpath.**

  - Adds a `@toon-protocol/client/render` export (and a second tsup entry) exposing just the render trust gradient — pure dispatch + swap-defense + branch helpers that depend only on `@toon-protocol/core`'s `ui` helpers and `nostr-tools`. The views app bundle imports this subpath instead of the package root so the client's Node-only channel/transport code never enters the iframe bundle. No behaviour change to existing `@toon-protocol/client` consumers.

  **`@toon-protocol/client-mcp` — reship the rebuilt bundle.**

  - client-mcp copies `@toon-protocol/views`' prebuilt `dist/app/index.html` into its own `dist/app` at build time and serves it at `ui://toon/app`. A patch bump so a published client-mcp reships the rebuilt, gradient-wired app bundle.

## 0.4.0

### Minor Changes

- 28ba334: Add a `toon_fund_wallet` MCP tool that drips devnet test funds to a wallet from the configured faucet. With no arguments it funds the client's own address on the active settlement chain (the usual "fund me before I open a channel" step); `chain` and `address` can be overridden. It's backed by a new `/fund-wallet` control-plane route on `toon-clientd` (the daemon holds the faucet URL + keys, so the MCP caller needs neither).

  Also enables Solana and Mina in the `fundWallet` client helper. They were previously gated behind a "deferred (WS3)" throw; the deployed devnet faucet now drips all three chains (EVM ETH+USDC, Solana SOL+USDC, Mina native+USDC) with an identical `{ address }` request shape.

### Patch Changes

- 7d9b1db: Fix note-card bind producing empty render; reject unknown bind keys

  Two bugs caused an empty white container when using `note-card` with a NIP-01 filter bind:

  1. `validateViewSpec` silently accepted unknown `bind` keys (e.g. `filter` instead of the correct `query`), so the wrong key passed validation, was ignored at runtime, and resolved to zero events.
  2. `NoteCard` used `.find()` so only the first event rendered even when a query returned many events.

  `client-mcp` is bumped so the updated views bundle (with both fixes) is republished.

- 7962d71: Fix `toon_status` to surface `feePerEvent` via `okStructured()` so pay-confirm shows the real fee instead of zero.

## 0.3.1

### Patch Changes

- a91f5c5: Fix note-card bind producing empty render; reject unknown bind keys

  Two bugs caused an empty white container when using `note-card` with a NIP-01 filter bind:

  1. `validateViewSpec` silently accepted unknown `bind` keys (e.g. `filter` instead of the correct `query`), so the wrong key passed validation, was ignored at runtime, and resolved to zero events.
  2. `NoteCard` used `.find()` so only the first event rendered even when a query returned many events.

  `client-mcp` is bumped so the updated views bundle (with both fixes) is republished.

## 0.3.0

### Minor Changes

- 703dcd7: Route paid writes through the connector proxy (ILP-over-HTTP) and add devnet config + faucet helper.

  `@toon-protocol/client`:

  - **Transport-agnostic paid-write path.** `publishEvent`, `sendSwapPacket`, and `sendPayment` now route the ILP PREPARE + signed payment-channel claim through the ACTIVE ILP transport instead of hard-requiring a BTP socket. Selection mirrors `modes/http.ts`: the `runtimeClient` (the `HttpIlpClient` `POST /ilp` proxy transport when a `proxyUrl`/`connectorHttpEndpoint` is configured, else the BTP socket) is used when it implements `sendIlpPacketWithClaim`, with the BTP client as fallback. The old `NO_BTP_CLIENT` throw is replaced by a clearer `NO_ILP_TRANSPORT` error when no claim-capable transport is configured. BTP remains fully supported when it is the configured transport. All claim signing/construction is unchanged (claim validation stays connector-only).
  - **New config fields** `proxyUrl` and `faucetUrl` on `ToonClientConfig`. Setting `proxyUrl` (e.g. `https://proxy.devnet.toonprotocol.dev`) derives `connectorHttpEndpoint` (`…/ilp`) so writes route over ILP-over-HTTP, satisfies the `connectorUrl` requirement, and suppresses BTP-url auto-derivation (the proxy edge serves ILP-over-HTTP, not necessarily BTP). New `proxyIlpEndpoint()` helper.
  - **New `fundWallet(faucetUrl, address, chain)` faucet helper** (`faucet.ts`). EVM is implemented (`POST /api/request`, drips ETH + USDC); Solana/Mina throw a clear "deferred (WS3)" error.

  `@toon-protocol/client-mcp`:

  - Daemon config accepts `proxyUrl`/`faucetUrl` (env `TOON_CLIENT_PROXY_URL` / `TOON_CLIENT_FAUCET_URL`) and `TOON_CLIENT_DESTINATION`. A `proxyUrl` now satisfies the uplink requirement (`btpUrl` becomes optional) so the daemon can write through the proxy with no BTP socket. The destination stays configurable (e.g. `g.proxy` for devnet) and is NOT hardcoded as a global default.
  - Added `e2e/devnet.ts`: deployed-devnet endpoint constants + a `TOON_DEVNET_E2E`-gated `fundDevnetWallet()` step that funds the client wallet via the faucet helper before publishing. The normal unit suite never touches the network.

  The eventual home for the devnet endpoints is a `@toon-protocol/core` devnet preset (upstream npm release); they live here as explicit config until that ships.

- 4fa8019: Proxy-mode apex negotiation + per-chain payment-channel creation, enabling paid writes over the connector proxy `POST /ilp` without a BTP socket (issue #69).

  `@toon-protocol/client-mcp`:

  - **Proxy-mode apex negotiation (no BTP).** The daemon now populates the apex's `peerNegotiations` in proxy-only mode (`proxyUrl` set, no `btpUrl`) so `toon_publish` / `toon_open_channel` no longer fail with `Cannot resolve peer for destination: g.proxy`. The negotiation is sourced, in precedence order, from an explicit `apexChains[chain]` / `apex` block, then a negotiation synthesized from the flat settlement config (`settlementAddresses` / `tokenNetworks` / `preferredTokens`), then live `kind:10032` discovery off the relay. The connector's on-chain settlement (counterparty) address is REQUIRED to open a channel and is never fabricated — when it cannot be determined, the runner defers to relay discovery and surfaces the exact missing value via the apex `lastError`.
  - **Lazy, persisted channel open in proxy mode.** Bootstrap injects the negotiation and becomes ready WITHOUT opening the channel, so the wallet can be funded after the daemon starts (the fund → open → publish flow). The on-chain EVM channel is opened idempotently on the first `POST /channels` / paid write, then persisted for restart-resume. BTP mode keeps its historical eager open.
  - **Read-only daemon (no uplink).** `resolveConfig` no longer throws `No uplink configured`; a relay-only daemon starts and serves FREE reads. A write attempt without a proxy/BTP uplink is rejected at the control plane with an actionable "configure an uplink" error (`hasUplink`).

  `@toon-protocol/client`:

  - Paid writes route through the ACTIVE ILP transport selected in `modes/http.ts` (the `HttpIlpClient` `POST /ilp` proxy transport when a `proxyUrl`/`connectorHttpEndpoint` is configured) — no change to claim signing/construction. Payment-claim validation stays connector-only.

  Validated live against the deployed devnet (Anvil chain 31337): the daemon negotiates in proxy mode, funds via the faucet, opens + deposits into an on-chain payment channel against the connector's settlement address, signs a balance-proof claim, and sends it over `POST /ilp`. The connector accepts the HTTP transport and returns a structured ILP response.

- fed33cb: BREAKING: removed the legacy hidden-service / Anyone-protocol (`.anyone` / SOCKS5h) transport overlay.

  The canonical client payment path is now connector-as-proxy over ILP-over-HTTP (`ToonClient.h402Fetch`) with BTP/WebSocket as the duplex session transport. The `.anyone` SOCKS5h overlay is gone.

  `@toon-protocol/client` (minor — pre-1.0 breaking):

  - Removed exports: `startManagedAnonProxy`, `selectAnonAsset`, `ANON_VERSION`, `ANON_ASSETS`, `ManagedAnonProxy`, `StartManagedAnonProxyOptions`, `AnonAsset`, `isRoutableHsHostname`, `assertRoutableHsHostname`, `HS_HOSTNAME_REGEX`, `HS_HOSTNAME_MAX_LENGTH`, and the `ClientTransportConfig` type.
  - Removed `ToonClientConfig` fields: `transport`, `managedAnonProxy`, `managedAnonSocksPort`.
  - Removed modules: `transport/anon-proxy`, `transport/socks5`, `transport/hs-hostname`, `transport/gateway`, `transport/index` (transport resolution).
  - Dropped the optional `socks-proxy-agent` dependency.

  KEPT (unchanged): BTP/WebSocket transport, `h402Fetch` / ILP-over-HTTP, payment channels, balance-proof claim signing, and free relay reads.

  `@toon-protocol/client-mcp` (minor): removed the `managedAnonProxy` / `socksProxy` config knobs, the `TOON_CLIENT_SOCKS` env override, the daemon-managed `.anyone` read proxy, and the `.anyone`-relay auto-detection. The daemon dials `btpUrl` / `relayUrl` directly. Dropped the optional `socks-proxy-agent` dependency.

### Patch Changes

- 94b83dd: Fix `ToonClient.publishEvent` to send the HTTP `POST /write` store envelope on the payment-proxy path.

  The deployed connector is a payment-proxy that terminates paid writes as HTTP-in-ILP: it decodes the ILP PREPARE `data` as a literal HTTP/1.1 request and reverse-proxies it to the relay store's `POST /write`. `publishEvent` previously sent the bare TOON-encoded event as `data`, which has no request-line, so the proxy rejected every paid write with `F01 - Invalid HTTP envelope: malformed request-line`. The high-level `publishEvent` / daemon `/publish` / `uploadMedia` / blob-storage paths (which all funnel through `publishEvent`) were therefore broken against the live store.

  `publishEvent` now wraps the signed event in a `POST /write HTTP/1.1` envelope carrying `{"event": <signed event object>}` as the JSON body (the shape the store's `/write` handler verifies and stores). A shared `buildStoreWriteEnvelope` helper is exported from `@toon-protocol/client`. The TOON encoding is still used to price the write; `sendSwapPacket` (Mill swaps, a raw-TOON contract) is intentionally left unwrapped.

  Also fixes the `client-mcp` `e2e/devnet.ts` apex destination: `g.proxy` F02s ("No route"); the routable store address is `g.proxy.relay.store`.

## 0.2.0

### Minor Changes

- b539273: Add payment-aware HTTP fetch (h402).

  `ToonClient.h402Fetch(url, opts)` is a `fetch()`-like method that makes paying for an HTTP resource transparent: it issues the request, and on `402 Payment Required` parses the x402 `accepts` array, selects the `toon-channel` entry, opens or reuses a payment channel via `ChannelManager`, and sends the raw HTTP request as a transparent HTTP-in-ILP packet to `POST /ilp` via `HttpIlpClient` (claim in the `ILP-Payment-Channel-Claim` header). The FULFILL bytes are reconstructed into a standard Web `Response`, so the caller never sees ILP. When no `toon-channel` entry is offered it surfaces the vanilla x402 challenge unchanged. Transport selection (HTTP vs BTP upgrade) is driven by `selectIlpTransport`; full duplex response streaming is a documented v1 limitation. New `Http402Client` adapter holds the reusable x402-parsing and HTTP-in-ILP framing logic.

  `@toon-protocol/client-mcp` exposes this as the `toon_http_fetch_paid` MCP tool (inputs `{ url, method?, headers?, body?, timeout? }`), routed through the `toon-clientd` control plane (`POST /http-fetch-paid`) to `ToonClient.h402Fetch`, returning `{ status, headers, body }`.
