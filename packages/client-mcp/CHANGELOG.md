# @toon-protocol/client-mcp

## 0.14.1

## 0.14.0

## 0.13.2

### Patch Changes

- 671c2fc: kind:1617 PR descriptions (#280): `parsePR` surfaces the new `description`
  tag (`rig pr create --body`) as `PRMetadata.description`, the forge PR card
  shows it, and the daemon's `POST /git/patch` accepts an optional
  `description` field it forwards into the built patch event's tag — content
  stays pure `git format-patch` output for `git am`.

## 0.13.1

### Patch Changes

- c9889d6: Depend on `@toon-protocol/rig` (renamed from `@toon-protocol/git`; the SPA formerly named `@toon-protocol/rig` is now the private `@toon-protocol/rig-web`). No runtime behavior change — imports and the daemon git routes now resolve from the renamed package. (#247)

## 0.13.0

### Minor Changes

- 68a7150: Daemon `/git/*` routes + Publisher implementation + ControlClient methods (#227).

  The daemon is now the paid transport for the Rig write path (epic #222):

  - **Routes** (loopback control API): `POST /git/estimate` (plan + price a
    push without paying — serialized `PushPlan`, bigint fees as decimal
    strings), `POST /git/push` (requires `confirm: true`; uploads the object
    delta as kind:5094 store writes and publishes kind:30617/30618 — returns
    per-step receipts + total fees), and `POST /git/issue | /git/comment |
/git/patch | /git/status` (kind:1621/1622/1617/1630-1633 paid publishes;
    `/git/patch` accepts literal `patchText` or `repoPath`+`range` and runs
    real `git format-patch`). planPush's structured errors surface as clean
    JSON: 409 `non_fast_forward` (with `refs`), 413 `oversize_objects` (with
    per-object sha/type/size/path), 400 `git_error` for plumbing failures.
  - **Publisher impl** in `ClientRunner`: `getFeeRates` from the apex config
    (flat `feePerEvent` + the network per-byte upload rate), `uploadGitObject`
    as a Git-SHA/Git-Type/Repo-tagged kind:5094 store write signed with the
    daemon key and paid via `signBalanceProof` on the apex channel (Arweave
    txId decoded from the FULFILL HTTP envelope), `publishEvent` through the
    production paid publish path.
  - **ControlClient**: matching typed `gitEstimate/gitPush/gitIssue/gitComment/
gitPatch/gitStatus` methods (push gets a generous wire budget), and
    `ControlApiError` now carries structured error `data` (e.g. the rejected
    refs of a non-fast-forward).

  The MCP tool surface (`toon_git_*`) lands separately in #230.

- ecfcc3c: `toon_git_*` MCP tools over the daemon `/git/*` routes (#230, epic #222).

  The Rig write path is now agent-drivable from any MCP host:

  - **`toon_git_push`** `{repoPath, repoId?, refspecs?, force?, relayUrls?,
dry_run?, confirm?}` — two-step by construction: `dry_run: true` hits
    `/git/estimate` only (free) and returns the itemized plan (ref updates +
    per-object/event fee table); a real push REQUIRES `confirm: true` and is
    refused otherwise. The tool description mandates quoting
    `estimate.totalFee` from a dry_run and getting explicit user confirmation
    first — pushes are permanent and non-refundable. `repoId` defaults to the
    basename of `repoPath`. Text responses compact the per-object manifest to
    counts; the full plan/receipts ride `structuredContent`.
  - **`toon_git_issue` / `toon_git_comment` / `toon_git_patch` /
    `toon_git_status`** — single paid event publishes (kind:1621/1622/1617/
    1630-1633) taking flattened `repoOwnerPubkey`+`repoId`; descriptions carry
    the per-event fee-quoting + confirmation policy matching toon_publish.
  - **Structured errors surfaced as compact JSON**: `non_fast_forward` includes
    the rejected `refs` and a force-after-user-confirmation hint;
    `oversize_objects` lists the offending paths/sizes and references the paid
    blob-storage follow-up (#235); funding (402) remediation passes through
    verbatim.
  - All five tools are annotated as paid/destructive writes, and the server
    `instructions` extend the paid-write confirmation policy to them.

### Patch Changes

- 1ff6370: Purge pet-game era code and disambiguate "control plane" naming.

  **Breaking (`@toon-protocol/client`):** the pet DVM/marketplace module (`src/pet/`) is removed along with its public exports — `filterPetDvmProviders`, `buildPetInteractionRequest`, `parsePetInteractionResult`, `parsePetInteractionEvent`, `buildPetListingEvent`, `parsePetListing`, `filterPetListings`, `buildPetPurchaseRequest`, and the associated types (`PetDvmProvider`, `PetInteractionRequestParams`, `PetInteractionResultData`, `PetInteractionEventData`, `InteractionResultContent`, `UnsignedNostrEvent`, `StatValues`, `ProofStatus`, `PetListingParams`, `PetListing`, `PetListingFilterOptions`, `PetPurchaseRequestParams`). These were orphaned helpers for the archived pet-game product; nothing in this repo consumes them.

  `@toon-protocol/client-mcp`: docs/comments only — the loopback daemon HTTP surface is now consistently called the "control API" (matching the components table) instead of "control plane", which is reserved for the Rig (the browser-only decentralized control plane). No code identifiers or behavior changed.

## 0.12.2

### Patch Changes

- 0ccd135: Surface an actionable error when the one-time on-chain payment-channel OPEN reverts because the local settlement wallet has no native gas. The client now throws a tagged `ChannelFundingError` (remapped at the origin in `OnChainChannelClient.openEvmChannel`, covering both publish and upload paths) instead of leaking the raw viem "…exceeds the balance of the account" string; the daemon maps it to HTTP 402 `insufficient_gas` (retryable), and the MCP tools surface the "fund the wallet and retry" remedy verbatim instead of a misleading "still bootstrapping" hint. Per-write settlement is unaffected (it rides ILP-over-HTTP and never spends gas) — this only improves the message on the one-time channel-open funding step (toon-meta#65).

## 0.12.1

### Patch Changes

- 6fe9d0d: Add MCP tool annotations (`readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint`) to every tool so MCP-Apps hosts can auto-run free reads and gate paid/irreversible writes. Free reads are read-only (relay/chain readers flagged open-world); `toon_publish`/`toon_publish_unsigned`/`toon_upload`/`toon_swap` are destructive writes; `toon_channel_close` is destructive, `toon_open_channel` idempotent; config edits are reversible. A load-time guard keeps the matrix consistent with the UI-fireable `WRITE_TOOLS` set.
- c0cb407: Polish the paid-write loop and harden cross-host rendering (Phase 2.4–2.6).

  - **Optimistic pending → confirmed.** After a successful paid publish, the receipt shows the note as "pending" and flips to "confirmed" once a relay serves the event back, polled via the free `toon_query` read seam (`usePublishConfirmation`/`RelayConfirmation`). A slow/absent read stays "pending (unconfirmed)" — never a false "failed" (the message was paid and broadcast). This deliberately relies on the read seam rather than a hand-rolled WS reader, which would false-negative on the devnet relay's double-JSON-encoded EVENT payloads.
  - **Media via Arweave gateway for CSP.** The MCP-app iframe CSP only allows the declared Arweave/ar.io gateway origins, so `gatewayMediaSrc` re-points Arweave-addressable media/avatar URLs onto a CSP-allowlisted gateway origin; arbitrary non-Arweave origins are left unchanged (they degrade rather than breaking the CSP).
  - **Text fallback for non-rendering hosts.** `toon_query`/`toon_read` now carry a decision-sufficient text summary (author · time · excerpt · counts) alongside `structuredContent`, and the render path names the view in text — so a text-only host that can't render the `ui://` card still gets readable, actionable content.

- 49a2e31: Make pay-to-write consent truthful and specific, and survive non-rendering hosts.

  - **Truthful fee:** `PublishResponse`/`UploadMediaResponse` now carry `feePaid` (the amount actually charged — uploads sum both the blob and reference-event legs) and `channelBalanceAfter`. The `pay-confirm` receipt shows the real fee + remaining balance instead of re-reading the per-event estimate, and the confirm step warns the write is permanent.
  - **Specific spendy consent:** the in-iframe consent modal (used by upload/swap/channel ops) reads `toon_status` and surfaces the settlement chain, the pay-to-write fee (for per-event writes), and an explicit non-refundable / irreversible warning — no more bare label.
  - **Cross-surface consent:** server `instructions` and the paid-write tool descriptions now direct a text-only host to quote the exact fee via `toon_status` and confirm the irreversible write before calling.

- ae0191b: Cache-bust the `ui://toon/app` resource by versioning its URI with a hash of the bundle. Hosts (Claude Desktop) prefetch and cache the UI template keyed by its URI and do not re-fetch it across server restarts — so a rebuilt bundle was never picked up and the iframe stayed stale indefinitely. The server now derives `ui://toon/app?v=<bundle-hash>` at startup and uses it for `resources/list`, `resources/read`, and `toon_render`'s `_meta.ui.resourceUri`; every rebuild yields a new URI the host has never cached (forcing a fresh fetch), while an unchanged bundle keeps the same URI. `resources/read` also accepts the bare base URI in case a host strips the query.

## 0.12.0

### Minor Changes

- b243c10: Wallet balance correctness (#199/#200), async funding, UI auto-refresh, and media posts.

  - Balances: fast-fail with correct error attribution instead of a 35s control-plane hang; always emit wrapped `structuredContent`; the views seam validates the wire contract (no silent blank); read the settlement chain (not the preset-first chain) and from an identity-level client (works with no apex).
  - Funding: async submit+poll `fund-wallet` with a `toon_fund_status` tool, a generous background faucet timeout, and a distinct `timeout` status so a slow-but-successful drip isn't reported as a failure.
  - UI: rendered views auto-refresh after any write action; the Fund button resets once the balance updates.
  - Media posts: captioned media uploader (compose → caption → publish) and an optional media/file attach on the default post composer (kind:1 with NIP-92 imeta, rendered inline); the dedicated uploader remains for upload-only.

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

## 0.11.0

### Minor Changes

- 48205b0: Wallet balance correctness (#199/#200), async funding, UI auto-refresh, and media posts.

  - Balances: fast-fail with correct error attribution instead of a 35s control-plane hang; always emit wrapped `structuredContent`; the views seam validates the wire contract (no silent blank); read the settlement chain (not the preset-first chain) and from an identity-level client (works with no apex).
  - Funding: async submit+poll `fund-wallet` with a `toon_fund_status` tool, a generous background faucet timeout, and a distinct `timeout` status so a slow-but-successful drip isn't reported as a failure.
  - UI: rendered views auto-refresh after any write action; the Fund button resets once the balance updates.
  - Media posts: captioned media uploader (compose → caption → publish) and an optional media/file attach on the default post composer (kind:1 with NIP-92 imeta, rendered inline); the dedicated uploader remains for upload-only.

## 0.10.9

### Patch Changes

- cb2362b: Rename legacy `town` node-type label to `relay` in comments, docs, and config keys.
- a8c3010: Make the wallet card actually show balances (follow-up to #194 / #186).

  #194 fixed the wallet UI and the daemon-side flakiness, but balances still
  rendered blank because the tool results carried no `structuredContent`:

  - **`toon_balances` / `toon_channels` returned text only.** The MCP-app iframe
    bridge surfaces _only_ a tool's `structuredContent` as the data atoms read, so
    the `readBalances` / `readChannels` seams got `undefined` → `wallet-overview`
    showed addresses but no balance/USDC and no error (an empty read is
    indistinguishable from a real zero), and deposit/withdraw/publish receipts came
    back blank. Centralized the fix in the `ok()` tool-result helper so it mirrors
    object payloads into `structuredContent` (text unchanged; fixes the whole
    class at once). Tests now assert `structuredContent`, the contract the
    text-only tests missed.
  - **Balance read no longer long-spins.** On-chain reads can be slow on devnet
    RPCs; the balance read is now capped at 12s (vs the 35s default) via a
    per-request timeout override, so the card resolves — or shows its Retry state —
    in a few seconds instead of spinning.

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

### Patch Changes

- 4eeb9e5: Add a stable, version-less download URL for the Claude Desktop extension (`releases/download/mcpb-latest/toon.mcpb`) and a Desktop install section to the README.

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

### Patch Changes

- db1a8c8: Package the client-mcp server as a Claude Desktop extension (`.mcpb`) and build it automatically on every publish. The same server that ships to Claude Code via the plugin now installs one-click on Claude Desktop (Settings → Extensions). Build locally with `pnpm --filter @toon-protocol/client-mcp mcpb`.

## 0.10.4

### Patch Changes

- cd8ccd2: Fix Arweave media still not rendering despite the CSP allowlist (toon-client#127):
  ar.io / arweave.net gateways 302-redirect the apex URL to a per-tx **sandbox
  subdomain** (`https://<base32>.arweave.net/<txId>`), and CSP `img-src` is checked
  against the redirect target — so an apex-only allowlist still blocks the image.
  Advertise a wildcard subdomain (`https://*.arweave.net`, `https://*.ar-io.dev`, …)
  alongside the apex in the app resource's `_meta.ui.csp`.

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

## 0.10.1

## 0.10.0

### Minor Changes

- 1830a5d: `toon_upload` can now source media bytes from an on-disk `filePath` instead of
  inline `dataBase64`. Agent callers previously had to materialize the entire
  base64 payload as a tool argument and stream it through the model context
  (slow, context-heavy, scaling linearly with file size). The new optional
  `filePath` field on `UploadMediaRequest` / the `toon_upload` tool schema lets
  the daemon `fs.readFile` the bytes off disk instead.

  Supply EXACTLY ONE of `filePath` | `dataBase64`; both-or-neither is rejected
  with `InvalidPayloadError` (HTTP 400). `dataBase64` is retained for backward
  compatibility. The path is resolved and, when an upload root is configured
  (`TOON_CLIENT_UPLOAD_ROOT` env / `uploadAllowedRoot` config), must resolve
  inside it — bounding which filesystem locations the daemon reads on an agent's
  behalf.

### Patch Changes

- b56fefb: Solana channel deposit (PR B.1).

  Extract `depositSolanaChannel` from the open flow's post-init `deposit`
  instruction and wire it into `OnChainChannelClient.depositToChannel` so
  `toon_channel_deposit` now works on Solana (incremental: the new total is the
  tracked current plus the delta). EVM was added in PR B; Mina deposit (o1js)
  remains a follow-up. No daemon/views changes — that layer is chain-agnostic.

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

## 0.9.0

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

- 5838b79: Read live on-chain wallet balances (`toon_balances`).

  Adds a read-only `WalletBalanceReader` (EVM ERC-20 `balanceOf` via viem; Solana
  SPL via `getTokenAccountsByOwner`; native MINA via GraphQL) and
  `ToonClient.getBalances()` — best-effort per chain, no signing or payment. Wires
  it end-to-end through the daemon: `GET /balances`, `ControlClient.balances()`,
  and the `toon_balances` MCP tool. The `wallet-overview` atom's balances now
  resolve live (it already worked from the identity addresses).

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
