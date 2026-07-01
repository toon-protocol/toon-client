# @toon-protocol/client

## 0.14.12

### Patch Changes

- 0ccd135: Surface an actionable error when the one-time on-chain payment-channel OPEN reverts because the local settlement wallet has no native gas. The client now throws a tagged `ChannelFundingError` (remapped at the origin in `OnChainChannelClient.openEvmChannel`, covering both publish and upload paths) instead of leaking the raw viem "…exceeds the balance of the account" string; the daemon maps it to HTTP 402 `insufficient_gas` (retryable), and the MCP tools surface the "fund the wallet and retry" remedy verbatim instead of a misleading "still bootstrapping" hint. Per-write settlement is unaffected (it rides ILP-over-HTTP and never spends gas) — this only improves the message on the one-time channel-open funding step (toon-meta#65).

## 0.14.11

### Patch Changes

- b243c10: Fix the wallet falsely showing "No channels open yet" on funded channels, and
  make rendered TOON views render-first with no preflight ceremony.

  - **`GET /channels` 500 → wallet "No channels open yet".** `getChannels()`
    called `apex.client.getSettleableAt(channelId)`, but `ToonClient` never got the
    public passthrough when it was added to `ChannelManager` (#181) — it only used
    `this.channelManager.getSettleableAt` internally. The wallet atom renders the
    failed fetch as empty, so funded, actively-paying channels showed as none.
    Added the passthrough, plus a compile-time conformance guard
    (`toon-client-conformance.ts`) asserting `ToonClient` satisfies the daemon's
    `ToonClientLike` surface — the channel-tool tests use a mock client, which is
    why this gap shipped green.
  - **Resumed channels showed 0 deposit / 0 available.** Persisted channel state
    omits the on-chain deposit, so after a daemon restart `depositTotal` was `0`
    and the wallet showed 0 spendable on a funded channel. The daemon now re-reads
    the participant's on-chain `deposit` (new `participants` accessor on the
    TokenNetwork ABI + `ToonClient.rehydrateChannelDeposit`) when resuming an EVM
    apex channel, so `available = deposit − cumulative` is correct again.
  - **Render-first, zero ceremony.** The server `instructions` and the
    `toon_status` / `toon_identity` tool descriptions now state that a read-only
    render goes straight `toon_atoms` → `toon_render` — no status/identity/balance
    preflight, no tool-call narration. SKILL.md's "always start with `toon_status`"
    is reframed to lazy/render-first.

- b243c10: Wallet balance correctness (#199/#200), async funding, UI auto-refresh, and media posts.

  - Balances: fast-fail with correct error attribution instead of a 35s control-plane hang; always emit wrapped `structuredContent`; the views seam validates the wire contract (no silent blank); read the settlement chain (not the preset-first chain) and from an identity-level client (works with no apex).
  - Funding: async submit+poll `fund-wallet` with a `toon_fund_status` tool, a generous background faucet timeout, and a distinct `timeout` status so a slow-but-successful drip isn't reported as a failure.
  - UI: rendered views auto-refresh after any write action; the Fund button resets once the balance updates.
  - Media posts: captioned media uploader (compose → caption → publish) and an optional media/file attach on the default post composer (kind:1 with NIP-92 imeta, rendered inline); the dedicated uploader remains for upload-only.

## 0.14.10

### Patch Changes

- 48205b0: Wallet balance correctness (#199/#200), async funding, UI auto-refresh, and media posts.

  - Balances: fast-fail with correct error attribution instead of a 35s control-plane hang; always emit wrapped `structuredContent`; the views seam validates the wire contract (no silent blank); read the settlement chain (not the preset-first chain) and from an identity-level client (works with no apex).
  - Funding: async submit+poll `fund-wallet` with a `toon_fund_status` tool, a generous background faucet timeout, and a distinct `timeout` status so a slow-but-successful drip isn't reported as a failure.
  - UI: rendered views auto-refresh after any write action; the Fund button resets once the balance updates.
  - Media posts: captioned media uploader (compose → caption → publish) and an optional media/file attach on the default post composer (kind:1 with NIP-92 imeta, rendered inline); the dedicated uploader remains for upload-only.

## 0.14.9

### Patch Changes

- cb2362b: Rename legacy `town` node-type label to `relay` in comments, docs, and config keys.

## 0.14.8

### Patch Changes

- 686f7a3: Channel withdraw (close → wait → settle) — release collateral from a channel.

  - Client: `OnChainChannelClient.closeChannel`/`settleChannel` (EVM live; reads the
    `channels()` view for the authoritative `closedAt`+`settlementTimeout`).
    `ChannelManager` persists `closedAt`/`settleableAt`/`settledAt` (resumed on
    restart; `signBalanceProof` no longer clobbers them) + `getChannelCloseState`.
    `ToonClient.closeChannel`/`settleChannel` — the settle time guard: never settle
    before `settleableAt` (unix seconds), throwing a retryable error otherwise.
    Solana/Mina close+settle are follow-ups.
  - Daemon: `POST /channels/{close,settle}` (settle-too-early → HTTP 425 retryable),
    `toon_channel_close`/`toon_channel_settle` MCP tools; `toon_channels` now carries
    `closeState`/`settleableAt`.
  - Views: `withdraw-flow` atom — a stepper (Close → Wait → Settle) with a live
    countdown to `settleableAt` and a Settle button gated until the grace period
    elapses; reuses the `progress-steps` stepper.

## 0.14.7

### Patch Changes

- b56fefb: Solana channel deposit (PR B.1).

  Extract `depositSolanaChannel` from the open flow's post-init `deposit`
  instruction and wire it into `OnChainChannelClient.depositToChannel` so
  `toon_channel_deposit` now works on Solana (incremental: the new total is the
  tracked current plus the delta). EVM was added in PR B; Mina deposit (o1js)
  remains a follow-up. No daemon/views changes — that layer is chain-agnostic.

## 0.14.6

### Patch Changes

- d93211a: Add channel deposit (`toon_channel_deposit`) — deposit additional on-chain
  collateral into an open payment channel.

  - Client: `OnChainChannelClient.depositToChannel(channelId, amount, { currentDeposit })`
    with the EVM path live (approve if the allowance is short, then `setTotalDeposit`
    with `current + delta` — the contract takes the cumulative total, not a delta).
    Solana/Mina throw a clear not-yet-supported error (follow-up). `ChannelManager`
    gains `setDepositTotal`; `ToonClient.depositToChannel` reads the current tracked
    deposit, deposits, and updates the tracked total.
  - Daemon: `POST /channels/deposit`, `ControlClient.depositToChannel`, and the
    `toon_channel_deposit` MCP tool (routes to the apex tracking the channel).
  - Views: `deposit-form` atom (channel picker + amount + spendy signed deposit +
    receipt) and the `toon_channel_deposit` write tool on the apps surface.

## 0.14.5

### Patch Changes

- 5838b79: Add wallet + loading/placeholder atoms to the MCP UI.

  - Loading atoms (`skeleton`, `loading`, `progress-steps`) the agent can render
    immediately while it works out the real journey.
  - `wallet-overview` (per-chain address with copy-to-share + on-chain balance
    enrichment + devnet faucet) and `channel-list` (live tracked channels with
    available/deposit balance), backed by new read seams.
  - New free-read tools `toon_channels` (now enriched with `depositTotal` +
    `availableBalance`) and `toon_balances`, plus the `toon_fund_wallet` faucet
    action wired into the apps surface. Client exposes `getChannelDepositTotal`.

- 5838b79: Read live on-chain wallet balances (`toon_balances`).

  Adds a read-only `WalletBalanceReader` (EVM ERC-20 `balanceOf` via viem; Solana
  SPL via `getTokenAccountsByOwner`; native MINA via GraphQL) and
  `ToonClient.getBalances()` — best-effort per chain, no signing or payment. Wires
  it end-to-end through the daemon: `GET /balances`, `ControlClient.balances()`,
  and the `toon_balances` MCP tool. The `wallet-overview` atom's balances now
  resolve live (it already worked from the identity addresses).

## 0.14.4

### Patch Changes

- 83eb81b: Rename legacy vocabulary: the swap-peer node concept is now consistently called "swap" across all packages (part of #134).

  `SwapRequest.millPubkey` → `swapPubkey`, `SwapClaim.millSignerAddress` → `swapSignerAddress`, `TOON_MILL_PUBKEY` env var → `TOON_SWAP_PUBKEY`, ILP address segments updated (e.g. `g.townhouse.swap`), and all prose/doc references updated.

- 9a917f5: Rename non-NIP-90 `dvm` vocabulary to `store` across the repo (issue #139).

## 0.14.3

### Patch Changes

- 26537fd: Make the daemon faucet request timeout chain-aware. The Mina faucet settles much
  slower than EVM/Solana and routinely takes longer than the flat 30s HTTP budget
  to respond even though the drip succeeds server-side, so `toon_fund_wallet({chain:"mina"})`
  reported `Faucet request timed out after 30000ms` on a request that actually
  funded the wallet. `fundWallet` now defaults to 30s for evm/solana and 120s for
  mina (`defaultFaucetTimeout`), and the daemon accepts an explicit override via
  `faucetTimeoutMs` / the `TOON_CLIENT_FAUCET_TIMEOUT_MS` env var.

## 0.14.2

### Patch Changes

- 39beb37: Tolerate the 2-part `evm:{chainId}` chain-key form some connectors advertise (e.g. `evm:31337`), not only the canonical 3-part `evm:{network}:{chainId}`.

  `parseChainId` (`OnChainChannelClient`) and the chainId-from-chainKey parsing in `ToonClient` (peer negotiations + `getChainContext`), `client-mcp/config`, and `apex-discovery` now accept both forms. A mis-parsed 2-part key previously produced `chainId: 0`, which the store connector rejects ("Invalid chainId").

- 5bfae71: Restore the `POST /store` request-target for blob uploads. `buildStoreWriteEnvelope` again accepts a `requestTarget` (default `/write`), `publishEvent` threads a `proxyPath` option through to it, and `requestBlobStorage` passes `/store`. Without this, kind:5094 blob uploads emitted `POST /write` and the Arweave store backend (which serves `/store` + `/health` only) returned 404. Adds a `store-envelope` regression test covering both targets.

## 0.14.1

### Patch Changes

- 68e1a59: Parse the HTTP-over-ILP response carried in an ILP FULFILL packet's `data` on the paid-write and blob-upload paths.

  The deployed connector is a payment-proxy: an accepted ILP FULFILL only means the payment cleared — the FULFILL `data` carries the relay/DVM's verbatim HTTP/1.1 response, so a write can fail inside a successful FULFILL.

  - **Publish (`ToonClient.publishEvent`):** previously reported `success` with a real `eventId` for ANY accepted FULFILL, even when the embedded HTTP status was `404 Not Found` and the event never persisted. It now parses the FULFILL envelope and fails the publish on a non-2xx status (no fake `eventId`).
  - **Blob upload (`ToonClient.uploadBlob` / `requestBlobStorage`):** previously base64-decoded the WHOLE FULFILL data as a bare Arweave tx id, erroring on the real `HTTP/1.1 200 OK ... {"accept":true,"txId":"…"}` body. It now parses the HTTP envelope, JSON-decodes the body, and reads `txId` (falling back to base64-decoding `data`), failing on non-2xx or `accept:false`.

  A shared `parseFulfillHttp` helper backs both paths and falls back to prior behavior for non-HTTP-enveloped FULFILLs (no regression for legacy/non-proxy relays). The MCP daemon's `upload-media` path now surfaces these upload failures instead of returning a fake tx id.

## 0.14.0

### Minor Changes

- 4f51ba1: Add branch 3 of the NIP-on-TOON render trust gradient: the sandboxed mcp-ui `AppRenderer` and the load-bearing **consent invariant** (toon-meta#58, toon-client#90). **Security-sensitive — see the PR for the threat model.**

  **Branch 3 (low trust).** When an unknown kind resolves to a `kind:31036` renderer tagged `m: text/html;profile=mcp-app`, the raw widget HTML is extracted (`extractUiResource` in `@toon-protocol/client`) and rendered inside a hardened, sandboxed iframe via `@mcp-ui/client`'s `AppRenderer` (`SandboxedAppRenderer` in `@toon-protocol/views`). The iframe `sandbox` attribute is overridden to **`allow-scripts` only** — notably _without_ `allow-same-origin` — so the widget runs in an opaque origin and can never reach the host DOM, storage, or the consent surface. `assertSafeSandbox` is a defensive guard against re-enabling any escape token.

  **Consent invariant.** A sandboxed widget may only _request_ an action; it may never _perform_ one or paint the authorization UI. Every `tools/call` the widget requests is classified by the trusted client (`classifyIntent`, default-deny: only a tiny read-only allowlist auto-forwards). Anything state-changing surfaces a host-rendered `ConsentPrompt` drawn **outside** the iframe, using only the client's own audited primitives. The prompt is **non-themeable by construction**: its sole input (`ConsentRequest`) carries no styling/markup field — only a tool name, plain (text-rendered, never `dangerouslySetInnerHTML`) arguments, and a client-fixed `trust: 'low'` that a widget cannot escalate. The action is performed only on an explicit user grant; a denial returns an error to the widget and performs nothing.

  `@toon-protocol/client` gains the framework-agnostic consent module (`extractUiResource`, `classifyIntent`, `buildConsentRequest`, and the `UiResource`/`WidgetIntent`/`ConsentRequest`/`ConsentDecision` types); `@toon-protocol/views` gains the React `SandboxedAppRenderer` + `ConsentPrompt` and the sandbox-hardening helpers. Consumes the branch-3 `McpUiDecision` from `renderDispatch` (#88) and accepts the `fallback: 'mcp-ui'` hand-off from the branch-2 A2UI renderer (#89); the dispatch contract is unchanged. Renderer-swap defense and branch 4 remain #91/#92.

- c22d655: Add branch 4 of the NIP-on-TOON render trust gradient — the generative fallback + optional `kind:31036` publish-back (toon-meta#58, closes #92).

  When a kind is unknown _and_ no resolvable `kind:31036` renderer exists, `GenerativeFallbackRenderer` produces a best-effort, low-trust rendering of the event's shape. The model call is abstracted behind an injectable `RendererGenerator` seam — the host wires its own provider/keys/prompt; this package imports no LLM SDK. A dependency-free `deterministicGenerator` is the default and falls in automatically if an injected model generator throws, so branch 4 always renders _something_.

  Optional **publish-back** republishes the generated renderer as a `kind:31036` addressable event (`d` = target kind, `m` = renderer mimeType, coordinate `31036:<author-pubkey>:<targetKind>`) so the next client has a "known" renderer — branch 4 slowly feeds branch 1. Publish-back is **off by default** and a guarded capability: it only fires when the host passes `publish: { enabled: true, signer, publisher }`. The published renderer is marked curation-pending (`t=generative-fallback`); the namespacing/curation policy is an open epic question and is intentionally not built here.

  Note: `buildUiCoordinate` (and the renderer kind / `ui` tag / coordinate helpers) are imported from `@toon-protocol/core@^1.6.0`, re-exported through `render/constants.ts`. No local mirror.

- c8efd64: Adopt `@toon-protocol/core@^1.6.0` and wire `ui` → `kind:31036` renderer resolution (toon-meta#58).

  The `UI_RENDERER_KIND` (31036) and `UI_TAG` (`ui`) constants mirrored locally in `src/render/constants.ts` for the dispatch skeleton (#88) are now re-exported from the published `@toon-protocol/core` instead; only the render-branch mime selectors (`MIME_A2UI`, `MIME_MCP_APP`), which core does not own, remain local.

  New resolution seam (`src/render/resolveRenderer.ts`) — the piece `renderDispatch` deliberately left out — built on core's pure helpers (`getUiCoordinate` / `parseUiCoordinate` / `selectLatestAddressable`):

  - `resolveUiCoordinate(event)` computes the renderer coordinate. Per the toon#36 decisions the renderer-author pubkey is the **event author**, so the `ui` tag may carry just the bare target kind; a full `31036:<pubkey>:<kind>` coordinate is also accepted but only when its pubkey equals the event author (no third-party renderers).
  - `resolveUiRenderer(event, candidates)` filters the caller-supplied `kind:31036` candidates to that coordinate, picks the latest addressable one (NIP-33 latest-wins), and **re-verifies its signature** with `verifyEvent` before returning it — an unverified renderer is dropped and never reaches the dispatch.

  The relay query that produces `candidates` stays the caller's responsibility, and `renderDispatch`'s contract is unchanged — resolution feeds it.

- 93a712a: Add the kind-keyed render dispatch skeleton + branch-1 native-component registry for the NIP-on-TOON render trust gradient (toon-meta#58).

  `renderDispatch(input, registry)` forks on one question — _do I know this kind?_ — and returns a `RenderDecision` naming the branch and trust tier: branch 1 (known kind → native component, full trust) is wired through the new generic `KindRegistry<C>` (`register`/`lookup`/`has`); branches 2 (A2UI), 3 (sandboxed mcp-ui) and 4 (generative fallback) are routed to clearly-marked decisions for the sibling tickets (#89/#90/#92) to implement. The `m` (mimeType) tag of a resolved `kind:31036` renderer selects the unknown-kind branch (`application/a2ui+json` → branch 2, `text/html;profile=mcp-app` → branch 3).

  Note: the `UI_RENDERER_KIND`/`UI_TAG`/`UiCoordinate` helpers are mirrored locally until they ship in a published `@toon-protocol/core` (blocked on toon#36); the `ui`-tag → `kind:31036` resolution lives outside the dispatch, which consumes an already-resolved renderer.

- 5bbabfa: Add the renderer-swap defense — a fail-closed security guard around render dispatch for the NIP-on-TOON render trust gradient (toon-client#91, toon-meta#58).

  A `kind:31036` renderer is _addressable_: the coordinate `31036:<author-pubkey>:<targetKind>` can later resolve to a different event/`id`. Because the resolved renderer selects both the render strategy and the trust tier, a malicious 31036 that gets selected can attack the user. The new `verifyRendererTrust(...)` guard runs between renderer resolution and `renderDispatch`, and refuses (fails closed — the caller drops to native for known kinds, generative for unknown kinds) on any violation:

  - **Author binding** — the resolved 31036's `pubkey` (and the `ui` coordinate's author segment) MUST equal the event author (the authoritative renderer author per toon#36); cross-author substitution is rejected.
  - **Signature verification** — the 31036 signature is re-verified (`verifyEvent`) before it can select a strategy; tampered/unsigned renderers are rejected (and a throwing verifier fails closed).
  - **Deterministic selection** — candidate revisions are collapsed with `selectLatestAddressable` (latest `created_at`, lowest-`id` tiebreak, NIP-01), so selection is not attacker-race-controllable.
  - **Anti-swap pinning + downgrade detection** — the chosen renderer `id`/trust tier is pinned per coordinate in a `RendererPinStore`; a later differing `id` is a detected swap. A trust-lowering swap is refused; for high-trust (branch-1 known) kinds _any_ `id` change is refused and falls back to the native component. The pin store can be seeded from config to allowlist a high-trust renderer by `event.id`.

  Adds `guardedRenderDispatch(...)` as the secure entry point that wires the guard around `renderDispatch` and never passes a suspect renderer through.

  The `UiCoordinate` helpers (`getUiCoordinate` / `selectLatestAddressable` / `UiCoordinate`) are imported directly from `@toon-protocol/core@1.6.0` (the dep bump landed in #97, which also dropped the local `constants.ts` mirror). The guard shares those primitives with the `resolveUiRenderer` resolver (#97) — so the two agree bit-for-bit on coordinate selection and signature acceptance — and layers the anti-swap pin store plus granular fail-closed rejection reasons on top, rather than re-deriving resolution as a parallel copy.

- 25d0473: Wire the NIP-on-TOON render trust gradient into the live app render path (toon-meta#58). The gradient was previously dead code; it is now the real render path for every incoming event.

  **`@toon-protocol/views` — the gradient is now the live event render path.**

  - `buildKindRegistry()` (in `atoms/registry.ts`) builds the branch-1 `KindRegistry<Atom>` from the catalog's atom→kind metadata — the registry `guardedRenderDispatch` consults first. The generic fallback atom is deliberately not registered, so an unknown kind misses and falls through to the unknown-kind branches.
  - A new renderer resolver (`render/resolve.tsx`): `useRenderDecision(event, bridge, registry, pins)` runs the gradient per event. Known kinds short-circuit to branch 1 (native) with no relay round-trip; for an unknown kind with a `ui` coordinate it fetches candidate `kind:31036` renderers over the bridge — `toon_query { kinds: [31036], '#d': [targetKind], authors: [eventAuthor] }` — and drives `guardedRenderDispatch` once they arrive (async loading state). `rendererQueryFilter(event)` is exported.
  - `runtime.tsx`'s `EventAtom` (the kindAuto / feed render seam) now switches on the `RenderDecision`: `native` → the atom component (full trust, today's behaviour); `a2ui` → `A2UIRenderer` (medium, with generative fall-through on a gate refusal); `mcp-ui` → `SandboxedAppRenderer` with the host-rendered consent prompt (low); `generative` → `GenerativeFallbackRenderer` (low, deterministic generator; no model is wired in the app and publish-back stays off). Dispatch goes through `guardedRenderDispatch` (not bare `renderDispatch`), so author-binding + signature + anti-swap pinning apply; a session-scoped `RendererPinStore` is seeded at app scope. The explicit atom-by-id ViewSpec path (`NodeView`) is unchanged.

  **`@toon-protocol/client` — browser-safe `./render` subpath.**

  - Adds a `@toon-protocol/client/render` export (and a second tsup entry) exposing just the render trust gradient — pure dispatch + swap-defense + branch helpers that depend only on `@toon-protocol/core`'s `ui` helpers and `nostr-tools`. The views app bundle imports this subpath instead of the package root so the client's Node-only channel/transport code never enters the iframe bundle. No behaviour change to existing `@toon-protocol/client` consumers.

  **`@toon-protocol/client-mcp` — reship the rebuilt bundle.**

  - client-mcp copies `@toon-protocol/views`' prebuilt `dist/app/index.html` into its own `dist/app` at build time and serves it at `ui://toon/app`. A patch bump so a published client-mcp reships the rebuilt, gradient-wired app bundle.

## 0.13.0

### Minor Changes

- 28ba334: Add a `toon_fund_wallet` MCP tool that drips devnet test funds to a wallet from the configured faucet. With no arguments it funds the client's own address on the active settlement chain (the usual "fund me before I open a channel" step); `chain` and `address` can be overridden. It's backed by a new `/fund-wallet` control-plane route on `toon-clientd` (the daemon holds the faucet URL + keys, so the MCP caller needs neither).

  Also enables Solana and Mina in the `fundWallet` client helper. They were previously gated behind a "deferred (WS3)" throw; the deployed devnet faucet now drips all three chains (EVM ETH+USDC, Solana SOL+USDC, Mina native+USDC) with an identical `{ address }` request shape.

## 0.12.0

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

## 0.11.0

### Minor Changes

- b539273: Add payment-aware HTTP fetch (h402).

  `ToonClient.h402Fetch(url, opts)` is a `fetch()`-like method that makes paying for an HTTP resource transparent: it issues the request, and on `402 Payment Required` parses the x402 `accepts` array, selects the `toon-channel` entry, opens or reuses a payment channel via `ChannelManager`, and sends the raw HTTP request as a transparent HTTP-in-ILP packet to `POST /ilp` via `HttpIlpClient` (claim in the `ILP-Payment-Channel-Claim` header). The FULFILL bytes are reconstructed into a standard Web `Response`, so the caller never sees ILP. When no `toon-channel` entry is offered it surfaces the vanilla x402 challenge unchanged. Transport selection (HTTP vs BTP upgrade) is driven by `selectIlpTransport`; full duplex response streaming is a documented v1 limitation. New `Http402Client` adapter holds the reusable x402-parsing and HTTP-in-ILP framing logic.

  `@toon-protocol/client-mcp` exposes this as the `toon_http_fetch_paid` MCP tool (inputs `{ url, method?, headers?, body?, timeout? }`), routed through the `toon-clientd` control plane (`POST /http-fetch-paid`) to `ToonClient.h402Fetch`, returning `{ status, headers, body }`.

## 0.10.0

### Minor Changes

- 7c4a34d: Add an ILP-over-HTTP (RFC-0035) client transport. `HttpIlpClient` sends one-shot writes via `POST /ilp` (OER PREPARE body, `ILP-Payment-Channel-Claim` header carrying the same claim bytes as the BTP path) and parses the FULFILL/REJECT from the 200 response, with an `upgradeToBtp()` path that opens a `btp`-subprotocol WebSocket carrying HTTP-proven identity. `initializeHttpMode` now selects `HttpIlpClient` when a connector advertises an HTTP endpoint (via the new `connectorHttpEndpoint` / `connectorSupportsUpgrade` config) and falls back to BTP otherwise. Backward compatible: with no HTTP endpoint configured, behavior is unchanged.
