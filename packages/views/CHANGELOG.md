# @toon-protocol/views

## 0.8.3

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

- Updated dependencies [5838b79]
- Updated dependencies [5838b79]
  - @toon-protocol/client@0.14.5

## 0.8.2

## 0.8.1

### Patch Changes

- 623bb8e: Refresh the views atom theme (cool-tinted palette + jade primary + Geist Mono ledger typography) and add a dev-only visual gallery harness.

## 0.8.0

### Minor Changes

- 83eb81b: Rename legacy vocabulary: the swap-peer node concept is now consistently called "swap" across all packages (part of #134).

  `SwapRequest.millPubkey` → `swapPubkey`, `SwapClaim.millSignerAddress` → `swapSignerAddress`, `TOON_MILL_PUBKEY` env var → `TOON_SWAP_PUBKEY`, ILP address segments updated (e.g. `g.townhouse.swap`), and all prose/doc references updated.

- d0b1055: Add a `profile-editor` atom that composes/updates a NIP-01 kind:0 profile from input fields (`name`, `display_name`, `picture` URL, `about`, optional `nip05`), serializes them into the kind:0 `content` JSON, and publishes via `toon_publish_unsigned` (`{ kind: 0, content }`) through the normal pay-to-write confirm flow. Bind a kind:0 event to pre-fill the form — unknown metadata fields (banner, lud16, …) are preserved on republish. Registered in the atom catalog/registry and surfaced as a `profile-editor` example view (editor + live `profile-header`).

### Patch Changes

- 801949d: Resolve feed note avatars. A feed bind queries `kinds:[1]` only, so `NoteCard` could never join the author's kind:0 from its own events and every note fell back to the placeholder avatar. Add a runtime-wired `resolveProfile` seam (a lazy, session-cached free read for an author's kind:0, mirroring the existing `readStatus` seam so atoms still never touch the bridge); `NoteCard` now pulls the author's profile on demand and shows their display name + picture, while authors with no kind:0 still degrade to the deterministic placeholder.
- 98f9e74: Sort bound events by `created_at` before rendering so feeds are deterministically newest-first regardless of relay return order or how buffered + streamed events merge. Ties break on `id` for a stable order. Adds a per-bind `sort` option (`'desc'` default, `'asc'` opt-in) so threads can render replies oldest-first.
- 9a917f5: Rename non-NIP-90 `dvm` vocabulary to `store` across the repo (issue #139).
- 6c18a4b: Surface the real media-upload error instead of a generic "Upload failed." The
  `media-uploader` atom now renders the underlying error string from the action
  outcome (degrading to a generic message only when none is present), and the
  daemon's `uploadMedia` labels which of the two legs failed — the Arweave blob
  upload (`store` destination) vs. the post-upload kind:20/1063 reference-event
  publish (`relay` destination) — so the failing leg is diagnosable from the UI
  without a behavioral change to the upload itself (#148).
- Updated dependencies [83eb81b]
- Updated dependencies [9a917f5]
  - @toon-protocol/client@0.14.4

## 0.7.1

### Patch Changes

- Updated dependencies [26537fd]
  - @toon-protocol/client@0.14.3

## 0.7.0

### Minor Changes

- c90d97d: Add branch 2 of the NIP-on-TOON render trust gradient: the A2UI declarative renderer (toon-meta#58).

  `A2UIRenderer` renders an unknown Nostr kind at **medium trust** through the client's own audited A2UI "Basic" catalog — never provider code. Per the branch-2 binding convention, the resolved `kind:31036` renderer's `content` is the A2UI `surfaceUpdate` (the durable template) and the decoded TOON event is fed in as the `dataModelUpdate` (the bound data); component props bind via `{ path: "/…" }` JSON Pointers into the event-derived data model.

  **Standard-catalog-only invariant:** `validateA2uiRenderer` is the medium-trust gate. Only the curated Basic catalog (`Text`, `Heading`, `Image`, `Icon`, `Row`, `Column`, `List`, `Card`, `Divider`) is rendered; any custom component **or** any client-defined behavior (`onClick`/`action`/validators/etc.) REFUSES and signals a drop to branch 3 (sandboxed mcp-ui) via the `A2uiGateRefuse.fallback` result — the renderer never renders a refused surface. The `["a2ui", "<version>"]` tag is checked; an unsupported version falls through gracefully (branch 1/4).

  Consumes the branch-2 `A2uiDecision` from `@toon-protocol/client`'s `renderDispatch` (#88); does not change the dispatch contract. Branches 3/4 + renderer-swap defense remain #90/#91/#92.

- 44da9c9: Rename the `toon_upload_media` MCP tool to `toon_upload` and generalize it from media-only to any blob.

  The tool still does the spendy two-step upload (base64 bytes → Arweave via the kind:5094 store/DVM over `POST /store`, then sign+publish a referencing event), but its description and naming no longer imply media: the reference event `kind` defaults to 1063 (NIP-94; 20=picture, 21/22=video, 1=note w/ NIP-92 imeta) and can be set to suit any blob type. Callers using the old `toon_upload_media` name must switch to `toon_upload`.

### Patch Changes

- fec8793: Extract the Arweave gateway preference list into a single shared package `@toon-protocol/arweave` (was hand-duplicated in `views`, `rig`, and `client-mcp`).

  - New private, zero-dep `@toon-protocol/arweave` owns `ARWEAVE_GATEWAYS` + `arweaveTxId` / `arweaveUrls` / `arweaveGatewayCandidates`; `client-mcp` inlines it via tsup `noExternal` so the published bundle keeps zero `@toon-protocol/*` runtime deps.
  - `client-mcp`: upload-side gateway list is now configurable via `TOON_CLIENT_ARWEAVE_GATEWAYS` (comma-separated) > config file > shared default, threaded into `uploadMedia`.
  - `views`: media render imports the shared package (`parsers/arweave.ts` removed); the sandboxed-app CSP `connect`/`resource` domains default to the full gateway list (was `arweave.net` only, which would block ar.io media in the iframe).
  - `rig`: re-exports the shared list/timeout (importers unchanged).

- 2bdb1b5: Fix `toon_upload` against a discovered store/DVM apex (e.g. `g.proxy.store`), which failed at several independent points on the payment path:

  - **No route to destination (F02):** `deriveApexClientConfig` now derives a per-apex `proxyUrl` from the apex `btpUrl`, so paid packets POST to the discovered apex's connector instead of the default (relay) connector, which has no route to the store's ILP prefix.
  - **Wrong apex for the ref event:** `uploadMedia` now publishes the NIP-94 reference event through the default (relay) apex rather than the upload's `btpUrl`, since a store/DVM apex only serves `POST /store`.
  - **ar.io gateway:** media URLs and the views CSP default to `https://ar-io.dev` (the canonical gateway) so uploaded media renders; `arweave.net` is retained in the CSP for back-compat.

- Updated dependencies [fec8793]
- Updated dependencies [39beb37]
- Updated dependencies [5bfae71]
  - @toon-protocol/arweave@0.1.1
  - @toon-protocol/client@0.14.2

## 0.6.1

### Patch Changes

- Updated dependencies [68e1a59]
  - @toon-protocol/client@0.14.1

## 0.6.0

### Minor Changes

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

## 0.5.0

### Minor Changes

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

## 0.4.0

### Minor Changes

- 1db36cb: Polished social feed + composer UI. NoteCard is now a real feed item — identity avatar (profile picture, else a deterministic gradient fallback with npub initials), display name (joined from kind:0 profile binds, else MonoId npub), a relative timestamp, the note body, inline media, and an engagement footer (Reply + React with live reaction counts) wired to the existing `reply`/`react` actions. The composer and pay-confirm atoms get a card surface with an auto-sizing textarea and a footer toolbar that surfaces a UTF-8 byte counter (TOON fees scale with encoded bytes); the pay-to-write flow keeps its idle→confirm→publishing→receipt phases, now restyled so the confirm step clearly shows fee + settlement chain + size and the receipt reads as a success state. Built on the existing shadcn/OKLCH tokens and lucide-react — no new deps; the atom contract, registered kinds, and inline-media rendering are unchanged. (client-mcp serves the refreshed app bundle.)

## 0.3.0

### Minor Changes

- 188ffa0: Render inline media (NIP-92 imeta) in kind:1 notes — NoteCard now displays attached images/videos beneath the note text via a shared InlineMediaList.

## 0.2.0

### Minor Changes

- bddc54d: Add branch 2 of the NIP-on-TOON render trust gradient: the A2UI declarative renderer (toon-meta#58).

  `A2UIRenderer` renders an unknown Nostr kind at **medium trust** through the client's own audited A2UI "Basic" catalog — never provider code. Per the branch-2 binding convention, the resolved `kind:31036` renderer's `content` is the A2UI `surfaceUpdate` (the durable template) and the decoded TOON event is fed in as the `dataModelUpdate` (the bound data); component props bind via `{ path: "/…" }` JSON Pointers into the event-derived data model.

  **Standard-catalog-only invariant:** `validateA2uiRenderer` is the medium-trust gate. Only the curated Basic catalog (`Text`, `Heading`, `Image`, `Icon`, `Row`, `Column`, `List`, `Card`, `Divider`) is rendered; any custom component **or** any client-defined behavior (`onClick`/`action`/validators/etc.) REFUSES and signals a drop to branch 3 (sandboxed mcp-ui) via the `A2uiGateRefuse.fallback` result — the renderer never renders a refused surface. The `["a2ui", "<version>"]` tag is checked; an unsupported version falls through gracefully (branch 1/4).

  Consumes the branch-2 `A2uiDecision` from `@toon-protocol/client`'s `renderDispatch` (#88); does not change the dispatch contract. Branches 3/4 + renderer-swap defense remain #90/#91/#92.

- 4f51ba1: Add branch 3 of the NIP-on-TOON render trust gradient: the sandboxed mcp-ui `AppRenderer` and the load-bearing **consent invariant** (toon-meta#58, toon-client#90). **Security-sensitive — see the PR for the threat model.**

  **Branch 3 (low trust).** When an unknown kind resolves to a `kind:31036` renderer tagged `m: text/html;profile=mcp-app`, the raw widget HTML is extracted (`extractUiResource` in `@toon-protocol/client`) and rendered inside a hardened, sandboxed iframe via `@mcp-ui/client`'s `AppRenderer` (`SandboxedAppRenderer` in `@toon-protocol/views`). The iframe `sandbox` attribute is overridden to **`allow-scripts` only** — notably _without_ `allow-same-origin` — so the widget runs in an opaque origin and can never reach the host DOM, storage, or the consent surface. `assertSafeSandbox` is a defensive guard against re-enabling any escape token.

  **Consent invariant.** A sandboxed widget may only _request_ an action; it may never _perform_ one or paint the authorization UI. Every `tools/call` the widget requests is classified by the trusted client (`classifyIntent`, default-deny: only a tiny read-only allowlist auto-forwards). Anything state-changing surfaces a host-rendered `ConsentPrompt` drawn **outside** the iframe, using only the client's own audited primitives. The prompt is **non-themeable by construction**: its sole input (`ConsentRequest`) carries no styling/markup field — only a tool name, plain (text-rendered, never `dangerouslySetInnerHTML`) arguments, and a client-fixed `trust: 'low'` that a widget cannot escalate. The action is performed only on an explicit user grant; a denial returns an error to the widget and performs nothing.

  `@toon-protocol/client` gains the framework-agnostic consent module (`extractUiResource`, `classifyIntent`, `buildConsentRequest`, and the `UiResource`/`WidgetIntent`/`ConsentRequest`/`ConsentDecision` types); `@toon-protocol/views` gains the React `SandboxedAppRenderer` + `ConsentPrompt` and the sandbox-hardening helpers. Consumes the branch-3 `McpUiDecision` from `renderDispatch` (#88) and accepts the `fallback: 'mcp-ui'` hand-off from the branch-2 A2UI renderer (#89); the dispatch contract is unchanged. Renderer-swap defense and branch 4 remain #91/#92.

- 25d0473: Wire the NIP-on-TOON render trust gradient into the live app render path (toon-meta#58). The gradient was previously dead code; it is now the real render path for every incoming event.

  **`@toon-protocol/views` — the gradient is now the live event render path.**

  - `buildKindRegistry()` (in `atoms/registry.ts`) builds the branch-1 `KindRegistry<Atom>` from the catalog's atom→kind metadata — the registry `guardedRenderDispatch` consults first. The generic fallback atom is deliberately not registered, so an unknown kind misses and falls through to the unknown-kind branches.
  - A new renderer resolver (`render/resolve.tsx`): `useRenderDecision(event, bridge, registry, pins)` runs the gradient per event. Known kinds short-circuit to branch 1 (native) with no relay round-trip; for an unknown kind with a `ui` coordinate it fetches candidate `kind:31036` renderers over the bridge — `toon_query { kinds: [31036], '#d': [targetKind], authors: [eventAuthor] }` — and drives `guardedRenderDispatch` once they arrive (async loading state). `rendererQueryFilter(event)` is exported.
  - `runtime.tsx`'s `EventAtom` (the kindAuto / feed render seam) now switches on the `RenderDecision`: `native` → the atom component (full trust, today's behaviour); `a2ui` → `A2UIRenderer` (medium, with generative fall-through on a gate refusal); `mcp-ui` → `SandboxedAppRenderer` with the host-rendered consent prompt (low); `generative` → `GenerativeFallbackRenderer` (low, deterministic generator; no model is wired in the app and publish-back stays off). Dispatch goes through `guardedRenderDispatch` (not bare `renderDispatch`), so author-binding + signature + anti-swap pinning apply; a session-scoped `RendererPinStore` is seeded at app scope. The explicit atom-by-id ViewSpec path (`NodeView`) is unchanged.

  **`@toon-protocol/client` — browser-safe `./render` subpath.**

  - Adds a `@toon-protocol/client/render` export (and a second tsup entry) exposing just the render trust gradient — pure dispatch + swap-defense + branch helpers that depend only on `@toon-protocol/core`'s `ui` helpers and `nostr-tools`. The views app bundle imports this subpath instead of the package root so the client's Node-only channel/transport code never enters the iframe bundle. No behaviour change to existing `@toon-protocol/client` consumers.

  **`@toon-protocol/client-mcp` — reship the rebuilt bundle.**

  - client-mcp copies `@toon-protocol/views`' prebuilt `dist/app/index.html` into its own `dist/app` at build time and serves it at `ui://toon/app`. A patch bump so a published client-mcp reships the rebuilt, gradient-wired app bundle.

### Patch Changes

- Updated dependencies [4f51ba1]
- Updated dependencies [c22d655]
- Updated dependencies [c8efd64]
- Updated dependencies [93a712a]
- Updated dependencies [5bbabfa]
- Updated dependencies [25d0473]
  - @toon-protocol/client@0.14.0

## 0.1.2

### Patch Changes

- dcb9c89: Disable the pay-confirm "Confirm & pay" button when the fee status is unavailable (`statusError`), so a user can never click through a "fee unavailable" screen into a silent spend.
- 7d9b1db: Fix note-card bind producing empty render; reject unknown bind keys

  Two bugs caused an empty white container when using `note-card` with a NIP-01 filter bind:

  1. `validateViewSpec` silently accepted unknown `bind` keys (e.g. `filter` instead of the correct `query`), so the wrong key passed validation, was ignored at runtime, and resolved to zero events.
  2. `NoteCard` used `.find()` so only the first event rendered even when a query returned many events.

  `client-mcp` is bumped so the updated views bundle (with both fixes) is republished.

## 0.1.1

### Patch Changes

- a91f5c5: Fix note-card bind producing empty render; reject unknown bind keys

  Two bugs caused an empty white container when using `note-card` with a NIP-01 filter bind:

  1. `validateViewSpec` silently accepted unknown `bind` keys (e.g. `filter` instead of the correct `query`), so the wrong key passed validation, was ignored at runtime, and resolved to zero events.
  2. `NoteCard` used `.find()` so only the first event rendered even when a query returned many events.

  `client-mcp` is bumped so the updated views bundle (with both fixes) is republished.
