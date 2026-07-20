# @toon-protocol/views

## 0.20.1

### Patch Changes

- Updated dependencies [8100f92]
  - @toon-protocol/client@0.20.1

## 0.20.0

### Patch Changes

- Updated dependencies [fb7485d]
  - @toon-protocol/client@0.20.0

## 0.19.0

### Patch Changes

- Updated dependencies [c3b34b0]
- Updated dependencies [0eaa65e]
- Updated dependencies [c816641]
  - @toon-protocol/client@0.19.0

## 0.18.0

### Patch Changes

- Updated dependencies [2eb9709]
  - @toon-protocol/client@0.18.0

## 0.17.0

### Patch Changes

- 488cdbf: Migrate to `@toon-protocol/sdk` ^2.0.0 and `@toon-protocol/core` ^2.0.0 — the
  `mill`→`swap` vocabulary rename (`millSignerAddress`→`swapSignerAddress`,
  `millEphemeralPubkey`→`swapEphemeralPubkey`, `millPubkey`→`swapPubkey`,
  `millIlpAddress`→`swapIlpAddress`; toon commit `af4cd24`, released as
  sdk/core 2.0.0). Rolling-swap prerequisite (toon-protocol/toon-meta#145).

  - `ClientRunner.swap` now calls `streamSwap` with the renamed params and reads
    `swapSignerAddress` directly off accumulated claims (the old
    mill→swap translation shim is gone).
  - **Deploy ordering:** the rename has NO wire back-compat. A pre-rename
    (sdk <2.0.0) swap peer emits `millSignerAddress` in its FULFILL settlement
    metadata, which sdk ≥2's `decodeFulfillMetadata` silently drops — the swap
    "succeeds" but its claims fail later in `buildSettlementTx` with
    `MISSING_SETTLEMENT_METADATA`. Upgrade swap peers (mills) together with
    this client (see toon-protocol/swap#45 / swap#51).
  - New early alarm: `SwapResponse.warning` is set at swap time when accepted
    claims are missing `swapSignerAddress`, instead of failing silently until
    settlement.
  - core ≥2.0.1 ships a seeded `genesis-peers.json` (live devnet apex), so a
    daemon with no relay/destination config now bootstraps from the committed
    seed (`wss://relay-ws.devnet.toonprotocol.dev` / `g.proxy`) instead of the
    `ws://localhost:7100` last-resort fallback.

- Updated dependencies [a6caf80]
- Updated dependencies [488cdbf]
  - @toon-protocol/client@0.17.0

## 0.16.0

## 0.15.0

## 0.14.1

### Patch Changes

- Updated dependencies [bc1befc]
  - @toon-protocol/client@0.16.0

## 0.14.0

### Minor Changes

- c116ca8: fix(rig,rig-web)!: honor issue/PR status only from repo owner + declared maintainers (#287)

  Issue/PR status (kind:1630-1633) was resolved naive last-write-wins over ALL
  events regardless of signer, so any funded identity could overwrite another
  owner's issue/PR state. State resolution now honors ONLY status events signed
  by an AUTHORIZED author — the repo OWNER (always) ∪ the MAINTAINERS declared on
  the kind:30617 announcement (a new `["maintainers", <hex>, …]` tag). Unauthorized
  status events are ignored for state (a permissionless relay can still carry them,
  so this is a consumer-side filter).

  - `buildRepoAnnouncement` gains an optional maintainers list; `parseMaintainers` /
    `authorizedStatusAuthors` parse it. `RemoteState.maintainers` and the views
    `RepoMetadata.maintainers` surface it.
  - `deriveStatus` (rig CLI tracker) and `resolvePRStatus` / `resolveIssueStatus`
    (views, used by rig-web) now take an authorized-author set and filter by it.
  - New `rig maintainers list|add|remove <pubkey>` command republishes the 30617
    to manage the set (owner-only, confirm-gated).
  - `rig pr status` / `issue status` warn when the active identity is not a
    maintainer (the write still publishes — permissionless — but the futility is
    made obvious).

  BREAKING: `resolvePRStatus` / `resolveIssueStatus` require a third `authorized`
  argument; `RepoMetadata` / `RemoteState` gain a required `maintainers` field.

## 0.13.2

### Patch Changes

- 671c2fc: kind:1617 PR descriptions (#280): `parsePR` surfaces the new `description`
  tag (`rig pr create --body`) as `PRMetadata.description`, the forge PR card
  shows it, and the daemon's `POST /git/patch` accepts an optional
  `description` field it forwards into the built patch event's tag — content
  stays pure `git format-patch` output for `git am`.

## 0.13.1

## 0.13.0

### Patch Changes

- Updated dependencies [68a7150]
- Updated dependencies [3f30e36]
- Updated dependencies [1ff6370]
  - @toon-protocol/client@0.15.0
  - @toon-protocol/arweave@0.2.0

## 0.12.2

### Patch Changes

- Updated dependencies [0ccd135]
  - @toon-protocol/client@0.14.12

## 0.12.1

### Patch Changes

- 74a79ca: Add surface-mode + feed-pagination capability to the view runtime (the foundation for fullscreen feeds/threads and "load more").

  - `ViewBridge` gains optional, feature-detected display-mode methods (`availableDisplayModes`, `displayMode`, `requestDisplayMode`, `onHostContextChanged`), wired to the ext-apps `App` host context. The `onHostContextChanged` subscription chains over the existing handler so it never clobbers theme following.
  - New `useDisplayMode` hook exposes `{ mode, available, canFullscreen, canPip, request }`, reactive to host-context changes and degrading to inline-only on hosts (and the mock bridge) without the capability.
  - New `nextPageFilter`/`mergePage` helpers page a feed backward in time via a free `toon_query` (NIP-01 `until`), de-duping by id — the load-more primitive for the upcoming `feed-list` atom.

- 4b0d0d2: Add a pre-authorized engagement spend-budget so cheap social micro-writes don't prompt per-action.

  Likes (kind:7), follows (kind:3) and reposts (kind:6) each settle a payment-channel claim, which makes the full per-action consent modal far too heavy for high-frequency actions. The user now approves a small allowance ONCE per session; engagement micro-writes then debit a local counter silently until it runs out, at which point we re-prompt to top up. Bigger writes (compose/post, upload, swap, channel ops) keep their per-action consent.

  - New `BudgetProvider` / `useEngagementGate` / `useEngagementBudget` (`engagement-budget.tsx`), layered over `ConsentProvider`: a one-time "allow up to X {asset}" prompt on the first engagement, a session-only debit counter (never persisted, so a stale reload can't keep spending), and a top-up re-prompt on exhaustion. It reuses the same `toon_status` fee/asset read seam and falls back to the per-action consent when the fee is unavailable.
  - The runtime routes a spendy publish through the budget gate only when it's an engagement kind (3/6/7) — scoped by event semantics, not tool name, since like/follow/repost share `toon_publish_unsigned` with compose/profile-edit. A host-injected `confirm` still wins. `BudgetProvider` is mounted in `ViewSpecRenderer` alongside `ConsentProvider`.
  - `note-card`'s engagement bar gains a subtle "remaining budget" affordance (with a tap-to-top-up control) once an allowance is authorized.

- d0b5f78: Polish the composer so it reads as part of the feed surface, not a pasted-in widget.

  - Drop the opaque `bg-card` slab for a faint `bg-muted/20` fill that goes transparent on focus, with the jade focus ring defining the input — inheriting the host surface instead of painting a heavy box against the transparent feed.
  - Hide the byte counter at rest (it's fee-relevant only once there's content), so the composer no longer shows a developer-y "0 bytes". The counter returns as soon as you type.

  Affects both the free `composer` and the `pay-confirm` idle phase (shared `ComposerSurface`). Adds a `feed-list (+ composer)` panel to the dev gallery for visual iteration.

  Also make `feed-list` PAGINATED instead of scroll/append. Claude Desktop gives the app a fixed-height iframe and scrolls the overflow rather than growing to content (verified live: it reports no `maxHeight` and does not size to the page), so any append-style feed grew into an internal scrollbar. feed-list now shows one bounded page (`PAGE_SIZE = 5`) with Newer/Older buttons that REPLACE the page — the rendered height stays roughly constant, so there is no internal scroll. Older pages are fetched on demand via a free `toon_query` (NIP-01 `until`); already-fetched pages page back instantly. The dev gallery's mock bridge advertises a fullscreen surface so other atoms' display-mode affordances can still be exercised.

- 432eca3: Add a `feed-list` atom: a bounded, scannable timeline slice that respects MCP-app host rules (no in-iframe infinite scroll).

  - Reuses `note-card` rows and adds a **"Load more"** footer that pages older notes via a free, de-duped `toon_query` (the host-blessed alternative to infinite scroll), plus an **"Open timeline"** that escalates to the host's fullscreen surface when one is available — and simply doesn't render on inline-only hosts.
  - Wires the runtime so atoms receive their `bind`, a `loadMore` paginated-query seam, and a `surface` display-mode control (provided once per view via context, so atoms read it cheaply instead of each subscribing to the host).
  - Adds a regression guard that `note-card`'s inline row caps at two actions (Reply + Like); Follow stays in the author popover.

- c0cb407: Polish the paid-write loop and harden cross-host rendering (Phase 2.4–2.6).

  - **Optimistic pending → confirmed.** After a successful paid publish, the receipt shows the note as "pending" and flips to "confirmed" once a relay serves the event back, polled via the free `toon_query` read seam (`usePublishConfirmation`/`RelayConfirmation`). A slow/absent read stays "pending (unconfirmed)" — never a false "failed" (the message was paid and broadcast). This deliberately relies on the read seam rather than a hand-rolled WS reader, which would false-negative on the devnet relay's double-JSON-encoded EVENT payloads.
  - **Media via Arweave gateway for CSP.** The MCP-app iframe CSP only allows the declared Arweave/ar.io gateway origins, so `gatewayMediaSrc` re-points Arweave-addressable media/avatar URLs onto a CSP-allowlisted gateway origin; arbitrary non-Arweave origins are left unchanged (they degrade rather than breaking the CSP).
  - **Text fallback for non-rendering hosts.** `toon_query`/`toon_read` now carry a decision-sufficient text summary (author · time · excerpt · counts) alongside `structuredContent`, and the render path names the view in text — so a text-only host that can't render the `ui://` card still gets readable, actionable content.

- 5d7f58c: Add three composed atoms: `thread-view`, `media-gallery`, and `live-ticker`.

  - **`thread-view`** — a focused conversation reconstructed from NIP-10 `e`/`p` thread tags over the bound notes. Inline it shows the focused note, its single direct parent (context), and a bounded slice of up to three direct replies (reusing `note-card` rows), plus a "View full thread (N)" affordance that escalates to the host's fullscreen surface when one is available. Fullscreen renders the whole reply tree with indentation capped at four levels; deeper chains collapse to a "continue thread →" button that re-roots them at the margin.
  - **`media-gallery`** — an Album-style responsive grid of media events (NIP-68/71/94 + NIP-92 `imeta`), one tile per event with gateway-fallback loading and guaranteed alt text; tapping a tile opens an in-component lightbox (full media via the shared embed) with prev/next paging.
  - **`live-ticker`** — a compact new-posts/mentions ticker for Picture-in-Picture. It feature-detects PiP: when `surface.canPip` it offers a "Go live" affordance (`surface.request('pip')`), otherwise it degrades to an inline snapshot plus a "Refresh" button that re-queries the base filter via the free `loadMore` seam. The item list is an `aria-live="polite"` region.

  All three are registered in both the pure catalog and the React registry (kept in sync by `registry.test.tsx`).

- 49a2e31: Make pay-to-write consent truthful and specific, and survive non-rendering hosts.

  - **Truthful fee:** `PublishResponse`/`UploadMediaResponse` now carry `feePaid` (the amount actually charged — uploads sum both the blob and reference-event legs) and `channelBalanceAfter`. The `pay-confirm` receipt shows the real fee + remaining balance instead of re-reading the per-event estimate, and the confirm step warns the write is permanent.
  - **Specific spendy consent:** the in-iframe consent modal (used by upload/swap/channel ops) reads `toon_status` and surfaces the settlement chain, the pay-to-write fee (for per-event writes), and an explicit non-refundable / irreversible warning — no more bare label.
  - **Cross-surface consent:** server `instructions` and the paid-write tool descriptions now direct a text-only host to quote the exact fee via `toon_status` and confirm the irreversible write before calling.

## 0.12.0

### Minor Changes

- b243c10: Wallet balance correctness (#199/#200), async funding, UI auto-refresh, and media posts.

  - Balances: fast-fail with correct error attribution instead of a 35s control-plane hang; always emit wrapped `structuredContent`; the views seam validates the wire contract (no silent blank); read the settlement chain (not the preset-first chain) and from an identity-level client (works with no apex).
  - Funding: async submit+poll `fund-wallet` with a `toon_fund_status` tool, a generous background faucet timeout, and a distinct `timeout` status so a slow-but-successful drip isn't reported as a failure.
  - UI: rendered views auto-refresh after any write action; the Fund button resets once the balance updates.
  - Media posts: captioned media uploader (compose → caption → publish) and an optional media/file attach on the default post composer (kind:1 with NIP-92 imeta, rendered inline); the dedicated uploader remains for upload-only.

### Patch Changes

- Updated dependencies [b243c10]
- Updated dependencies [b243c10]
  - @toon-protocol/client@0.14.11

## 0.11.0

### Minor Changes

- 48205b0: Wallet balance correctness (#199/#200), async funding, UI auto-refresh, and media posts.

  - Balances: fast-fail with correct error attribution instead of a 35s control-plane hang; always emit wrapped `structuredContent`; the views seam validates the wire contract (no silent blank); read the settlement chain (not the preset-first chain) and from an identity-level client (works with no apex).
  - Funding: async submit+poll `fund-wallet` with a `toon_fund_status` tool, a generous background faucet timeout, and a distinct `timeout` status so a slow-but-successful drip isn't reported as a failure.
  - UI: rendered views auto-refresh after any write action; the Fund button resets once the balance updates.
  - Media posts: captioned media uploader (compose → caption → publish) and an optional media/file attach on the default post composer (kind:1 with NIP-92 imeta, rendered inline); the dedicated uploader remains for upload-only.

### Patch Changes

- Updated dependencies [48205b0]
  - @toon-protocol/client@0.14.10

## 0.10.9

### Patch Changes

- Updated dependencies [cb2362b]
  - @toon-protocol/client@0.14.9

## 0.10.8

### Patch Changes

- 0f6fc74: Fix three wallet-overview bugs that made the wallet card look broken in the host iframe:

  - **Copy button was a silent no-op.** The TOON app runs in the host iframe, which
    isn't granted the `clipboard-write` permission policy, so
    `navigator.clipboard.writeText` rejects there — and the click had no rejection
    handler. `CopyButton` now falls back to the legacy `document.execCommand('copy')`
    over a hidden textarea (works in a sandboxed frame), same iframe-limitation
    class as the `window.confirm` → consent fix.
  - **Fund button gave no feedback.** Tapping "Fund" fired the faucet but the card
    never changed, so it read as broken. The button now shows a `Funding…` →
    `Requested` (or `Retry fund` on failure) state and re-reads balances after a
    successful drip.
  - **Balances rendered blank on a flaky read.** The `toon_balances` control plane
    can transiently refuse on `:8787` while the websocket transport is healthy
    (toon-client#186) — it succeeds on retry. `readBalances` now retries before
    giving up and throws on persistent failure, and `wallet-overview` shows a
    "Balances temporarily unavailable — Retry" state instead of a blank card that's
    indistinguishable from a real zero balance.

  Also fixes the daemon-side root cause of that flakiness (toon-client#186), not
  just the symptom:

  - **Stale keep-alive socket race.** The long-lived MCP server calls the localhost
    control plane infrequently, so the daemon (Node's default 5s keep-alive) reaped
    idle sockets the undici client pool still held — the next request reused a dead
    socket and failed with `ECONNRESET`, mislabeled as "daemon not reachable". The
    daemon now keeps idle sockets alive past the client's pool window
    (`keepAliveTimeout: 650s`), and the `ControlClient` transparently retries
    idempotent (GET/DELETE) requests on a transient connection failure. Mutating
    POSTs are not retried (no double publish/fund/deposit).
  - **Timeouts no longer masquerade as "daemon not reachable".** A request the
    client aborts on its own timeout (e.g. a hung on-chain balance read) is now a
    retryable `504`, so the surfaced message says "retry" instead of "the daemon
    failed to start — check the log".

## 0.10.7

## 0.10.6

### Patch Changes

- 139e405: - Feed shows media inline: `buildFeedFilter` now includes NIP-68/94 media kinds
  (20/21/22/1063) alongside kind:1, so pictures/video render interleaved with
  notes (kindAuto → media-embed), newest-first.
  - Upload guidance: the MCP server `instructions` now forcefully direct the agent
    to render the media-uploader on any upload intent (don't ask for a file/URL or
    recount history).
  - media-uploader handles ANY file, not just media: the picker accepts any type by
    default (optional `accept` prop to restrict), the publish kind is chosen from
    the file MIME (image→20, video→21, else→NIP-94 1063), and the receipt shows a
    preview for images/video and a file row + Arweave link for everything else.

## 0.10.5

## 0.10.4

## 0.10.3

### Patch Changes

- 9a40ac0: Render uploaded/feed media and surface the upload receipt.

  - **client-mcp:** advertise the Arweave gateways in the app resource's
    `_meta.ui.csp` (`resourceDomains` + `connectDomains`) on both `resources/list`
    and `resources/read`, so the host iframe's `img-src`/`media-src`/`connect-src`
    stop blocking Arweave and media actually renders (toon-client#127).
  - **views (media-uploader):** echo the publish receipt — show the uploaded
    image/video + the Arweave URL as a copyable link instead of just "completed".
  - **views (feed):** move Follow off the per-note header into a click-to-reveal
    author profile; drop the no-op Reply action; top-anchor the spend-confirm
    prompt so it isn't centered off-screen in the tall host iframe.

## 0.10.2

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

- Updated dependencies [686f7a3]
  - @toon-protocol/client@0.14.8

## 0.10.1

### Patch Changes

- 1afc5c8: Render the MCP app on a transparent page so the host's own (rounded) message
  container shows through, instead of an opaque slab with square corners boxing the
  view in. Drops the bg-tinted framed panel — keeps only inset padding + a
  reading-width cap; the atoms are self-framing rounded cards. The standalone
  gallery is unaffected (it keeps globals.css's body paint; the app overrides it in
  `main.tsx`).

## 0.10.0

### Minor Changes

- 9073156: Polish the MCP feed render to match the gallery and surface engagement:

  - Frame the app view in a rounded, bordered panel on a faintly tinted page,
    capped to a reading width and centered (was an edge-to-edge square slab).
  - Surface per-note **reply / like / follow** in `feedView` — and thread feed-node
    actions through the `kindAuto` render path (`NodeView → EventAtom →
NativeEvent`), which previously hard-coded `actions={{}}` so engagement never
    appeared in feeds. Like/follow are `spendy` (fee-confirm) paid writes.
  - Rich-text note bodies: `#hashtags`, `@`/`npub` mentions and URLs lift into the
    jade accent (URLs are real links), built as React nodes (no HTML injection).
  - Compact the empty composer, and give placeholder avatars a subtle ring.

### Patch Changes

- 24dad85: Fix the media uploader auto-rejecting every upload with `Upload failed:
cancelled` (toon-client#170).

  A spendy write (`media-uploader`'s `toon_upload`) was gated by the runtime
  through `window.confirm`. But the TOON app runs inside a host-controlled iframe
  sandboxed WITHOUT `allow-modals`, so `window.confirm()` is suppressed by the
  browser and returns `false` immediately — the consent prompt never rendered and
  the spend was silently auto-rejected _upstream_ of the daemon, before any bytes
  reached `uploadMedia`. The bare `cancelled` was then flattened into `Upload
failed: cancelled`. (Adjacent non-spendy writes — the kind:1 composer,
  `pay-confirm` — were unaffected because they confirm via rendered in-iframe UI,
  not `window.confirm`.)

  - **Wiring:** spendy consent is now a RENDERED React prompt (`spendy-consent.tsx`
    `ConsentProvider`), mounted by `ViewSpecRenderer` and awaited by the action
    runtime — so it works inside the no-`allow-modals` host iframe and never
    silently auto-rejects. (The ext-apps host exposes no native consent/elicit
    primitive to wire instead.) This also fixes the same latent bug in the spendy
    `swap-form`.
  - **UX:** a declined consent (`SPENDY_CANCELLED`) is now surfaced as a benign
    "Upload cancelled — nothing was published or paid." note rather than a scary
    "Upload failed", distinguishing a user/host cancel from a real Arweave/publish
    leg failure.

  (Co-releases `@toon-protocol/client-mcp` via the fixed group so the baked app
  bundle is republished — a views-only release would not reach Claude Desktop.)

- Updated dependencies [b56fefb]
  - @toon-protocol/client@0.14.7

## 0.9.1

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

- Updated dependencies [d93211a]
  - @toon-protocol/client@0.14.6

## 0.9.0

### Minor Changes

- 0e08607: Render the MCP app in TOON's own theme instead of adopting the host's. The
  iframe entry (`app-entry.tsx`) previously called `useHostStyleVariables` and
  `useHostFonts`, which let Claude Desktop's palette and fonts override the views
  design tokens — so the in-chat render looked like generic chat chrome rather
  than the jade-primary / cool-slate / Geist-Mono "ledger" theme shown in the
  standalone views gallery. Drop both hooks so `globals.css` always wins.

  The app still **follows the host's light/dark preference** — but by mirroring it
  onto the views `.dark` class (via `app.getHostContext().theme` +
  `onhostcontextchanged`) rather than adopting the host palette, so inside dark
  Claude the views _dark_ theme engages and matches the gallery's dark mode (with
  an OS `prefers-color-scheme` fallback when the host reports no theme).

  (Co-releases client-mcp via the fixed group so the baked app bundle is
  republished.)

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
