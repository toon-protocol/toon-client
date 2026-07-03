/**
 * Shared request/response contract for the `toon-clientd` localhost control
 * plane. Both the daemon (server) and the MCP server / control-client (caller)
 * import these types so the wire shape stays in lockstep.
 *
 * Every endpoint is plain JSON over HTTP on `127.0.0.1:<port>`. The daemon owns
 * the long-lived BTP session + payment channels + relay subscription; callers
 * are stateless and never see chain keys.
 */

import type { NostrEvent } from 'nostr-tools/pure';
import type { SwapPair } from '@toon-protocol/core';

/** The chain family a paid write settles on. */
export type SettlementChain = 'evm' | 'solana' | 'mina';

/** Per-chain settlement readiness, mirrored from `ToonClient.getNetworkStatus()`. */
export interface ChainStatus {
  chain: string;
  /** Whether settlement is configured + the apex can verify inbound claims. */
  ready: boolean;
  detail?: string;
}

/** `GET /status` — daemon + connection health. */
export interface StatusResponse {
  /** Daemon process uptime, ms. */
  uptimeMs: number;
  /**
   * True while the BTP session / channel are still coming up. Tools should
   * surface "bootstrapping — retry" rather than blocking.
   */
  bootstrapping: boolean;
  /** True once the client has started and a channel is open (ready to publish). */
  ready: boolean;
  /** The active settlement chain for paid writes to the apex. */
  settlementChain: SettlementChain;
  /** Per-event fee in base (micro) units, as a decimal string. */
  feePerEvent: string;
  /** Human-readable asset code for the fee (e.g. 'USDC'), when known. */
  asset?: string;
  identity: {
    nostrPubkey: string;
    evmAddress?: string;
    solanaAddress?: string;
    minaAddress?: string;
  };
  transport: {
    type: 'direct';
    btpUrl?: string;
  };
  relay: {
    url: string;
    connected: boolean;
    /** Number of events currently held in the read buffer. */
    buffered: number;
    /** Active subscription ids. */
    subscriptions: string[];
  };
  /** Per-chain settlement status when a named `network` tier is configured. */
  network?: ChainStatus[];
  /** Last error observed during bootstrap, if any (non-fatal). */
  lastError?: string;
  /**
   * Optional-route capabilities this daemon build serves, so a version-skewed
   * client can gate BEFORE it commits to a route that a stale daemon 404s.
   * Currently: `'git'` — the `/git/estimate|push|issue|comment|patch|status`
   * write path (added in #227). ABSENT on daemons older than the field itself,
   * which a client MUST treat as "capability not present" (fail closed). A
   * daemon must be RESTARTED to advertise a newly-added capability.
   */
  capabilities: DaemonCapability[];
}

/** A named optional-route capability advertised via `/status.capabilities`. */
export type DaemonCapability = 'git';

/** `POST /publish` — pay-to-write a single Nostr event. */
export interface PublishRequest {
  /** A fully-signed Nostr event (id + sig present). */
  event: NostrEvent;
  /** ILP destination override (default: the configured apex/relay address). */
  destination?: string;
  /** Fee override in base units. Defaults to the daemon's configured fee. */
  fee?: string;
  /**
   * Which apex (BTP write target) to publish through. Defaults to the
   * config-seeded apex. Writes always go through BTP — never to a relay
   * directly — so this selects among the registered apexes, not relays.
   */
  btpUrl?: string;
}

export interface PublishResponse {
  eventId: string;
  /** FULFILL response data (base64), e.g. an Arweave tx id from a DVM. */
  data?: string;
  /** Channel the claim was signed against. */
  channelId: string;
  /** Channel nonce after this publish (advances by one per paid write). */
  nonce: number;
  /**
   * The fee actually paid for this write, in base (micro) units, as a decimal
   * string. The truthful amount the claim advanced by — surface this in
   * receipts / text fallback instead of re-reading the per-event estimate.
   */
  feePaid: string;
  /**
   * Available (spendable) channel balance after this write, base units, when
   * known. Lets a receipt / non-rendering host report the post-write balance.
   */
  channelBalanceAfter?: string;
}

