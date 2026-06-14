/**
 * ClientRunner — the daemon's connection owner. Wraps a single `ToonClient`
 * (BTP session + payment channels + signer) plus a persistent
 * `RelaySubscription` (free reads), and exposes the high-level operations the
 * HTTP routes map onto.
 *
 * Bootstrap is asynchronous and non-blocking: `start()` returns immediately and
 * the connection comes up in the background (the managed anon proxy alone can
 * take 30–90s). Until it is ready, write operations report `bootstrapping` so
 * tools surface "retry" rather than hang.
 *
 * The `ToonClient` is injected via `ToonClientLike` so unit tests can drive the
 * runner with a fake — no BTP/anon/on-chain dependency.
 */

import type { NostrEvent } from 'nostr-tools/pure';
import { decodeEventFromToon } from '@toon-protocol/core';
import { RelaySubscription } from '../relay-subscription.js';
import type {
  ChannelsResponse,
  ChainStatus,
  EventsResponse,
  PublishResponse,
  StatusResponse,
  SubscribeRequest,
  SubscribeResponse,
  SwapResponse,
} from '../control-api.js';
import type {
  EventsQuery,
  PublishRequest,
  SwapRequest,
} from '../control-api.js';
import type { ApexNegotiationConfig, ResolvedDaemonConfig } from './config.js';
import {
  loadApexChannel,
  saveApexChannel,
  type PersistedChannelContext,
} from './apex-channel-store.js';

/** The subset of `ToonClient` the runner depends on. */
export interface ToonClientLike {
  start(): Promise<{ peersDiscovered: number; mode: string }>;
  stop(): Promise<void>;
  getPublicKey(): string;
  getEvmAddress(): string | undefined;
  getSolanaAddress(): string | undefined;
  getMinaAddress(): string | undefined;
  getNetworkStatus(): { evm: string; solana: string; mina: string } | undefined;
  publishEvent(
    event: NostrEvent,
    options?: { destination?: string; claim?: unknown; ilpAmount?: bigint }
  ): Promise<{
    success: boolean;
    eventId?: string;
    data?: string;
    error?: string;
  }>;
  signBalanceProof(channelId: string, amount: bigint): Promise<unknown>;
  openChannel(destination?: string): Promise<string>;
  getTrackedChannels(): string[];
  getChannelNonce(channelId: string): number;
  getChannelCumulativeAmount(channelId: string): bigint;
  sendSwapPacket(params: {
    destination: string;
    amount: bigint;
    toonData: Uint8Array;
    claim?: unknown;
  }): Promise<{
    accepted: boolean;
    data?: string;
    code?: string;
    message?: string;
  }>;
}

export interface ClientRunnerDeps {
  config: ResolvedDaemonConfig;
  /** Factory producing the (real or fake) ToonClient. */
  createClient: () => ToonClientLike;
  /** Factory producing the relay subscription (defaults to the real one). */
  createRelay?: () => RelaySubscription;
  logger?: (msg: string) => void;
}

export class ClientRunner {
  private readonly config: ResolvedDaemonConfig;
  private readonly client: ToonClientLike;
  private readonly relay: RelaySubscription;
  private readonly log: (msg: string) => void;

  private readonly startedAt = Date.now();
  private bootstrapping = false;
  private ready = false;
  private lastError: string | undefined;
  /** Channel opened against the default apex destination. */
  private apexChannelId: string | undefined;
  private stopped = false;

  constructor(deps: ClientRunnerDeps) {
    this.config = deps.config;
    this.client = deps.createClient();
    this.relay =
      deps.createRelay?.() ??
      new RelaySubscription({
        relayUrl: deps.config.relayUrl,
        socksProxy: deps.config.socksProxy,
        logger: deps.logger,
        // The TOON relay sends events TOON-encoded (text) on reads, not as JSON.
        decodeEvent: (raw) =>
          decodeEventFromToon(new TextEncoder().encode(raw)),
      });
    this.log = deps.logger ?? ((): void => undefined);
  }

  /**
   * Begin bootstrapping in the background. Resolves once kicked off; the
   * connection becomes ready asynchronously. Awaitable for tests via the
   * returned promise of the underlying work.
   */
  start(): void {
    if (this.bootstrapping || this.ready) return;
    this.bootstrapping = true;
    // Reads can start immediately and independently of the paid-write path.
    this.relay.start();
    void this.bootstrap();
  }

  /** The background bootstrap routine (exposed for awaiting in tests). */
  async bootstrap(): Promise<void> {
    try {
      await this.client.start();
      this.injectApexNegotiation(this.config.apex);
      this.apexChannelId = await this.openOrResumeApexChannel();
      this.routeChildPeersThroughApexChannel();
      this.ready = true;
      this.lastError = undefined;
      this.log(`[runner] ready; apex channel ${this.apexChannelId}`);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.log(`[runner] bootstrap failed: ${this.lastError}`);
    } finally {
      this.bootstrapping = false;
    }
  }

