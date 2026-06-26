/**
 * Real, daemon-backed {@link AppBackend} for the TOON apps surface.
 *
 * Reads resolve over the free Nostr relay side (`query`); writes go through the
 * `toon-clientd` control plane (`publish-unsigned` / `upload-media`), where the
 * daemon holds the chain key and signs + pays. **No key material ever reaches
 * the iframe** — the UI only supplies an unsigned event shell or raw bytes.
 *
 * To avoid a dependency cycle (`@toon-protocol/client-mcp` imports
 * `@toon-protocol/views`), this file does NOT import client-mcp. Instead it
 * depends on a minimal structural control port, {@link DaemonControl}, which the
 * client-mcp `ControlClient` satisfies structurally.
 */

import { type NostrEvent, type NostrFilter } from '../types.js';
import {
  type AppBackend,
  type AppStatus,
  type BalanceView,
  type ChannelDepositView,
  type ChannelView,
  type FundWalletView,
  type PublishResult,
  type SwapRequest,
  type SwapResponse,
  type UploadResult,
} from './backend.js';

/** One-shot free read: subscribe the filter(s), wait briefly, return matches. */
export interface DaemonQueryRequest {
  filters: NostrFilter | NostrFilter[];
  timeoutMs?: number;
}

export interface DaemonQueryResponse {
  events: NostrEvent[];
}

/** Build, sign (daemon-held key), and pay-to-write an event from a shell. */
export interface DaemonPublishUnsignedRequest {
  kind: number;
  content?: string;
  tags?: string[][];
}

export interface DaemonPublishResponse {
  eventId: string;
  channelId: string;
  nonce: number;
}

/** Upload bytes to Arweave (blob store), then sign+publish a referencing event. */
export interface DaemonUploadMediaRequest {
  dataBase64: string;
  mime?: string;
  kind?: number;
  caption?: string;
  tags?: string[][];
}

export interface DaemonUploadMediaResponse extends DaemonPublishResponse {
  url: string;
  txId: string;
}

/**
 * Read-only pay-to-write status from the daemon. A structural subset of the
 * client-mcp `StatusResponse` — only the fields the confirm UX needs. The
 * fetch-based control in {@link ./daemon-main daemon-main.ts} maps the daemon's
 * `/status` response onto this shape.
 */
export interface DaemonStatusResponse {
  feePerEvent: string;
  settlementChain: string;
  asset?: string;
}

/**
 * Minimal structural control-plane port the {@link DaemonAppBackend} needs.
 *
 * Intentionally a structural subset of the client-mcp `ControlClient`: that
 * class satisfies this interface without `views` importing client-mcp (which
 * would form a cycle). Extra response fields (e.g. `data` on a publish) are
 * tolerated — only the fields mapped below are read.
 */
/** Tracked-channel list from the daemon `/channels` (structural subset). */
export interface DaemonChannelsResponse {
  channels: ChannelView[];
}

/** On-chain wallet balances from the daemon `/balances` (structural subset). */
export interface DaemonBalancesResponse {
  balances: BalanceView[];
}

/** Faucet drip result from the daemon `/fund-wallet` (structural subset). */
export interface DaemonFundWalletResponse {
  chain: string;
  address: string;
  faucetUrl?: string;
}

export interface DaemonControl {
  status(): Promise<DaemonStatusResponse>;
  query(body: DaemonQueryRequest): Promise<DaemonQueryResponse>;
  publishUnsigned(
    body: DaemonPublishUnsignedRequest
  ): Promise<DaemonPublishResponse>;
  uploadMedia(
    body: DaemonUploadMediaRequest
  ): Promise<DaemonUploadMediaResponse>;
  openChannel(body: { destination?: string }): Promise<{ channelId: string }>;
  swap(body: SwapRequest): Promise<SwapResponse>;
  channels(): Promise<DaemonChannelsResponse>;
  balances(): Promise<DaemonBalancesResponse>;
  fundWallet(body: { chain?: string; address?: string }): Promise<DaemonFundWalletResponse>;
  depositToChannel(body: { channelId: string; amount: string }): Promise<ChannelDepositView>;
}

/**
 * `AppBackend` implemented over the live daemon control plane. Construct it with
 * a `DaemonControl` (the client-mcp `ControlClient` fits) and hand it to
 * {@link ../apps-server.registerToonApps registerToonApps}.
 */
export class DaemonAppBackend implements AppBackend {
  constructor(private readonly control: DaemonControl) {}

  /** Read-only fee/chain — no payment. Maps the daemon status onto `AppStatus`. */
  async status(): Promise<AppStatus> {
    const res = await this.control.status();
    return {
      feePerEvent: res.feePerEvent,
      settlementChain: res.settlementChain,
      ...(res.asset ? { asset: res.asset } : {}),
    };
  }

  /** Free read — no payment. Maps `QueryResponse.events` → `NostrEvent[]`. */
  async query(filter: NostrFilter): Promise<NostrEvent[]> {
    const res = await this.control.query({ filters: filter });
    return res.events;
  }

  /** Pay-to-write. The daemon signs with the held key; the iframe holds none. */
  async publish(req: {
    kind: number;
    content?: string;
    tags?: string[][];
  }): Promise<PublishResult> {
    const res = await this.control.publishUnsigned({
      kind: req.kind,
      content: req.content,
      tags: req.tags,
    });
    return {
      eventId: res.eventId,
      channelId: res.channelId,
      nonce: res.nonce,
    };
  }

  /** Two-step spendy write: Arweave upload (store) then sign+publish reference. */
  async uploadMedia(req: {
    dataBase64: string;
    mime?: string;
    kind?: number;
    caption?: string;
    tags?: string[][];
  }): Promise<UploadResult> {
    const res = await this.control.uploadMedia({
      dataBase64: req.dataBase64,
      mime: req.mime,
      kind: req.kind,
      caption: req.caption,
      tags: req.tags,
    });
    return {
      eventId: res.eventId,
      channelId: res.channelId,
      nonce: res.nonce,
      url: res.url,
      txId: res.txId,
    };
  }

  /** Pre-open a payment channel. Daemon-side; no key material in the iframe. */
  async openChannel(req: { destination?: string }): Promise<{ channelId: string }> {
    return this.control.openChannel(req);
  }

  /** Run a cross-asset swap. All signing/settlement happens daemon-side. */
  async swap(req: SwapRequest): Promise<SwapResponse> {
    return this.control.swap(req);
  }

  /** Free read: tracked channels with nonce + cumulative + available balance. */
  async channels(): Promise<{ channels: ChannelView[] }> {
    return this.control.channels();
  }

  /** Free read: on-chain wallet token balances per configured chain. */
  async balances(): Promise<{ balances: BalanceView[] }> {
    return this.control.balances();
  }

  /** Devnet faucet drip. Receives funds (not spendy); daemon picks the address. */
  async fundWallet(req: { chain?: string; address?: string }): Promise<FundWalletView> {
    const res = await this.control.fundWallet(req);
    return {
      chain: res.chain,
      address: res.address,
      ...(res.faucetUrl ? { faucetUrl: res.faucetUrl } : {}),
    };
  }

  /** Spendy: deposit additional collateral into an open channel (daemon signs). */
  async depositToChannel(req: { channelId: string; amount: string }): Promise<ChannelDepositView> {
    return this.control.depositToChannel(req);
  }
}