/**
 * `POST /publish-unsigned` — build, SIGN (with the daemon-held key), and
 * pay-to-write a Nostr event. The caller (a UI/agent) supplies only the event
 * shell — it never holds the private key. For replaceable kinds (0 profile,
 * 3 follow list) the daemon merges the latest known event's tags before signing.
 */
export interface PublishUnsignedRequest {
  /** Event kind to publish (integer, 0–65535). */
  kind: number;
  /** Event content (default ''). */
  content?: string;
  /** Event tags (array of string arrays). */
  tags?: string[][];
  /** ILP destination override (default: the configured apex/relay address). */
  destination?: string;
  /** Fee override in base units. Defaults to the daemon's configured fee. */
  fee?: string;
  /** Which apex (BTP write target) to publish through (default: config-seeded). */
  btpUrl?: string;
}

/**
 * `POST /upload-media` — two-step spendy write: upload bytes to Arweave via the
 * kind:5094 blob-storage DVM, then sign+publish a media event referencing the
 * resulting Arweave URL. Single-packet only (large media is out of scope; see
 * `requestBlobStorage`).
 */
export interface UploadMediaRequest {
  /**
   * Base64-encoded media bytes. Mutually exclusive with `filePath`: supply
   * EXACTLY ONE. Inline base64 streams the whole payload through the model
   * context — prefer `filePath` for anything but tiny blobs.
   */
  dataBase64?: string;
  /**
   * Absolute path the daemon `fs.readFile`s to source the media bytes off disk
   * (avoids materializing base64 as a tool argument). Mutually exclusive with
   * `dataBase64`: supply EXACTLY ONE. The path is resolved and, when an upload
   * root is configured (`TOON_CLIENT_UPLOAD_ROOT` / `uploadAllowedRoot`), must
   * resolve inside it.
   */
  filePath?: string;
  /** MIME type (default 'application/octet-stream'). */
  mime?: string;
  /**
   * Kind of the media event to publish referencing the upload. Default 1063
   * (NIP-94 file metadata). 20 = NIP-68 picture, 21/22 = NIP-71 video, 1 = note
   * with a NIP-92 `imeta` attachment.
   */
  kind?: number;
  /** Caption / content for the published media event. */
  caption?: string;
  /** Extra tags merged into the published media event. */
  tags?: string[][];
  /** Fee override in base units (applies to the upload + the publish). */
  fee?: string;
  /** Which apex to publish through (default: config-seeded). */
  btpUrl?: string;
}

export interface UploadMediaResponse extends PublishResponse {
  /** Arweave URL the media event references. */
  url: string;
  /** Arweave transaction id of the uploaded blob. */
  txId: string;
}

/** `POST /subscribe` — register a persistent free-read subscription. */
export interface SubscribeRequest {
  /** NIP-01 filter(s). A single object or an array of OR-ed filters. */
  filters: NostrFilter | NostrFilter[];
  /** Optional caller-supplied subscription id (else one is generated). */
  subId?: string;
  /**
   * Restrict the subscription to a single relay. Omit to FAN OUT across every
   * registered relay (the same subId is registered on each); reads merge into
   * one ordered stream.
   */
  relayUrl?: string;
}

export interface SubscribeResponse {
  subId: string;
  /** The relays the subscription was registered on. */
  relays: string[];
}

/**
 * `POST /query` — one-shot free read: subscribe the filter(s), wait briefly, and
 * return every buffered event matching them. Used by the apps `toon_query` tool.
 */
export interface QueryRequest {
  filters: NostrFilter | NostrFilter[];
  /** Bounded wait for relay delivery, ms (default 1200). */
  timeoutMs?: number;
}

export interface QueryResponse {
  events: NostrEvent[];
}

/** `GET /events` — drain buffered events for a subscription (free read). */
export interface EventsQuery {
  /** Restrict to a single subscription id. */
  subId?: string;
  /** Cursor from a prior `EventsResponse.cursor`; returns only newer events. */
  cursor?: number;
  /** Max events to return (default 200). */
  limit?: number;
  /** Restrict the drain to events received from a single relay. */
  relayUrl?: string;
}