  /**
   * Open the apex channel — or, on a restart, RESUME the existing one.
   *
   * `ChannelManager` persists the nonce watermark (by channelId) but not the
   * peer→channelId mapping, so a naive `openChannel()` after restart re-deposits
   * into a fresh channel and reverts on-chain. We persist the channelId here and,
   * when present, `trackChannel()` the live channel (which rehydrates the nonce
   * from the channel store) — no on-chain write, watermark continues.
   */
  private async openOrResumeApexChannel(): Promise<string> {
    const { destination, chain, apexChannelStorePath } = this.config;
    const saved = loadApexChannel(apexChannelStorePath, destination, chain);
    const cm = (
      this.client as unknown as {
        channelManager?: {
          trackChannel?: (id: string, ctx: PersistedChannelContext) => void;
        };
      }
    ).channelManager;

    if (saved && cm && typeof cm.trackChannel === 'function') {
      cm.trackChannel(saved.channelId, saved.context);
      this.log(
        `[runner] resumed apex channel ${saved.channelId} (tracked, no re-deposit)`
      );
      return saved.channelId;
    }

    // First open for this (destination, chain): open on-chain and persist the
    // channelId + context so the next restart resumes instead of re-depositing.
    const channelId = await this.client.openChannel(destination);
    if (this.config.apex) {
      const a = this.config.apex;
      saveApexChannel(apexChannelStorePath, destination, chain, {
        channelId,
        context: {
          chainType: a.chain,
          chainId: a.chainId,
          tokenNetworkAddress: a.tokenNetwork ?? '',
          tokenAddress: a.tokenAddress,
          recipient: a.settlementAddress,
        },
      });
    }
    return channelId;
  }

  /**
   * Inject the apex settlement negotiation directly into the ToonClient when
   * configured. Required for HS / direct-apex mode where bootstrap discovers 0
   * peers (no relay-based discovery). Mirrors the docker entrypoint's approach.
   */
  private injectApexNegotiation(apex: ApexNegotiationConfig | undefined): void {
    if (!apex) return;
    const negotiations = (
      this.client as unknown as {
        peerNegotiations?: Map<string, unknown>;
      }
    ).peerNegotiations;
    if (!(negotiations instanceof Map)) {
      throw new Error(
        'ToonClient.peerNegotiations layout changed — cannot inject apex negotiation'
      );
    }
    negotiations.set(apex.peerId, {
      chain: apex.chainKey,
      chainType: apex.chain,
      chainId: apex.chainId,
      settlementAddress: apex.settlementAddress,
      tokenAddress: apex.tokenAddress,
      tokenNetwork: apex.tokenNetwork,
    });
    this.log(`[runner] injected apex negotiation for peer "${apex.peerId}"`);
  }

  /**
   * Route additional apex CHILD peers (e.g. `dvm`, `mill`) through the SAME
   * apex payment channel. In the parent→child apex model the client holds ONE
   * channel with the apex (g.townhouse) and pays via it regardless of which
   * child the ILP destination addresses; but `ToonClient.resolvePeerId` keys off
   * the destination's last segment (`town`/`dvm`/`mill`), so without this each
   * child would (a) fail the "no negotiation for peer" guard and (b) try to open
   * a SECOND on-chain channel to the same apex receive (which reverts —
   * channel-exists). So: inject the same apex negotiation under each child peer
   * AND pre-map its peer→channel to the already-open apex channel so
   * `ensureChannel` reuses it (no second open; one shared nonce sequence).
   */
  private routeChildPeersThroughApexChannel(): void {
    const apex = this.config.apex;
    const children = this.config.apexChildPeers ?? [];
    if (!apex || !this.apexChannelId || children.length === 0) return;
    const client = this.client as unknown as {
      peerNegotiations?: Map<string, unknown>;
      channelManager?: { peerChannels?: Map<string, string> };
    };
    const negotiations = client.peerNegotiations;
    const peerChannels = client.channelManager?.peerChannels;
    if (!(negotiations instanceof Map) || !(peerChannels instanceof Map)) {
      this.log(
        '[runner] cannot route child peers — ToonClient internals layout changed'
      );
      return;
    }
    for (const peer of children) {
      if (peer === apex.peerId) continue;
      negotiations.set(peer, {
        chain: apex.chainKey,
        chainType: apex.chain,
        chainId: apex.chainId,
        settlementAddress: apex.settlementAddress,
        tokenAddress: apex.tokenAddress,
        tokenNetwork: apex.tokenNetwork,
      });
      peerChannels.set(peer, this.apexChannelId);
      this.log(
        `[runner] routed child peer "${peer}" through apex channel ${this.apexChannelId}`
      );
    }
  }

  isReady(): boolean {
    return this.ready;
  }

  isBootstrapping(): boolean {
    return this.bootstrapping;
  }

