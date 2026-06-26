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
}

/** `POST /publish` — pay-to-write a single Nostr event. */
export interface PublishRequest {
  /** A fully-signed Nostr event (id + sig present). */
  event: NostrEvent;
  /** ILP destination override (default: the configured apex/town address). */
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
  /** ILP destination override (default: the configured apex/town address). */
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
  /** Base64-encoded media bytes. */
  dataBase64: string;
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
}

/** `GET /channels` — list tracked channels with nonce watermarks. */
export interface ChannelsResponse {
  channels: ChannelInfo[];
}

/**
 * `POST /swap` — pay asset A to a mill peer, receive asset B + a signed
 * target-chain claim. The daemon builds the NIP-59 gift-wrapped kind:20032 swap
 * rumor and streams it via SDK `streamSwap`, signing the source-asset claim
 * against the open apex channel (the mill peer must be routed via
 * `apexChildPeers`).
 */
export interface SwapRequest {
  /** Mill peer ILP destination (e.g. `g.proxy.mill`). */
  destination: string;
  /** Total source-asset amount to swap, in source micro-units. */
  amount: string;
  /** Mill's 64-char lowercase hex Nostr pubkey (NIP-59 gift-wrap recipient). */
  millPubkey: string;
  /**
   * The swap pair to execute — from kind:10032 discovery, or operator-supplied
   * when the mill announces pairs to a relay other than the town relay.
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
   * config-seeded apex). The mill must be a child peer of this apex.
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
  /** Sender's payout address echoed by the mill. */
  recipient?: string;
  /** Mill's on-chain signer address. */
  millSignerAddress?: string;
  /** Mill-side claim id. */
  claimId?: string;
  /** Balance-proof nonce on the target channel (decimal). */
  nonce?: string;
  /** Cumulative transferred on the target channel (micro-units, decimal). */
  cumulativeAmount?: string;
}

export interface SwapResponse {
  /** True when at least one packet FULFILLed with a usable claim. */
  accepted: boolean;
  /** Number of packets the mill FULFILLed. */
  packetsAccepted: number;
  /** Per-packet accumulated claims (settlement metadata + signed claim). */
  claims: SwapClaim[];
  /** Total source sent across accepted packets (micro-units, decimal). */
  cumulativeSource: string;
  /** Total target received across accepted packets (micro-units, decimal). */
  cumulativeTarget: string;
  /** Final stream state. */
  state: 'completed' | 'failed' | 'stopped';
  /** First rejection code from the mill, if any (e.g. `F99`). */
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
  /** Child peers reached via this apex's channel (e.g. `["dvm","mill"]`). */
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

/** `POST /fund-wallet` result. */
export interface FundWalletResponse {
  /** The chain that was funded. */
  chain: SettlementChain;
  /** The address that was funded. */
  address: string;
  /** The faucet base URL the drip was requested from. */
  faucetUrl: string;
  /** Raw parsed JSON body from the faucet (shape is faucet-defined). */
  response: unknown;
}

/** Uniform error envelope returned with non-2xx responses. */
export interface ErrorResponse {
  error: string;
  detail?: string;
  /** True when the caller should retry (e.g. still bootstrapping). */
  retryable?: boolean;
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