export interface EventsResponse {
  events: NostrEvent[];
  /** Opaque monotonic cursor; pass back to fetch only events after these. */
  cursor: number;
  /** Whether more events remain beyond `limit`. */
  hasMore: boolean;
}

/** `POST /channels` — open (or return existing) a payment channel. */
export interface OpenChannelRequest {
  /** ILP destination of the peer to open against (default: configured apex). */
  destination?: string;
}

export interface ChannelInfo {
  channelId: string;
  nonce: number;
  cumulativeAmount: string;
  /** On-chain collateral locked in the channel, base (micro) units, decimal. */
  depositTotal?: string;
  /** Spendable balance = depositTotal − cumulativeAmount (clamped ≥ 0), decimal. */
  availableBalance?: string;
  /** Where the channel sits in the withdraw journey. */
  closeState?: 'open' | 'closing' | 'settleable' | 'settled';
  /** Unix SECONDS the channel becomes settleable, when closing. */
  settleableAt?: string;
}

/** `GET /channels` — list tracked channels with nonce watermarks. */
export interface ChannelsResponse {
  channels: ChannelInfo[];
}

/** One on-chain wallet token balance, per configured chain. */
export interface BalanceInfo {
  /** Chain family (`'evm'` | `'solana'` | `'mina'`). */
  chain: string;
  /** The wallet address holding the balance. */
  address: string;
  /** Token amount in base (micro) units, decimal string. */
  amount: string;
  /** Human asset code, e.g. `'USDC'` / `'MINA'`, when resolved. */
  asset?: string;
  /** Token decimal places, when resolved. */
  assetScale?: number;
}

/** `GET /balances` — on-chain wallet balances per configured chain. */
export interface BalancesResponse {
  balances: BalanceInfo[];
}

/** `POST /channels/deposit` — add collateral to an open channel. */
export interface ChannelDepositRequest {
  /** The channel to deposit into. */
  channelId: string;
  /** Delta to add, base (micro) units, decimal string. */
  amount: string;
}

export interface ChannelDepositResponse {
  channelId: string;
  /** On-chain tx hash / signature, when the chain returns one. */
  txHash?: string;
  /** New on-chain deposit total after the deposit, base units, decimal. */
  depositTotal: string;
}

/** `POST /channels/close` — begin the settlement grace period (withdraw, step 1). */
export interface CloseChannelRequest {
  channelId: string;
}

export interface CloseChannelResponse {
  channelId: string;
  txHash?: string;
  /** Unix SECONDS when close was initiated. */
  closedAt: string;
  /** Unix SECONDS the channel becomes settleable (closedAt + settlementTimeout). */
  settleableAt: string;
}

/** `POST /channels/settle` — release collateral after the grace period (step 2). */
export interface SettleChannelRequest {
  channelId: string;
}

export interface SettleChannelResponse {
  channelId: string;
  txHash?: string;
}

/**
 * `POST /swap` — pay asset A to a swap peer, receive asset B + a signed
 * target-chain claim. The daemon builds the NIP-59 gift-wrapped kind:20032 swap
 * rumor and streams it via SDK `streamSwap`, signing the source-asset claim
 * against the open apex channel (the swap peer must be routed via
 * `apexChildPeers`).
 */
export interface SwapRequest {
  /** Swap peer ILP destination (e.g. `g.proxy.swap`). */
  destination: string;
  /** Total source-asset amount to swap, in source micro-units. */
  amount: string;
  /** Swap peer's 64-char lowercase hex Nostr pubkey (NIP-59 gift-wrap recipient). */
  swapPubkey: string;
  /**
   * The swap pair to execute — from kind:10032 discovery, or operator-supplied
   * when the swap peer announces pairs to a relay other than the default relay.
   */
  pair: SwapPair;
  /**
   * Sender's payout address on `pair.to.chain` (EVM 0x-hex / Solana or Mina
   * base58). Echoed on every rumor as the `chain-recipient` tag.
   */
  chainRecipient: string;
  /** Split the swap into N equal packets (default 1). */
  packetCount?: number;
  /**
   * Which apex to settle the source-asset claim through (default: the
   * config-seeded apex). The swap peer must be a child peer of this apex.
   */
  btpUrl?: string;
}

