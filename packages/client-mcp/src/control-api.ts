/**
 * Shared request/response contract for the `toon-clientd` localhost control
 * plane. Both the daemon (server) and the MCP server / control-client (caller)
 * import these types so the wire shape stays in lockstep.
 *
 * Every endpoint is plain JSON over HTTP on `127.0.0.1:<port>`. The daemon owns
 * the long-lived BTP session + payment channels + relay subscription; callers
 * are stateless and never see chain keys.
 */

import type { NostrEvent, UnsignedEvent } from 'nostr-tools/pure';
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
   * The default apex's announce-carried operator notice. Absent unless that
   * apex was resolved by reading a kind:10032 from a TRUSTED announcer which
   * carried a well-formed `notice` — so absent on most reads. See
   * {@link StatusNotice}.
   */
  notice?: StatusNotice;
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

/**
 * An operator notice (toon#183's `IlpPeerInfo.notice`), surfaced via
 * `/status` when the daemon's default apex bootstrapped against a TRUSTED
 * announcer that published one (issue #544, part of toon-meta#252). `url`
 * is a POINTER to the durable notice text — the daemon never fetches it,
 * and neither should a caller as a side effect of reading status.
 */
export interface StatusNotice {
  /** Stable per notice, so a caller can show it once and not repeat it. */
  id: string;
  severity: 'info' | 'action-required';
  /** One line, plain — the reason to go read `url`. */
  summary: string;
  /** Where the durable notice text lives. NEVER fetched by this daemon. */
  url: string;
}

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

/**
 * `POST /nip59-unwrap` — unwrap a NIP-59 gift wrap (kind:1059) addressed to
 * this daemon's Nostr identity, using the daemon-held secret key for both
 * NIP-44 decryption layers (wrap → seal → rumor). The secret key never
 * leaves the daemon.
 *
 * Backs external agent processes (buzz#19's agent-members) receiving
 * gift-wrapped channel keys addressed to the daemon's identity — the daemon
 * owns the Nostr identity, so it offers unwrap-as-a-service rather than
 * handing the key out (toon-meta#256).
 *
 *   200 `{ rumor, sealPubkey }`
 *   400 `{ error }` — malformed input, not kind:1059, or not addressed to
 *       this identity (no matching `p` tag).
 *   422 `{ error }` — a NIP-44 layer failed to decrypt, or the seal's
 *       signature didn't verify against its own pubkey.
 */
export interface Nip59UnwrapRequest {
  /** A kind:1059 gift-wrap Nostr event, addressed via a `p` tag to this daemon's identity. */
  wrap: NostrEvent;
}

