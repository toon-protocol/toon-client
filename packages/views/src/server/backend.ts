/**
 * Pluggable read/write backends for the TOON apps MCP server.
 *
 * The apps server (atoms + ViewSpec rendering) depends only on these
 * interfaces. The {@link ./fake-backend FakeBackend} satisfies them with a
 * seeded relay + in-memory writes (good enough while core/sdk are in flux); the
 * real `@toon-protocol/client-mcp` daemon will satisfy them with live BTP writes
 * and relay reads.
 */

import { type NostrEvent, type NostrFilter } from '../types.js';

/** Free-read side: resolve a NIP-01 filter to matching events. */
export interface AppReadBackend {
  query(filter: NostrFilter): Promise<NostrEvent[]>;
}

/**
 * Read-only pay-to-write status. The confirm UX shows the live fee + settlement
 * chain pulled from here (never hardcoded). A structural subset of the daemon's
 * `StatusResponse` — only the fields the UI needs. The `FakeBackend` returns a
 * deterministic stub; the real `DaemonAppBackend` (#16) maps the live daemon
 * `feePerEvent` / `settlementChain`, with no atom/ViewSpec change.
 */
export interface AppStatus {
  /** Per-event fee in base (micro) units, as a decimal string. */
  feePerEvent: string;
  /** The chain family a paid write settles on (e.g. `'base'`, `'evm'`). */
  settlementChain: string;
  /** Optional human-readable asset code for the fee (e.g. `'USDC'`). */
  asset?: string;
}

/** Read-only status side: report the current fee + settlement chain. */
export interface AppStatusBackend {
  status(): Promise<AppStatus>;
}

export interface PublishResult {
  eventId: string;
  channelId?: string;
  nonce?: number;
}

export interface UploadResult extends PublishResult {
  url: string;
  txId: string;
}

/** Pay-to-write side: sign+publish an event shell; upload+publish media. */
export interface AppWriteBackend {
  publish(req: {
    kind: number;
    content?: string;
    tags?: string[][];
  }): Promise<PublishResult>;
  uploadMedia(req: {
    dataBase64: string;
    mime?: string;
    kind?: number;
    caption?: string;
    tags?: string[][];
  }): Promise<UploadResult>;
}

// ── DeFi seam (open-channel + swap). ────────────────────────────────────────
//
// The minimal swap shapes are re-declared inline (mirroring `PublishResult` /
// `UploadResult`) so `@toon-protocol/views` never imports `@toon-protocol/
// client-mcp` or the React bundle. They are a structural subset of the daemon's
// `control-api` types; the real `DaemonAppBackend` (#16) satisfies this seam by
// delegating to `control-client.openChannel` / `control-client.swap`. No key
// material or payment-claim validation lives here — that stays in the daemon
// and the connector.

/** Swap pair (source → target asset), mirroring `@toon-protocol/core`'s `SwapPair`. */
export interface SwapPair {
  /** Source asset. */
  from: { assetCode: string; assetScale: number; chain: string };
  /** Target asset. */
  to: { assetCode: string; assetScale: number; chain: string };
  /** Exchange rate as a decimal string (target units per source unit). */
  rate: string;
  /** Minimum swap amount per packet in source micro-units. */
  minAmount?: string;
  /** Maximum swap amount per packet in source micro-units. */
  maxAmount?: string;
}

/** Parameters for a cross-asset swap (subset of the daemon's `SwapRequest`). */
export interface SwapRequest {
  /** Mill peer ILP destination (e.g. `g.proxy.mill`). */
  destination: string;
  /** Total source-asset amount to swap, in source micro-units (decimal string). */
  amount: string;
  /** Mill's 64-char lowercase hex Nostr pubkey (NIP-59 gift-wrap recipient). */
  millPubkey: string;
  /** The swap pair to execute. */
  pair: SwapPair;
  /** Sender's payout address on `pair.to.chain`. */
  chainRecipient: string;
  /** Split the swap into N equal packets (default 1). */
  packetCount?: number;
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

/** Result of a swap (subset of the daemon's `SwapResponse`). */
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
 * DeFi side: pre-open a payment channel and run a swap. The UI only *calls*
 * these tools — all signing/settlement happens daemon-side.
 */
export interface AppDefiBackend {
  openChannel(req: { destination?: string }): Promise<{ channelId: string }>;
  swap(req: SwapRequest): Promise<SwapResponse>;
}

export interface AppBackend
  extends AppReadBackend,
    AppWriteBackend,
    AppDefiBackend,
    AppStatusBackend {}