/** One accumulated, decrypted claim harvested from a single swap packet. */
export interface SwapClaim {
  /** Source-asset amount sent for this packet (micro-units, decimal). */
  sourceAmount: string;
  /** Target-asset amount claimed (micro-units, decimal). */
  targetAmount: string;
  /** Decrypted signed target-chain claim bytes, base64. */
  claim: string;
  /** Target-chain channel id (real on-chain id, or a dev placeholder). */
  channelId?: string;
  /** Sender's payout address echoed by the swap peer. */
  recipient?: string;
  /** Swap peer's on-chain signer address. */
  swapSignerAddress?: string;
  /** Swap-side claim id. */
  claimId?: string;
  /** Balance-proof nonce on the target channel (decimal). */
  nonce?: string;
  /** Cumulative transferred on the target channel (micro-units, decimal). */
  cumulativeAmount?: string;
}

export interface SwapResponse {
  /** True when at least one packet FULFILLed with a usable claim. */
  accepted: boolean;
  /** Number of packets the swap peer FULFILLed. */
  packetsAccepted: number;
  /** Per-packet accumulated claims (settlement metadata + signed claim). */
  claims: SwapClaim[];
  /** Total source sent across accepted packets (micro-units, decimal). */
  cumulativeSource: string;
  /** Total target received across accepted packets (micro-units, decimal). */
  cumulativeTarget: string;
  /** Final stream state. */
  state: 'completed' | 'failed' | 'stopped';
  /** First rejection code from the swap peer, if any (e.g. `F99`). */
  code?: string;
  /** First rejection message, if any. */
  message?: string;
}

/**
 * `POST /http-fetch-paid` — payment-aware HTTP GET/POST. The daemon issues the
 * request via `ToonClient.h402Fetch`; if the origin answers `402 Payment
 * Required` the client transparently pays over TOON and retries, returning the
 * settled resource. The caller never holds chain keys — settlement happens
 * inside the daemon against the open apex channel.
 */
export interface HttpFetchPaidRequest {
  /** Absolute URL of the resource to fetch (the origin may gate it behind 402). */
  url: string;
  /** HTTP method (default GET). */
  method?: string;
  /** Request headers as a flat string→string map. */
  headers?: Record<string, string>;
  /** Request body (string; sent verbatim). Typically used with POST. */
  body?: string;
  /** Per-request timeout, ms (passed through to the client). */
  timeout?: number;
}

export interface HttpFetchPaidResponse {
  /** Final HTTP status after any 402-pay-and-retry round trip. */
  status: number;
  /** Response headers as a flat string→string map. */
  headers: Record<string, string>;
  /**
   * Response body decoded as text. Binary bodies are returned as their decoded
   * text for v1 (acceptable; a base64 path can be added later if needed).
   */
  body: string;
}

// ── Dynamic targets (1-to-many: many apexes to write through, many relays to
//    read from). Added at runtime, persisted across restarts, removable. ──────

/** `POST /relays` — add a relay READ target (fans into all fan-out reads). */
export interface AddRelayRequest {
  /** Relay WS URL, e.g. `ws://host:7100`. */
  relayUrl: string;
}

/** `DELETE /relays` — remove a relay read target. */
export interface RemoveRelayRequest {
  relayUrl: string;
}

/**
 * `POST /apex` — add an apex WRITE target. Settlement params are DISCOVERED by
 * reading the apex's `kind:10032` announcement off a relay, so the caller never
 * hand-supplies chain/settlement details.
 */
export interface AddApexRequest {
  /** ILP address of the apex to add (e.g. `g.proxy`). */
  ilpAddress: string;
  /**
   * Relay to discover the apex's `kind:10032` on. If it isn't already a read
   * target it is added (and persisted) first.
   */
  relayUrl: string;
  /** Optional apex Nostr pubkey to narrow the discovery filter (64-char hex). */
  pubkey?: string;
  /** Preferred settlement chain family; defaults to the apex's first chain. */
  chain?: SettlementChain;
  /** Child peers reached via this apex's channel (e.g. `["store","swap"]`). */
  childPeers?: string[];
  /** Per-write fee override (base units) for this apex. */
  feePerEvent?: string;
}