export interface Nip59UnwrapResponse {
  /** The unwrapped/unsealed inner unsigned event (NIP-59's "rumor"). */
  rumor: UnsignedEvent & { id?: string };
  /**
   * The hex pubkey that signed the kind:13 seal — the REAL author, verified
   * against the seal's own signature. Callers MUST validate authorship from
   * this field, never from the wrap's ephemeral, one-time-use `pubkey`.
   */
  sealPubkey: string;
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
   * Which apex to send the swap on and settle the source-asset claim through
   * (default: the config-seeded apex). The swap peer must be reachable from
   * the apex this names — either as one of its child peers, or, for a
   * DIRECT-DIALLED maker (one deliberately kept out of a relay connector's
   * routing table and reached at its own advertised `btpEndpoint`), by
   * naming the maker's OWN apex here after registering it with
   * `POST /apexes` (`toon_add_apex`). Selection is by BTP URL only — the
   * daemon keys its apex map on `btpUrl` (`ClientRunner.selectApex`), the
   * same selector `POST /publish` uses; there is no ILP-destination selector.
   * Without it every swap goes to the seeded apex, where an unrouted
   * destination fails peer resolution (`PEER_NOT_NEGOTIATED`).
   */
  btpUrl?: string;
  /**
   * Which path the swap takes (toon-client#585, rolling-swap spec §10.3
   * step 2). Capability is discovered by PROBE, never by an announce field —
   * swap#135 deliberately ships no flag:
   *
   * - `'require'` — **the default** since toon-client#595 (overridable by
   *   `swapDefaults.rolling`). Send a kind:20033 RFQ; a kind:20034 quote back
   *   means the maker registered the session and the swap runs on the rolling
   *   path. ANY other outcome FAILS with `rolling_unavailable` (HTTP 502)
   *   naming the maker pubkey, its ILP address and the reason discriminator.
   *   ADR 0003: the rolling swap is the only swap, so a maker that stops
   *   answering is a fault to report, not a reason to silently serve every
   *   caller the weaker protocol.
   * - `'auto'` — probe, then fall back to the legacy path on any failure.
   *   The transitional escape hatch, kept for exactly one release and removed
   *   with the legacy sender (Stage 4, toon-client#598).
   * - `'off'` — never probe. No RFQ packet is sent or paid for; the swap runs
   *   legacy. Still reachable because #592's own diagnosis points at it when a
   *   rolling fill cannot be DELIVERED (swap#148).
   *
   * The rolling outcome (probed / used / quote / fallback reason) is always
   * echoed on {@link SwapResponse.rolling}, and a legacy run — from either
   * escape hatch — also raises a {@link SwapResponse.warning}. Neither
   * downgrade is silent.
   */
  rolling?: 'auto' | 'off' | 'require';
  /**
   * The ILP address this client receives leg-B PREPAREs on, put on the RFQ as
   * `senderIlpAddress` (spec §2.2). The maker uses it VERBATIM as the
   * destination of every leg-B PREPARE in the session and has no fallback, and
   * a connector resolves a client's BTP session by EXACT match on the id it
   * greeted with — so a wrong value establishes a session whose leg B can
   * never arrive. Defaults to the selected apex client's own address
   * (`ToonClient.getOwnIlpAddress()`); set this only to override that.
   */
  senderIlpAddress?: string;
  /**
   * What the RFQ probe packet itself pays, source micro-units. The probe buys
   * a quote rather than value, so it defaults to the terminating connector's
   * flat packet price (`GET /ilp/routes/price`, ADR 0020), or 1 micro-unit
   * when no price route answers.
   */
  rfqAmount?: string;
  /**
   * Mint a FRESH sender-chosen execution condition per packet
   * (`C_i = sha256(P_i)`, toon-client#350 / rolling-swap toon-meta#145 §3)
   * and verify each FULFILL's preimage client-side.
   *
   * **No longer a path selector.** Since toon-client#585 the rolling path is
   * chosen by the RFQ probe (`rolling`), and the rolling fill loop always
   * mints per-packet conditions — that is what couples the legs. This field
   * survives only so an existing caller does not break; it is meaningful
   * solely as a companion to `streamNonce`, and combining it with
   * `rolling: 'off'` is a validation error (that combination asks for a
   * conditioned LEGACY packet, an unconditional maker-side F99).
   */
  senderConditions?: boolean;
  /**
   * Rolling-swap session id (spec §2.1/§2.2): 16 bytes, lowercase hex.
   *
   * Setting it SKIPS the RFQ probe and fills against that session directly —
   * the pre-#585 path for a nonce registered with the maker out of band
   * (`SwapNodeInstance.registerRollingSession`). Leave it unset for the
   * ordinary flow: {@link SwapRequest.rolling}'s probe mints and registers a
   * nonce on the wire, which is the only route that works against a deployed
   * (CLI-run) maker.
   */
  streamNonce?: string;
  /**
   * Hard floor on the per-packet exchange rate (sdk ≥2.1.0, rolling-swap
   * toon-meta#145 spec §5). Decimal string in `SwapPair.rate` format (target
   * whole-units per source whole-unit). When set, every fulfilled packet is
   * checked BEFORE its claim is accumulated: a maker tape rate `R_i` below
   * the floor — or a delivered amount below `applyRate(sourceAmount, floor)`
   * — records a `BELOW_FLOOR` rejection and halts the stream
   * (`abortReason: 'below-floor'`). The floor is a safety mechanism,
   * deliberately never relaxed by the adaptive controller. Takes precedence
   * over `floorBps`.
   */
  minExchangeRate?: string;
  /**
   * Derive the floor from the advertised pair rate instead of supplying it:
   * `minExchangeRate = pair.rate × (1 − floorBps/10000)` (spec §5's
   * `R₀ × (1 − tolerance)`). Integer basis points in `[0, 10000)`. Ignored
   * when `minExchangeRate` is set. Falls back to the daemon's
   * `swapDefaults.floorBps` when both are unset.
   */
  floorBps?: number;
  /**
   * Per-packet PREPARE expiry window in ms (sdk ≥2.1.0, rolling-swap R7): each
   * packet is stamped `expiresAt = now + packetExpiryMs` at send time so a
   * stalled packet expires deterministically and frees its in-flight slot.
   * Unset keeps the legacy transport-derived expiry. Falls back to the
   * daemon's `swapDefaults.packetExpiryMs`.
   */
  packetExpiryMs?: number;
  /**
   * Overall swap deadline in ms. On the legacy path it is wired to
   * `streamSwap`'s `AbortSignal`, so on expiry the stream aborts mid-flight
   * and in-flight packets are drained; on the rolling path (toon-client#596)
   * it bounds the fill loop — checked before each sequential send and handed
   * to that send as its remaining per-call budget. Either way the response
   * reports the partial fill accurately (`state: 'stopped'`,
   * `abortReason: 'aborted'`, partial `claims`/cumulatives).
   */
  timeoutMs?: number;
  /**
   * Engage the sdk's adaptive δ/W controller (`AdaptiveDeltaController`,
   * rolling-swap spec §6) for DYNAMIC packet sizing instead of a static even
   * split. Mutually exclusive with `packetCount`. Controller state is
   * persisted per-(source chain, maker, pair) under the daemon's data dir so
   * ramp/trust survives across swaps. When unset, the daemon's
   * `swapDefaults.controller` applies (unless the request pins an explicit
   * `packetCount`). The controller only tunes efficiency — it can never relax
   * the `minExchangeRate` floor.
   *
   * LEGACY-PATH ONLY. Setting this routes the request away from the rolling
   * probe entirely (`negotiateRollingSession`'s `'controller'` fallback), and
   * combining it with a pinned `streamNonce` is rejected outright — the
   * controller is deliberately DROPPED, not ported, on rolling
   * (toon-client#597: rolling's per-packet re-quote and verify-before-reveal
   * already bound the risk δ existed to bound, and the fill loop's strict
   * sequencing pins W at 1). This field disappears with the rest of the
   * legacy path in Stage 4.
   */
  controller?: SwapControllerParams;
  /**
   * The maker's ADVERTISED on-chain signer address for `pair.to.chain`
   * (kind:10032 discovery or operator-supplied), toon-client#352. When set,
   * every received claim's self-reported signer must match it
   * (`SWAP_SIGNER_MISMATCH` otherwise) and signatures are verified against
   * THIS address — never the claim's own. When unset, the claim's
   * self-reported signer is verified and pinned per channel.
   */
  swapSignerAddress?: string;
}

