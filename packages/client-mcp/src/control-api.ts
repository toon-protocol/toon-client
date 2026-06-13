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
   * True while the managed anon proxy / BTP session / channel are still coming
   * up. Tools should surface "bootstrapping — retry" rather than blocking.
   */
  bootstrapping: boolean;
  /** True once the client has started and a channel is open (ready to publish). */
  ready: boolean;
  /** The active settlement chain for paid writes to the apex. */
  settlementChain: SettlementChain;
  identity: {
    nostrPubkey: string;
    evmAddress?: string;
    solanaAddress?: string;
    minaAddress?: string;
  };
  transport: {
    type: 'direct' | 'socks5' | 'gateway';
    socksProxy?: string;
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

/** `POST /subscribe` — register a persistent free-read subscription. */
export interface SubscribeRequest {
  /** NIP-01 filter(s). A single object or an array of OR-ed filters. */
  filters: NostrFilter | NostrFilter[];
  /** Optional caller-supplied subscription id (else one is generated). */
  subId?: string;
}

export interface SubscribeResponse {
  subId: string;
}

/** `GET /events` — drain buffered events for a subscription (free read). */
export interface EventsQuery {
  /** Restrict to a single subscription id. */
  subId?: string;
  /** Cursor from a prior `EventsResponse.cursor`; returns only newer events. */
  cursor?: number;
  /** Max events to return (default 200). */
  limit?: number;
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

/** `POST /swap` — pay asset A to a mill peer, receive asset B + a target claim. */
export interface SwapRequest {
  /** Mill peer ILP destination. */
  destination: string;
  /** Amount to send in base units. */
  amount: string;
  /** Optional base64 TOON payload describing the swap intent. */
  toonData?: string;
}

export interface SwapResponse {
  accepted: boolean;
  /** base64 FULFILL data (the signed target-chain claim), when accepted. */
  data?: string;
  code?: string;
  message?: string;
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