export interface AddApexResponse {
  btpUrl: string;
  destination: string;
  chain: SettlementChain;
  /** Whether the apex bootstrapped + opened a channel by the time we replied. */
  ready: boolean;
}

/** `DELETE /apex` — remove an apex write target by its BTP URL. */
export interface RemoveApexRequest {
  btpUrl: string;
}

/** Status of one registered relay read target. */
export interface RelayTargetStatus {
  relayUrl: string;
  connected: boolean;
  buffered: number;
  subscriptions: string[];
  /** True for the permanent config-seeded relay (not removable). */
  isDefault: boolean;
}

/** Status of one registered apex write target. */
export interface ApexTargetStatus {
  btpUrl: string;
  destination: string;
  chain: SettlementChain;
  ready: boolean;
  bootstrapping: boolean;
  channelId?: string;
  lastError?: string;
  /** True for the permanent config-seeded apex (not removable). */
  isDefault: boolean;
}

/** `GET /targets` — list every registered relay + apex target. */
export interface TargetsResponse {
  relays: RelayTargetStatus[];
  apexes: ApexTargetStatus[];
}

/**
 * `POST /fund-wallet` — drip devnet test funds to a chain address from the
 * daemon's configured faucet. Both fields are optional: `chain` defaults to the
 * active settlement chain and `address` to this client's own address on that
 * chain, so a no-arg call funds the caller's own wallet.
 */
export interface FundWalletRequest {
  /** Chain to fund (default: the active settlement chain). */
  chain?: SettlementChain;
  /** Address to fund (default: this client's own address for `chain`). */
  address?: string;
}

/**
 * `POST /fund-wallet` result — a snapshot of an ASYNC faucet drip job.
 *
 * The drip is non-blocking: `POST /fund-wallet` launches the faucet call in the
 * daemon background and returns immediately with `status: 'pending'`. This avoids
 * the MCP host's ~60s tool-call timeout surfacing a still-working Mina drip
 * (which legitimately settles in ~75s, native MINA + USDC) as a misleading
 * relay/apex timeout (#199-class). Poll `GET /fund-wallet/status` (or just
 * re-read balances) to observe the terminal `'success'` / `'error'` state.
 */
export interface FundWalletResponse {
  /** The chain being funded. */
  chain: SettlementChain;
  /** The address being funded. */
  address: string;
  /** The faucet base URL the drip was requested from. */
  faucetUrl: string;
  /**
   * Lifecycle of the background drip. `'timeout'` is distinct from `'error'`:
   * the faucet client gave up but the on-chain drip MAY still have settled
   * (observed on a loaded EVM faucet) — treat it as "uncertain, re-check
   * balances", not a definitive failure, to avoid a misleading double-fund.
   */
  status: 'pending' | 'success' | 'error' | 'timeout';
  /** Unix ms the drip was submitted. */
  startedAt: number;
  /** Unix ms the drip settled or failed (absent while `'pending'`). */
  finishedAt?: number;
  /** Raw parsed JSON body from the faucet on success (shape is faucet-defined). */
  response?: unknown;
  /** Error message on failure. */
  error?: string;
}

/** `GET /fund-wallet/status` result — snapshots of tracked drip jobs. */
export interface FundStatusResponse {
  jobs: FundWalletResponse[];
}

// ── Git write path (`/git/*`) — the daemon surface of the Rig push pipeline
//    (epic #222, ticket #227). Planning/execution live in @toon-protocol/rig;
//    these are the JSON wire shapes (bigints as decimal strings, Maps as
//    plain records). ─────────────────────────────────────────────────────────

/** NIP-34 repository address: the owner+id pair behind `a` tags. */
export interface GitRepoAddr {
  /** Repository owner's Nostr pubkey (64-char hex) — author of kind:30617/30618. */
  ownerPubkey: string;
  /** Repository identifier (NIP-34 `d` tag). */
  repoId: string;
}