/**
 * Adaptive-controller parameters (mirrors the sdk's
 * `AdaptiveDeltaControllerConfig`, minus the identity/persistence fields the
 * daemon supplies itself). BigInt-valued sdk fields travel as decimal strings.
 */
export interface SwapControllerParams {
  /**
   * Maker's advertised two-sided spread as a fraction (e.g. `0.004` = 40 bps).
   * REQUIRED — ε is denominated off the half-spread and the sdk deliberately
   * has no default (an invented spread would silently mis-size ε).
   */
  advertisedSpread: number;
  /** Absolute per-packet ceiling in source micro-units (decimal string). */
  maxPacketAmount?: string;
  /** Floor on δ in source micro-units (decimal string). Default `1`. */
  minPacketAmount?: string;
  /** Ceiling on the in-flight window W. Default 8. */
  maxWindow?: number;
  /** Clean-fulfill streak length K per widen step. Default 16. */
  cleanStreakLength?: number;
  /** Cold-start divisor: `δ_0 = notional / coldStartDivisor`. Default 256. */
  coldStartDivisor?: number;
  /** EWMA smoothing factor α for `v`/`τ`, in (0, 1]. Default 0.2. */
  ewmaAlpha?: number;
}

/** Per-packet telemetry for one accepted FULFILL (from the sdk's `onPacket`). */
export interface SwapPacketOutcome {
  /** 0-indexed packet number. With an adaptive window > 1, completion order. */
  index: number;
  /** Source-asset amount sent for this packet (micro-units, decimal). */
  sourceAmount: string;
  /** Target-asset amount claimed (micro-units, decimal). */
  targetAmount: string;
  /** Effective rate for this packet (target/source, whole units). Display-only. */
  effectiveRate: number;
  /** Absolute deviation from the advertised rate (e.g. 0.0125 = 1.25%). */
  rateDeviation: number;
  /** Maker's fresh quote-tape rate `R_i` applied to THIS packet, when emitted. */
  rate?: string;
  /** Unix ms when the maker's rate source produced `rate`. Present iff `rate` is. */
  rateTimestamp?: number;
}