  getStatus(): StatusResponse {
    const net = this.client.getNetworkStatus();
    const network: ChainStatus[] | undefined = net
      ? (['evm', 'solana', 'mina'] as const).map((c) => ({
          chain: c,
          ready: net[c] === 'configured',
          detail: net[c],
        }))
      : undefined;
    return {
      uptimeMs: Date.now() - this.startedAt,
      bootstrapping: this.bootstrapping,
      ready: this.ready,
      settlementChain: this.config.chain,
      identity: {
        nostrPubkey: safe(() => this.client.getPublicKey()) ?? '',
        evmAddress: safe(() => this.client.getEvmAddress()),
        solanaAddress: safe(() => this.client.getSolanaAddress()),
        minaAddress: safe(() => this.client.getMinaAddress()),
      },
      transport: {
        type: this.config.socksProxy ? 'socks5' : 'direct',
        socksProxy: this.config.socksProxy,
        btpUrl: this.config.toonClientConfig.btpUrl,
      },
      relay: {
        url: this.config.relayUrl,
        connected: this.relay.isConnected(),
        buffered: this.relay.bufferedCount(),
        subscriptions: this.relay.activeSubscriptions(),
      },
      ...(network ? { network } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  /** Pay-to-write a single event. Throws NOT_READY while bootstrapping. */
  async publish(req: PublishRequest): Promise<PublishResponse> {
    this.assertReady();
    const channelId =
      this.apexChannelId ?? (await this.client.openChannel(req.destination));
    const fee =
      req.fee !== undefined ? BigInt(req.fee) : this.config.feePerEvent;
    const claim = await this.client.signBalanceProof(channelId, fee);
    const result = await this.client.publishEvent(req.event, {
      destination: req.destination,
      claim,
      ilpAmount: fee,
    });
    if (!result.success) {
      throw new PublishRejectedError(result.error ?? 'relay rejected event');
    }
    return {
      eventId: result.eventId ?? req.event.id,
      data: result.data,
      channelId,
      nonce: this.client.getChannelNonce(channelId),
    };
  }

  /** Register a free-read subscription (does not require the paid path). */
  subscribe(req: SubscribeRequest): SubscribeResponse {
    const subId = this.relay.subscribe(req.filters, req.subId);
    return { subId };
  }

  /** Drain buffered events newer than the cursor (free read). */
  getEvents(query: EventsQuery): EventsResponse {
    const opts: { subId?: string; cursor?: number; limit?: number } = {};
    if (query.subId !== undefined) opts.subId = query.subId;
    if (query.cursor !== undefined) opts.cursor = query.cursor;
    if (query.limit !== undefined) opts.limit = query.limit;
    const { events, cursor, hasMore } = this.relay.getEvents(opts);
    return { events, cursor, hasMore };
  }

  /** Open (or return) a payment channel for a destination. */
  async openChannel(destination?: string): Promise<{ channelId: string }> {
    this.assertReady();
    const channelId = await this.client.openChannel(
      destination ?? this.config.destination
    );
    if (!destination || destination === this.config.destination) {
      this.apexChannelId = channelId;
    }
    return { channelId };
  }

  /** List tracked channels with their nonce watermark + cumulative amount. */
  getChannels(): ChannelsResponse {
    const channels = this.client.getTrackedChannels().map((channelId) => ({
      channelId,
      nonce: this.client.getChannelNonce(channelId),
      cumulativeAmount: this.client
        .getChannelCumulativeAmount(channelId)
        .toString(),
    }));
    return { channels };
  }

  /** Send a swap packet to a mill peer. */
  async swap(req: SwapRequest): Promise<SwapResponse> {
    this.assertReady();
    const toonData = req.toonData
      ? new Uint8Array(Buffer.from(req.toonData, 'base64'))
      : new Uint8Array(0);
    const result = await this.client.sendSwapPacket({
      destination: req.destination,
      amount: BigInt(req.amount),
      toonData,
    });
    return {
      accepted: result.accepted,
      data: result.data,
      code: result.code,
      message: result.message,
    };
  }

  /** Graceful teardown of the relay subscription + ToonClient. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.relay.close();
    try {
      await this.client.stop();
    } catch (err) {
      this.log(
        `[runner] client stop error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private assertReady(): void {
    if (!this.ready) {
      throw new NotReadyError(
        this.bootstrapping
          ? 'Daemon is still bootstrapping (BTP/anon coming up) — retry shortly.'
          : (this.lastError ?? 'Daemon is not ready.')
      );
    }
  }
}

/** Thrown by paid-write operations while the daemon is not yet ready. */
export class NotReadyError extends Error {
  readonly retryable = true;
  constructor(message: string) {
    super(message);
    this.name = 'NotReadyError';
  }
}

/** Thrown when the relay/connector rejects a paid write. */
export class PublishRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublishRejectedError';
  }
}

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}