/**
 * `POST /git/estimate` — plan a push (local git plumbing + remote-state read)
 * and price it WITHOUT paying anything. The same body (plus `confirm`) drives
 * `POST /git/push`.
 */
export interface GitEstimateRequest {
  /** Path to the local git repository (worktree or .git dir). Must exist. */
  repoPath: string;
  /** Repository identifier (NIP-34 `d` tag). The daemon identity is the owner. */
  repoId: string;
  /**
   * Full refnames to push (e.g. `["refs/heads/main"]`). Default: every local
   * branch and tag.
   */
  refspecs?: string[];
  /** Allow non-fast-forward updates (default false → 409 `non_fast_forward`). */
  force?: boolean;
  /**
   * Relay URLs to read remote state from and publish to. Plural from day one
   * (forward-compat); defaults to the daemon's config-seeded relay.
   */
  relayUrls?: string[];
  /** Repo name/description for the first-push kind:30617 announcement. */
  announcement?: { name?: string; description?: string };
}

/** One planned ref update (wire shape of @toon-protocol/rig `RefUpdate`). */
export interface GitRefUpdate {
  refname: string;
  localSha: string;
  /** Remote tip SHA, or null when the ref is new. */
  remoteSha: string | null;
  kind: 'new' | 'fast-forward' | 'forced' | 'up-to-date';
}

/** One object scheduled for upload (wire shape of `PlannedObject`). */
export interface GitPlannedObject {
  sha: string;
  type: 'blob' | 'tree' | 'commit' | 'tag';
  /** Body size in bytes (what the upload fee is charged on). */
  size: number;
  /** Path the object was reached by, when known (blobs / non-root trees). */
  path?: string;
  /** True when this SHA is the tip of a planned ref update (uploaded last). */
  isRefTip: boolean;
}

/** Pre-push fee table (all fees in base/micro units, decimal strings). */
export interface GitFeeEstimate {
  objectCount: number;
  totalObjectBytes: number;
  /** Σ size × uploadFeePerByte. */
  uploadFee: string;
  /** Events to publish (refs event + announcement on first push). */
  eventCount: number;
  /** eventCount × per-event fee. */
  eventFees: string;
  /** uploadFee + eventFees. */
  totalFee: string;
}

/** Serialized `PushPlan` — everything a confirm UI needs. */
export interface GitEstimateResponse {
  repoId: string;
  refUpdates: GitRefUpdate[];
  /** Full new ref state to publish (HEAD target first). */
  newRefs: Record<string, string>;
  headSymref: string | null;
  objects: GitPlannedObject[];
  /** sha→txId hints known WITHOUT uploading (remote tags + resolver finds). */
  knownShaToTxId: Record<string, string>;
  /** True when no kind:30617 exists yet — the push announces first. */
  announceNeeded: boolean;
  announcement: { name: string; description: string };
  estimate: GitFeeEstimate;
}

/**
 * `POST /git/push` — plan + execute: upload the delta to Arweave and publish
 * the cumulative kind:30618 (+ kind:30617 on first push). PERMANENT + PAID.
 */
export interface GitPushRequest extends GitEstimateRequest {
  /** Must be literally `true` — a push spends channel funds irreversibly. */
  confirm: boolean;
}

/** One object-upload step result. */
export interface GitUploadStep {
  sha: string;
  txId: string;
  /** '0' when skipped (already on Arweave — content-addressed resume). */
  feePaid: string;
  skipped: boolean;
}

/** Receipt for one published event. */
export interface GitPublishReceipt {
  eventId: string;
  feePaid: string;
}