/** One rejected packet (e.g. `BELOW_FLOOR`, or a maker/connector reject). */
export interface SwapRejection {
  /** 0-indexed packet number. */
  packetIndex: number;
  /** Source-asset amount the packet attempted (micro-units, decimal). */
  sourceAmount: string;
  /** ILP-style rejection code (e.g. `BELOW_FLOOR`, `F99`, `T99`). */
  code: string;
  message: string;
}

/**
 * One packet that never reached the maker: it THREW before (or while) being
 * sent, so there is no ILP rejection to report. The sdk records these on
 * `StreamSwapResult.errors` (`stream_swap.wrap_failed` /
 * `stream_swap.send_failed`) — distinct from {@link SwapRejection}, which is a
 * packet the maker/connector answered with a REJECT.
 *
 * The distinction is load-bearing for diagnosis: the sdk's `finalizeResult`
 * rewrites `abortReason` to `'all-rejected'` only when there were rejections
 * and NO errors, so `state: 'failed'` with `abortReason: 'complete'` and zero
 * packets accepted means every packet died on THIS side — read `errors` for
 * why (e.g. `PEER_NOT_NEGOTIATED`: the destination is not routable from the
 * selected apex — see `SwapRequest.btpUrl`).
 */
export interface SwapError {
  /** 0-indexed packet number. */
  packetIndex: number;
  /** The thrown error's message (the sdk's `cause.message`). */
  message: string;
  /** The thrown error's constructor name, when it carries one (e.g. `TargetError`). */
  name?: string;
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
  /**
   * Receipt-time verification outcome (#352). `true`: the claim passed
   * signature/recipient/monotonicity checks and advanced the persisted
   * watermark. Absent: the claim lacked settlement metadata (legacy pre-rename
   * peer, see `SwapResponse.warning`) and was neither verified nor persisted.
   */
  verified?: boolean;
  /**
   * Why verification REJECTED this claim (#352). A rejected claim is never
   * counted as value received and is not persisted. Codes follow the sdk 2.x
   * vocabulary (`SWAP_SIGNER_MISMATCH`, `SIGNER_MISMATCH`, `SIGNATURE_INVALID`,
   * `NON_MONOTONIC_NONCE`, `NON_MONOTONIC_CUMULATIVE`, `CUMULATIVE_SHORTFALL`,
   * `RECIPIENT_MISMATCH`, `CHAIN_MISMATCH`, `MINA_VERIFICATION_UNSUPPORTED`, …).
   */
  verificationError?: { code: string; message: string };
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
  /**
   * Early wire-skew alarm (#349): set when packets were FULFILLed but no
   * accepted claim carries `swapSignerAddress` settlement metadata — the
   * signature of a pre-rename (sdk <2.0.0) swap peer whose `millSignerAddress`
   * field sdk ≥2 silently drops. Settling such claims fails later with
   * `MISSING_SETTLEMENT_METADATA`; this surfaces the problem at swap time.
   *
   * Also set (#352) when one or more received claims FAILED receipt-time
   * verification — those claims carry `verificationError` and are never
   * counted as value received.
   */
  warning?: string;
  /**
   * Why the stream ended (sdk `StreamSwapResult.abortReason`): `'complete'`,
   * `'aborted'` (signal / `timeoutMs`), `'stopped'`, `'callback-stop'`,
   * `'callback-throw'`, `'rate-deviation'`, `'below-floor'` (floor breach —
   * pairs with a `BELOW_FLOOR` rejection), `'receipt-invalid'`, or
   * `'all-rejected'`.
   *
   * Diagnostic note: the sdk only rewrites `'complete'` → `'all-rejected'`
   * when there were rejections and NO errors, so `state: 'failed'` +
   * `abortReason: 'complete'` + `packetsAccepted: 0` is the signature of the
   * LOCAL error path — read {@link SwapResponse.errors}.
   */
  abortReason?: string;
  /**
   * Per-packet outcomes for accepted FULFILLs, in completion order (host
   * telemetry / consent surface). Capped at 500 entries — see
   * `packetsTruncated`.
   */
  packets?: SwapPacketOutcome[];
  /** Set when `packets` was capped; cumulative totals remain exact. */
  packetsTruncated?: boolean;
  /** Per-packet rejections (floor breaches, maker rejects, stale-rate T99s). */
  rejections?: SwapRejection[];
  /**
   * Per-packet LOCAL failures: packets that threw before the maker ever
   * answered (gift-wrap build failure, transport/peer-resolution throw). See
   * {@link SwapError} — without this a swap that failed entirely on this side
   * reported only `abortReason: 'complete'` with nothing else to go on.
   */
  errors?: SwapError[];
  /**
   * Realized-rate summary: `cumulativeTarget / cumulativeSource` in WHOLE
   * units (scale-adjusted per the pair). Display-only number; compare against
   * the advertised `pair.rate` and `minExchangeRate`. Absent when nothing
   * was filled.
   */
  realizedRate?: number;
  /**
   * The hard floor that was armed for this swap (explicit param or derived
   * from `floorBps`), echoed so hosts can show the guaranteed worst-case rate
   * alongside the fee/consent surface. Absent when no floor was armed.
   */
  minExchangeRate?: string;
  /** #352: claims that passed receipt-time verification and were persisted. */
  claimsVerified?: number;
  /** #352: claims REJECTED at receipt time (see per-claim `verificationError`). */
  claimsRejected?: number;
  /**
   * #352: total verified watermark advance across this swap's claims — the
   * value actually received, target micro-units. Rejected claims contribute
   * NOTHING here. Absent when no claim carried settlement metadata (legacy).
   */
  valueReceived?: string;
  /**
   * What rolling capability discovery decided (toon-client#585). Present on
   * EVERY swap — including `rolling: 'off'`, which since toon-client#595
   * reports itself as `fallbackReason: 'off'` rather than leaving the block
   * absent. A legacy run is never inferred from a missing field.
   */
  rolling?: SwapRollingInfo;
}

