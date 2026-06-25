# @toon-protocol/views

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