/** Serialized `PushResult` — per-step receipts + total fees actually paid. */
export interface GitPushResponse {
  repoId: string;
  refUpdates: GitRefUpdate[];
  /** Per-object results, in plan order. */
  uploads: GitUploadStep[];
  /** kind:30617 receipt, or null when the repo was already announced. */
  announceReceipt: GitPublishReceipt | null;
  /** kind:30618 (cumulative refs + arweave map) receipt. */
  refsReceipt: GitPublishReceipt;
  /** Full sha→txId map published in the refs event. */
  arweaveMap: Record<string, string>;
  /** Total fees actually paid (uploads + events), base units, decimal. */
  totalFeePaid: string;
  /** The pre-push estimate the push ran under (compare against totalFeePaid). */
  estimate: GitFeeEstimate;
}

/** `POST /git/issue` — publish a kind:1621 issue against a repo. PAID. */
export interface GitIssueRequest {
  repoAddr: GitRepoAddr;
  /** Issue title (`subject` tag). */
  title: string;
  /** Issue body (Markdown content). */
  body: string;
  /** Labels (`t` tags). */
  labels?: string[];
}

/** `POST /git/comment` — publish a kind:1622 comment on an issue/patch. PAID. */
export interface GitCommentRequest {
  repoAddr: GitRepoAddr;
  /** Event id of the issue or patch being commented on. */
  rootEventId: string;
  /** Comment body (Markdown content). */
  body: string;
  /**
   * Pubkey of the TARGET event's author (NIP-34 `p` threading tag — not the
   * comment author). Defaults to the repo owner.
   */
  parentAuthorPubkey?: string;
  /** `e`-tag marker (default 'root': commenting directly on the issue/patch). */
  marker?: 'root' | 'reply';
}

/**
 * `POST /git/patch` — publish a kind:1617 patch. Supply EXACTLY ONE of
 * `patchText` (literal `git format-patch` output) or `repoPath`+`range`
 * (the daemon runs `git format-patch --stdout <range>` locally). PAID.
 */
export interface GitPatchRequest {
  repoAddr: GitRepoAddr;
  /** Patch/PR title (`subject` tag). */
  title: string;
  /**
   * PR body/cover text (`description` tag). Kept OUT of the event content so
   * `git am` still consumes the patch text verbatim (#280).
   */
  description?: string;
  /** Literal patch text. Mutually exclusive with `repoPath`+`range`. */
  patchText?: string;
  /** Local repository to run format-patch in. Requires `range`. */
  repoPath?: string;
  /** Revision range for format-patch (`<rev>`, `<rev>..<rev>`, `<rev>...<rev>`). */
  range?: string;
  /** Commit/parent pairs for `commit`/`parent-commit` tags. */
  commits?: { sha: string; parentSha: string }[];
  /** Branch name for the `t` tag. */
  branch?: string;
}

export type GitStatusValue = 'open' | 'applied' | 'closed' | 'draft';

/** `POST /git/status` — publish a kind:1630-1633 status event. PAID. */
export interface GitStatusRequest {
  repoAddr: GitRepoAddr;
  /** Event id of the issue/patch whose status is being set. */
  targetEventId: string;
  /** open → 1630, applied → 1631, closed → 1632, draft → 1633. */
  status: GitStatusValue;
  /** Pubkey of the target event's author (`p` tag), when known. */
  targetPubkey?: string;
}

/**
 * Response of the single-event git publishes (issue/comment/patch/status):
 * a normal publish receipt plus the NIP-34 kind that was published.
 */
export interface GitEventResponse extends PublishResponse {
  kind: number;
}

/** Uniform error envelope returned with non-2xx responses. */
export interface ErrorResponse {
  error: string;
  detail?: string;
  /** True when the caller should retry (e.g. still bootstrapping). */
  retryable?: boolean;
  /**
   * Structured error payload for errors that carry data beyond a message —
   * e.g. `non_fast_forward` includes `refs` (the rejected updates) and
   * `oversize_objects` includes `objects` (sha/type/size/path). Extra
   * top-level fields on the envelope are surfaced here by `ControlClient`.
   */
  [extra: string]: unknown;
}

/**
 * NIP-01 subscription filter. Tag filters use `#<single-letter>` keys, e.g.
 * `{ '#e': [...], '#p': [...] }`.
 */
export interface NostrFilter {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  since?: number;
  until?: number;
  limit?: number;
  search?: string;
  [tag: `#${string}`]: string[] | undefined;
}