/**
 * The rolling-swap negotiation outcome for one `swap()` call (spec §10.3
 * step 2 capability discovery).
 */
export interface SwapRollingInfo {
  /** Whether a kind:20033 RFQ probe was actually sent (and paid for). */
  probed: boolean;
  /** Whether the swap ran on the rolling path. */
  used: boolean;
  /** The session id every fill referenced. Present iff `used`. */
  streamNonce?: string;
  /** `R₀` from the kind:20034 quote — target whole-units per source whole-unit. */
  rate?: string;
  /** Unix-ms tick time of the maker's rate source for `rate`. */
  rateTimestamp?: number;
  /**
   * Unix-ms the QUOTE lapses. NOT the session lifetime — the maker keeps the
   * session for its own store TTL and reprices every fill at a fresh `R_i`.
   */
  expiresAt?: number;
  /** Maker's advertised freshness bound on its rate source, ms (spec §4). */
  maxRateAge?: number;
  /** Maker's advertised two-sided spread, basis points. */
  spreadBps?: number;
  /**
   * Why the swap fell back to legacy. One of the RFQ failure reasons
   * (`send-failed`, `rejected` — the ordinary "legacy maker" signal —
   * `no-response`, `not-a-quote`, `nonce-mismatch`), a local one
   * (`controller`, `no-sender-address`), or `off` — the caller (or
   * `swapDefaults`) disabled the probe outright. Present iff `!used`.
   *
   * Under the default `rolling: 'require'` none of these reach a caller as a
   * fallback: they arrive as the `reason` field of a `rolling_unavailable`
   * error instead. This block is what an explicit `'auto'` / `'off'` reports.
   */
  fallbackReason?: string;
  /** Human-readable detail behind `fallbackReason`. */
  fallbackMessage?: string;
}

// ── Received swap claims: persistence + settlement (#352) ────────────────────

/** One persisted received-claim watermark (highest nonce per chain+channel). */
export interface ReceivedClaimInfo {
  /** Target chain the claim settles on (e.g. `evm:base:8453`). */
  chain: string;
  /** Payment-channel id on the target chain. */
  channelId: string;
  /** Balance-proof nonce (decimal). */
  nonce: string;
  /** Cumulative transferred amount (target micro-units, decimal). */
  cumulativeAmount: string;
  /** Recipient (the sender's payout address the claim was verified against). */
  recipient: string;
  /** Swap peer's on-chain signer the signature verified against. */
  swapSignerAddress: string;
  /** Unix ms the winning claim was received. */
  receivedAt: number;
  /** Unix ms the watermark last advanced. */
  updatedAt: number;
  /** Set once a settlement submission succeeded. */
  settledAt?: number;
  /** Watermark nonce redeemed by that settlement (decimal). */
  settledNonce?: string;
  settleTxHash?: string;
}

/** `GET /swap/claims` — list persisted received-claim watermarks. */
export interface ListSwapClaimsResponse {
  claims: ReceivedClaimInfo[];
}

/**
 * `POST /swap/settle` — build (and, where chain plumbing is configured,
 * submit) on-chain settlements for persisted received claims. N received
 * advances per channel redeem as ONE close with the final watermark.
 */
export interface SettleSwapClaimsRequest {
  /** Restrict to one target chain (e.g. `evm:base:8453`). */
  chain?: string;
  /** Restrict to one channel. */
  channelId?: string;
  /**
   * When false, stop after building the settlement tx (dry run). Default true:
   * submit each EVM bundle whose chain has an RPC configured
   * (`chainRpcUrls[chain]` — the env-gated submission seam).
   */
  submit?: boolean;
}

/** Per-channel settlement outcome (result-shaped; nothing throws per channel). */
export interface SwapSettlementResult {
  chain: string;
  channelId: string;
  /** Whether a settlement tx was built (claim re-verified at settle time). */
  built: boolean;
  /** Whether the tx was submitted on-chain. */
  submitted: boolean;
  /** Final watermark being redeemed (decimal), when built. */
  nonce?: string;
  cumulativeAmount?: string;
  /** Unsigned settlement tx bytes (base64), when built — for external signers. */
  unsignedTx?: string;
  txHash?: string;
  /** Receipt status when submission waited one out. */
  txStatus?: string;
  /** Why the step stopped where it did (missing config, verification, …). */
  error?: { code: string; message: string };
}

export interface SettleSwapClaimsResponse {
  results: SwapSettlementResult[];
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
  /** objectCount × the store route's flat price. */
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
