/**
 * ClientRunner — the daemon's connection owner. The TOON client is 1-to-MANY:
 * it can write through several apexes (each a `ToonClient` + BTP session +
 * payment channel) and read from several relays (each a `RelaySubscription`).
 *
 * • Writes go through BTP, never to a relay directly — `publish`/`swap` select
 *   an apex (default: the config-seeded one).
 * • Reads FAN OUT — `subscribe`/`getEvents` apply across every relay and merge
 *   into one ordered stream with a single scalar cursor (the runner owns the
 *   merged buffer; each `RelaySubscription` mirrors new events into it).
 *
 * Targets are added at runtime (`addRelay`/`addApex`), persisted to
 * `targets.json`, replayed on the next boot, and removable. The config-seeded
 * relay + apex are the permanent DEFAULT targets and cannot be removed.
 *
 * Each apex bootstraps asynchronously and non-blocking: the connection comes up
 * in the background (the managed anon proxy alone can take 30–90s). Until ready,
 * writes against it report `bootstrapping` so tools surface "retry".
 */

import type { NostrEvent } from 'nostr-tools/pure';
import { generateSecretKey } from 'nostr-tools/pure';
import { decodeEventFromToon } from '@toon-protocol/core';
import { startManagedAnonProxy } from '@toon-protocol/client';
import type { ToonClientConfig } from '@toon-protocol/client';
import { streamSwap } from '@toon-protocol/sdk/swap';
import { RelaySubscription } from '../relay-subscription.js';
import type {
  AddApexRequest,
  AddApexResponse,
  ApexTargetStatus,
  ChannelsResponse,
  ChainStatus,
  EventsResponse,
  NostrFilter,
  PublishResponse,
  RelayTargetStatus,
  SettlementChain,
  StatusResponse,
  SubscribeRequest,
  SubscribeResponse,
  SwapResponse,
  TargetsResponse,
} from '../control-api.js';
import type {
  EventsQuery,
  PublishRequest,
  SwapRequest,
} from '../control-api.js';
import {
  configDir,
  type ApexNegotiationConfig,
  type ResolvedDaemonConfig,
} from './config.js';
import {
  loadApexChannel,
  saveApexChannel,
  type PersistedChannelContext,
} from './apex-channel-store.js';
import {
  loadTargets,
  removeApexTarget,
  removeRelayTarget,
  saveApexTarget,
  saveRelayTarget,
  type PersistedApexTarget,
} from './targets-store.js';
import { discoverApex } from './apex-discovery.js';

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

/** A started managed proxy: just the teardown handle the runner needs. */
export interface ManagedProxyHandle {
  stop(): Promise<void>;
}

/** Starts a managed `anon` read proxy on a loopback SOCKS port. */
export type StartReadProxy = (opts: {
  socksPort: number;
  log?: (msg: string) => void;
}) => Promise<ManagedProxyHandle>;

/** Builds a `ToonClient` (or a fake) for a given resolved client config. */
export type CreateClient = (config: ToonClientConfig) => ToonClientLike;

/** Builds a `RelaySubscription` for a given relay URL + optional read proxy. */
export type CreateRelay = (opts: {
  relayUrl: string;
  socksProxy?: string;
  onEvent: (subId: string, event: NostrEvent) => void;
  logger?: (msg: string) => void;
}) => RelaySubscription;

export interface ClientRunnerDeps {
  config: ResolvedDaemonConfig;
  /** Factory producing the (real or fake) ToonClient for a client config. */
  createClient: CreateClient;
  /** Factory producing a relay subscription (defaults to the real one). */
  createRelay?: CreateRelay;
  /**
   * Starts the daemon-managed read proxy (defaults to the real
   * `startManagedAnonProxy`). Injected so tests avoid the anon download/spawn.
   */
  startReadProxy?: StartReadProxy;
  logger?: (msg: string) => void;
  /** Path to the dynamic-targets store (tests override). */
  targetsPath?: string;
}

/** One apex write target: a BTP session + its payment channel + settlement. */
interface ApexConnection {
  btpUrl: string;
  client: ToonClientLike;
  negotiation?: ApexNegotiationConfig;
  childPeers: string[];
  destination: string;
  chain: SettlementChain;
  /** Per-apex channel-store path (distinct so parallel apexes don't race it). */
  channelStorePath: string;
  feePerEvent: bigint;
  apexChannelId?: string;
  ready: boolean;
  bootstrapping: boolean;
  /** In-flight bootstrap, so concurrent callers await the same work (not re-run). */
  bootstrapPromise?: Promise<void>;
  lastError?: string;
  isDefault: boolean;
}

/** A runner-level merged read-buffer entry, tagged with its source relay. */
interface MergedEvent {
  seq: number;
  relayUrl: string;
  subId: string;
  event: NostrEvent;
}

const MERGED_BUFFER = 5000;

export class ClientRunner {
  private readonly config: ResolvedDaemonConfig;
  private readonly createClient: CreateClient;
  private readonly createRelay: CreateRelay;
  private readonly startReadProxy: StartReadProxy;
  private readonly log: (msg: string) => void;
  private readonly targetsPath?: string;

  private readonly startedAt = Date.now();

  /** Apex write targets, keyed by btpUrl. */
  private readonly apexes = new Map<string, ApexConnection>();
  /** Relay read targets, keyed by relayUrl. */
  private readonly relays = new Map<string, RelaySubscription>();

  /** Runner-level merged read buffer across all relays (de-duped by event.id). */
  private merged: MergedEvent[] = [];
  private readonly mergedSeen = new Set<string>();
  private mergedSeq = 0;

  /**
   * Fan-out subscriptions (no relayUrl restriction): replayed onto relays added
   * later so a new relay immediately participates in existing reads.
   */
  private readonly fanoutSubs = new Map<string, NostrFilter[]>();
  private subIdCounter = 0;

  private readonly defaultBtpUrl: string;
  private readonly defaultRelayUrl: string;

  /** Teardown for the daemon-managed read proxy (btp-direct + relay-`.anyone`). */
  private stopReadProxy: (() => Promise<void>) | undefined;
  private readProxyError: string | undefined;
  private stopped = false;
  private started = false;

  constructor(deps: ClientRunnerDeps) {
    this.config = deps.config;
    this.createClient = deps.createClient;
    this.log = deps.logger ?? ((): void => undefined);
    if (deps.targetsPath !== undefined) this.targetsPath = deps.targetsPath;
    this.defaultBtpUrl = deps.config.toonClientConfig.btpUrl ?? '';
    this.defaultRelayUrl = deps.config.relayUrl;

    this.createRelay =
      deps.createRelay ??
      ((opts) =>
        new RelaySubscription({
          relayUrl: opts.relayUrl,
          ...(opts.socksProxy ? { socksProxy: opts.socksProxy } : {}),
          ...(opts.logger ? { logger: opts.logger } : {}),
          onEvent: opts.onEvent,
          // The TOON relay sends events TOON-encoded (text) on reads, not JSON.
          decodeEvent: (raw) =>
            decodeEventFromToon(new TextEncoder().encode(raw)),
        }));

    this.startReadProxy =
      deps.startReadProxy ??
      ((opts) =>
        startManagedAnonProxy({
          socksPort: opts.socksPort,
          ...(opts.log ? { log: opts.log } : {}),
        }));

    // Build the permanent config-seeded default relay + apex up front (not yet
    // started/bootstrapped) so `bootstrap()` works standalone (the daemon and
    // tests both rely on constructing then awaiting bootstrap()).
    this.registerRelay(this.defaultRelayUrl, this.config.socksProxy);
    const defaultApex = this.makeApex({
      btpUrl: this.defaultBtpUrl,
      client: this.createClient(this.config.toonClientConfig),
      ...(this.config.apex ? { negotiation: this.config.apex } : {}),
      childPeers: this.config.apexChildPeers ?? [],
      destination: this.config.destination,
      chain: this.config.chain,
      channelStorePath:
        this.config.toonClientConfig.channelStorePath ??
        this.apexChannelStorePathFor(this.defaultBtpUrl),
      feePerEvent: this.config.feePerEvent,
      isDefault: true,
    });
    this.apexes.set(defaultApex.btpUrl, defaultApex);
  }

  /**
   * Start the live connections: the shared read proxy, every relay socket, the
   * default apex bootstrap (non-blocking), then replay persisted dynamic
   * targets. Returns immediately; apexes become ready asynchronously.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    // The managed read proxy is shared by every relay; start it once up front.
    if (this.config.manageReadProxy) void this.bringUpReadProxy();
    for (const relay of this.relays.values()) relay.start();
    void this.bootstrap();
    this.replayPersistedTargets();
  }

  /** Await the default apex's bootstrap (kicking it off if not already running). */
  bootstrap(): Promise<void> {
    const apex = this.apexes.get(this.defaultBtpUrl);
    if (!apex) return Promise.resolve();
    return this.bootstrapApex(apex);
  }

  // ── Relays (reads) ─────────────────────────────────────────────────────────

  /**
   * Build + register a relay (idempotent by URL), wiring its events into the
   * merged buffer and replaying active fan-out subscriptions. Does NOT start the
   * socket — callers start it (so construction stays side-effect-free for tests).
   */
  private registerRelay(
    relayUrl: string,
    socksProxy?: string
  ): RelaySubscription {
    const existing = this.relays.get(relayUrl);
    if (existing) return existing;
    const relay = this.createRelay({
      relayUrl,
      ...(socksProxy ? { socksProxy } : {}),
      logger: this.log,
      onEvent: (subId, event) => this.pushMerged(relayUrl, subId, event),
    });
    this.relays.set(relayUrl, relay);
    // A new relay joins every active fan-out subscription.
    for (const [subId, filters] of this.fanoutSubs)
      relay.subscribe(filters, subId);
    return relay;
  }

  /**
   * Add a relay read target at runtime. `.anyone` relays reuse the managed read
   * proxy (started here if needed). Persisted unless `persist` is false.
   */
  async addRelay(relayUrl: string, persist = true): Promise<void> {
    if (this.relays.has(relayUrl)) return;
    let socksProxy = this.config.socksProxy;
    if (isAnyoneHost(relayUrl) && !socksProxy) {
      await this.ensureReadProxy();
      socksProxy = `socks5h://127.0.0.1:${this.config.readProxySocksPort ?? 9050}`;
    }
    const relay = this.registerRelay(relayUrl, socksProxy);
    relay.start();
    if (persist) saveRelayTarget(relayUrl, this.targetsPath);
  }

  /** Remove a relay read target. The config-seeded default cannot be removed. */
  removeRelay(relayUrl: string): void {
    if (relayUrl === this.defaultRelayUrl) {
      throw new TargetError('Cannot remove the default (config-seeded) relay.');
    }
    const relay = this.relays.get(relayUrl);
    if (!relay) throw new TargetError(`No such relay: ${relayUrl}`);
    relay.close();
    this.relays.delete(relayUrl);
    // Drop its events from the merged buffer (and dedup index).
    this.merged = this.merged.filter((m) => {
      if (m.relayUrl === relayUrl) {
        this.mergedSeen.delete(m.event.id);
        return false;
      }
      return true;
    });
    removeRelayTarget(relayUrl, this.targetsPath);
  }

  /** Mirror a newly-buffered relay event into the merged cross-relay buffer. */
  private pushMerged(relayUrl: string, subId: string, event: NostrEvent): void {
    if (this.mergedSeen.has(event.id)) return;
    this.mergedSeen.add(event.id);
    this.merged.push({ seq: ++this.mergedSeq, relayUrl, subId, event });
    if (this.merged.length > MERGED_BUFFER) {
      const evicted = this.merged.shift();
      if (evicted) this.mergedSeen.delete(evicted.event.id);
    }
  }

  /**
   * Register a free-read subscription. With no `relayUrl` it FANS OUT across
   * every relay (and onto relays added later); with one it targets that relay.
   */
  subscribe(req: SubscribeRequest): SubscribeResponse {
    const subId = req.subId ?? `sub-${++this.subIdCounter}`;
    const filters = Array.isArray(req.filters) ? req.filters : [req.filters];
    const targets = req.relayUrl ? [req.relayUrl] : [...this.relays.keys()];
    if (req.relayUrl && !this.relays.has(req.relayUrl)) {
      throw new TargetError(`No such relay: ${req.relayUrl}`);
    }
    if (!req.relayUrl) this.fanoutSubs.set(subId, filters);
    for (const url of targets) this.relays.get(url)?.subscribe(filters, subId);
    return { subId, relays: targets };
  }

  /** Drain merged events newer than the cursor (free read), optionally scoped. */
  getEvents(query: EventsQuery): EventsResponse {
    const after = query.cursor ?? 0;
    const limit = query.limit ?? 200;
    const matches = this.merged.filter(
      (m) =>
        m.seq > after &&
        (query.subId === undefined || m.subId === query.subId) &&
        (query.relayUrl === undefined || m.relayUrl === query.relayUrl)
    );
    const page = matches.slice(0, limit);
    const hasMore = matches.length > page.length;
    const last = page.at(-1);
    return {
      events: page.map((m) => m.event),
      cursor: last ? last.seq : after,
      hasMore,
    };
  }

  // ── Apexes (writes) ──────────────────────────────────────────────────────

  private makeApex(init: {
    btpUrl: string;
    client: ToonClientLike;
    negotiation?: ApexNegotiationConfig;
    childPeers: string[];
    destination: string;
    chain: SettlementChain;
    channelStorePath: string;
    feePerEvent: bigint;
    isDefault: boolean;
  }): ApexConnection {
    return {
      ...init,
      ready: false,
      bootstrapping: false,
    };
  }

  /**
   * Bootstrap one apex (memoized): start, inject negotiation, open/resume the
   * channel, route child peers. Concurrent callers await the same in-flight
   * work rather than re-running it.
   */
  private bootstrapApex(apex: ApexConnection): Promise<void> {
    if (apex.ready) return Promise.resolve();
    if (!apex.bootstrapPromise) {
      apex.bootstrapPromise = this.doBootstrapApex(apex);
    }
    return apex.bootstrapPromise;
  }

  private async doBootstrapApex(apex: ApexConnection): Promise<void> {
    apex.bootstrapping = true;
    try {
      await apex.client.start();
      this.injectApexNegotiation(apex);
      apex.apexChannelId = await this.openOrResumeApexChannel(apex);
      this.routeChildPeersThroughApexChannel(apex);
      apex.ready = true;
      apex.lastError = undefined;
      this.log(
        `[runner] apex ${apex.btpUrl} ready; channel ${apex.apexChannelId}`
      );
    } catch (err) {
      apex.lastError = err instanceof Error ? err.message : String(err);
      this.log(
        `[runner] apex ${apex.btpUrl} bootstrap failed: ${apex.lastError}`
      );
    } finally {
      apex.bootstrapping = false;
    }
  }

  /**
   * Add an apex write target. Settlement params are discovered by reading the
   * apex's kind:10032 off the given relay (added first if unknown). Persisted.
   */
  async addApex(req: AddApexRequest): Promise<AddApexResponse> {
    await this.addRelay(req.relayUrl); // ensure + persist the discovery relay
    const relay = this.relays.get(req.relayUrl);
    if (!relay) throw new TargetError(`Relay unavailable: ${req.relayUrl}`);

    const discovered = await discoverApex({
      relay,
      ilpAddress: req.ilpAddress,
      ...(req.pubkey ? { pubkey: req.pubkey } : {}),
      ...(req.chain ? { chain: req.chain } : {}),
      ...(req.childPeers ? { childPeers: req.childPeers } : {}),
    });

    const feePerEvent =
      req.feePerEvent !== undefined
        ? BigInt(req.feePerEvent)
        : this.config.feePerEvent;

    await this.instantiateApex(
      {
        btpUrl: discovered.btpUrl,
        negotiation: discovered.negotiation,
        ...(discovered.apexChildPeers
          ? { apexChildPeers: discovered.apexChildPeers }
          : {}),
        feePerEvent: req.feePerEvent ?? feePerEvent.toString(),
        discoveredFrom: req.relayUrl,
      },
      true
    );

    const apex = this.apexes.get(discovered.btpUrl);
    if (!apex) {
      throw new TargetError(
        `Apex ${discovered.btpUrl} failed to register after discovery.`
      );
    }
    return {
      btpUrl: apex.btpUrl,
      destination: apex.destination,
      chain: apex.chain,
      ready: apex.ready,
    };
  }

  /** Build + register + bootstrap an apex from a (persisted) target record. */
  private async instantiateApex(
    target: PersistedApexTarget,
    persist: boolean
  ): Promise<void> {
    if (this.apexes.has(target.btpUrl)) return;
    const clientConfig = this.deriveApexClientConfig(
      target.btpUrl,
      target.negotiation.destination
    );
    const apex = this.makeApex({
      btpUrl: target.btpUrl,
      client: this.createClient(clientConfig),
      negotiation: target.negotiation,
      childPeers: target.apexChildPeers ?? [],
      destination: target.negotiation.destination,
      chain: target.negotiation.chain,
      channelStorePath: this.apexChannelStorePathFor(target.btpUrl),
      feePerEvent: BigInt(target.feePerEvent ?? this.config.feePerEvent),
      isDefault: false,
    });
    this.apexes.set(apex.btpUrl, apex);
    if (persist) saveApexTarget(target, this.targetsPath);
    await this.bootstrapApex(apex);
  }

  /** Remove an apex write target. The config-seeded default cannot be removed. */
  async removeApex(btpUrl: string): Promise<void> {
    if (btpUrl === this.defaultBtpUrl) {
      throw new TargetError('Cannot remove the default (config-seeded) apex.');
    }
    const apex = this.apexes.get(btpUrl);
    if (!apex) throw new TargetError(`No such apex: ${btpUrl}`);
    try {
      await apex.client.stop();
    } catch (err) {
      this.log(
        `[runner] apex ${btpUrl} stop error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    this.apexes.delete(btpUrl);
    removeApexTarget(btpUrl, this.targetsPath);
  }

  /** Derive a per-apex ToonClientConfig from the default (shared identity/transport). */
  private deriveApexClientConfig(
    btpUrl: string,
    destination: string
  ): ToonClientConfig {
    const base = this.config.toonClientConfig;
    return {
      ...base,
      btpUrl,
      destinationAddress: destination,
      // Distinct nonce-watermark store per apex so parallel ChannelManagers in
      // this process never race a shared channels.json.
      channelStorePath: this.apexChannelStorePathFor(btpUrl),
      ilpInfo: { ...base.ilpInfo, btpEndpoint: btpUrl },
    };
  }

  private apexChannelStorePathFor(btpUrl: string): string {
    return `${configDir()}/channels-${sanitize(btpUrl)}.json`;
  }

  // ── Persisted-target replay ────────────────────────────────────────────────

  private replayPersistedTargets(): void {
    let store;
    try {
      store = loadTargets(this.targetsPath);
    } catch (err) {
      this.log(
        `[runner] failed to load targets store: ${err instanceof Error ? err.message : String(err)}`
      );
      return;
    }
    for (const r of store.relays) {
      if (r.relayUrl === this.defaultRelayUrl) continue;
      void this.addRelay(r.relayUrl, false).catch((err) =>
        this.log(`[runner] replay relay ${r.relayUrl} failed: ${errMsg(err)}`)
      );
    }
    for (const a of store.apexes) {
      if (a.btpUrl === this.defaultBtpUrl) continue;
      void this.instantiateApex(a, false).catch((err) =>
        this.log(`[runner] replay apex ${a.btpUrl} failed: ${errMsg(err)}`)
      );
    }
  }

  // ── Shared read proxy ──────────────────────────────────────────────────────

  private async ensureReadProxy(): Promise<void> {
    if (this.stopReadProxy) return;
    await this.bringUpReadProxy();
  }

  private async bringUpReadProxy(): Promise<void> {
    if (this.stopReadProxy) return;
    const socksPort = this.config.readProxySocksPort ?? 9050;
    try {
      this.log(
        `[runner] starting managed read proxy on 127.0.0.1:${socksPort}`
      );
      const proxy = await this.startReadProxy({
        socksPort,
        log: (m) => this.log(`[anon] ${m}`),
      });
      if (this.stopped) {
        await proxy.stop();
        return;
      }
      this.stopReadProxy = () => proxy.stop();
      this.readProxyError = undefined;
      this.log('[runner] managed read proxy ready');
    } catch (err) {
      this.readProxyError = err instanceof Error ? err.message : String(err);
      this.log(`[runner] managed read proxy failed: ${this.readProxyError}`);
    }
  }

  // ── Channel / negotiation helpers (per-apex) ───────────────────────────────

  /** Open the apex channel — or, on a restart, RESUME the existing one. */
  private async openOrResumeApexChannel(apex: ApexConnection): Promise<string> {
    const { destination, chain } = apex;
    const { apexChannelStorePath } = this.config;
    const saved = loadApexChannel(apexChannelStorePath, destination, chain);
    const cm = (
      apex.client as unknown as {
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

    const channelId = await apex.client.openChannel(destination);
    if (apex.negotiation) {
      const a = apex.negotiation;
      saveApexChannel(apexChannelStorePath, destination, chain, {
        channelId,
        context: {
          chainType: a.chain,
          chainId: a.chainId,
          tokenNetworkAddress: a.tokenNetwork ?? '',
          ...(a.tokenAddress ? { tokenAddress: a.tokenAddress } : {}),
          recipient: a.settlementAddress,
        },
      });
    }
    return channelId;
  }

  /** Inject the apex settlement negotiation directly into its ToonClient. */
  private injectApexNegotiation(apex: ApexConnection): void {
    const a = apex.negotiation;
    if (!a) return;
    const negotiations = (
      apex.client as unknown as { peerNegotiations?: Map<string, unknown> }
    ).peerNegotiations;
    if (!(negotiations instanceof Map)) {
      throw new Error(
        'ToonClient.peerNegotiations layout changed — cannot inject apex negotiation'
      );
    }
    negotiations.set(a.peerId, {
      chain: a.chainKey,
      chainType: a.chain,
      chainId: a.chainId,
      settlementAddress: a.settlementAddress,
      tokenAddress: a.tokenAddress,
      tokenNetwork: a.tokenNetwork,
    });
    this.log(`[runner] injected apex negotiation for peer "${a.peerId}"`);
  }

  /** Route apex CHILD peers (dvm/mill) through the SAME apex payment channel. */
  private routeChildPeersThroughApexChannel(apex: ApexConnection): void {
    const a = apex.negotiation;
    if (!a || !apex.apexChannelId || apex.childPeers.length === 0) return;
    const client = apex.client as unknown as {
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
    for (const peer of apex.childPeers) {
      if (peer === a.peerId) continue;
      negotiations.set(peer, {
        chain: a.chainKey,
        chainType: a.chain,
        chainId: a.chainId,
        settlementAddress: a.settlementAddress,
        tokenAddress: a.tokenAddress,
        tokenNetwork: a.tokenNetwork,
      });
      peerChannels.set(peer, apex.apexChannelId);
      this.log(
        `[runner] routed child peer "${peer}" through apex channel ${apex.apexChannelId}`
      );
    }
  }

  // ── Status ─────────────────────────────────────────────────────────────────

  private defaultApex(): ApexConnection | undefined {
    return this.apexes.get(this.defaultBtpUrl);
  }

  /** Whether any apex has finished bootstrapping. */
  isReady(): boolean {
    return [...this.apexes.values()].some((a) => a.ready);
  }

  isBootstrapping(): boolean {
    return [...this.apexes.values()].some((a) => a.bootstrapping);
  }

  getStatus(): StatusResponse {
    const apex = this.defaultApex();
    const client = apex?.client;
    const net = client?.getNetworkStatus();
    const network: ChainStatus[] | undefined = net
      ? (['evm', 'solana', 'mina'] as const).map((c) => ({
          chain: c,
          ready: net[c] === 'configured',
          detail: net[c],
        }))
      : undefined;
    const relay = this.relays.get(this.defaultRelayUrl);
    return {
      uptimeMs: Date.now() - this.startedAt,
      bootstrapping: apex?.bootstrapping ?? false,
      ready: apex?.ready ?? false,
      settlementChain: this.config.chain,
      identity: {
        nostrPubkey: safe(() => client?.getPublicKey()) ?? '',
        evmAddress: safe(() => client?.getEvmAddress()),
        solanaAddress: safe(() => client?.getSolanaAddress()),
        minaAddress: safe(() => client?.getMinaAddress()),
      },
      transport: {
        type: this.config.socksProxy ? 'socks5' : 'direct',
        ...(this.config.socksProxy
          ? { socksProxy: this.config.socksProxy }
          : {}),
        ...(apex ? { btpUrl: apex.btpUrl } : {}),
      },
      relay: {
        url: this.defaultRelayUrl,
        connected: relay?.isConnected() ?? false,
        buffered: relay?.bufferedCount() ?? 0,
        subscriptions: relay?.activeSubscriptions() ?? [],
        ...(this.readProxyError ? { proxyError: this.readProxyError } : {}),
      },
      ...(network ? { network } : {}),
      ...(apex?.lastError ? { lastError: apex.lastError } : {}),
    };
  }

  /** Full registry of relay + apex targets with per-target status. */
  getTargets(): TargetsResponse {
    const relays: RelayTargetStatus[] = [...this.relays.entries()].map(
      ([relayUrl, r]) => ({
        relayUrl,
        connected: r.isConnected(),
        buffered: r.bufferedCount(),
        subscriptions: r.activeSubscriptions(),
        isDefault: relayUrl === this.defaultRelayUrl,
      })
    );
    const apexes: ApexTargetStatus[] = [...this.apexes.values()].map((a) => ({
      btpUrl: a.btpUrl,
      destination: a.destination,
      chain: a.chain,
      ready: a.ready,
      bootstrapping: a.bootstrapping,
      ...(a.apexChannelId ? { channelId: a.apexChannelId } : {}),
      ...(a.lastError ? { lastError: a.lastError } : {}),
      isDefault: a.isDefault,
    }));
    return { relays, apexes };
  }

  // ── Paid operations ──────────────────────────────────────────────────────

  /** Pay-to-write a single event through the selected (or default) apex. */
  async publish(req: PublishRequest): Promise<PublishResponse> {
    const apex = this.selectApex(req.btpUrl);
    this.assertApexReady(apex);
    const channelId =
      apex.apexChannelId ?? (await apex.client.openChannel(req.destination));
    const fee = req.fee !== undefined ? BigInt(req.fee) : apex.feePerEvent;
    const claim = await apex.client.signBalanceProof(channelId, fee);
    const result = await apex.client.publishEvent(req.event, {
      ...(req.destination ? { destination: req.destination } : {}),
      claim,
      ilpAmount: fee,
    });
    if (!result.success) {
      throw new PublishRejectedError(result.error ?? 'relay rejected event');
    }
    return {
      eventId: result.eventId ?? req.event.id,
      ...(result.data !== undefined ? { data: result.data } : {}),
      channelId,
      nonce: apex.client.getChannelNonce(channelId),
    };
  }

  /** Open (or return) a payment channel on the selected (or default) apex. */
  async openChannel(
    destination?: string,
    btpUrl?: string
  ): Promise<{ channelId: string }> {
    const apex = this.selectApex(btpUrl);
    this.assertApexReady(apex);
    const channelId = await apex.client.openChannel(
      destination ?? apex.destination
    );
    if (!destination || destination === apex.destination) {
      apex.apexChannelId = channelId;
    }
    return { channelId };
  }

  /** List tracked channels across ALL apexes with nonce + cumulative amount. */
  getChannels(): ChannelsResponse {
    const seen = new Set<string>();
    const channels: ChannelsResponse['channels'] = [];
    for (const apex of this.apexes.values()) {
      for (const channelId of apex.client.getTrackedChannels()) {
        if (seen.has(channelId)) continue;
        seen.add(channelId);
        channels.push({
          channelId,
          nonce: apex.client.getChannelNonce(channelId),
          cumulativeAmount: apex.client
            .getChannelCumulativeAmount(channelId)
            .toString(),
        });
      }
    }
    return { channels };
  }

  /** Swap source→target asset against a mill peer via the selected apex. */
  async swap(req: SwapRequest): Promise<SwapResponse> {
    const apex = this.selectApex(req.btpUrl);
    this.assertApexReady(apex);
    const senderSecretKey = generateSecretKey();
    const result = await streamSwap({
      client: apex.client as unknown as Parameters<
        typeof streamSwap
      >[0]['client'],
      millPubkey: req.millPubkey,
      millIlpAddress: req.destination,
      pair: req.pair,
      senderSecretKey,
      chainRecipient: req.chainRecipient,
      totalAmount: BigInt(req.amount),
      packetCount: req.packetCount ?? 1,
    });
    const firstReject = result.rejections[0];
    return {
      accepted: result.claims.length > 0,
      packetsAccepted: result.claims.length,
      claims: result.claims.map((c) => ({
        sourceAmount: c.sourceAmount.toString(),
        targetAmount: c.targetAmount.toString(),
        claim: Buffer.from(c.claimBytes).toString('base64'),
        ...(c.channelId ? { channelId: c.channelId } : {}),
        ...(c.recipient ? { recipient: c.recipient } : {}),
        ...(c.millSignerAddress
          ? { millSignerAddress: c.millSignerAddress }
          : {}),
        ...(c.claimId ? { claimId: c.claimId } : {}),
        ...(c.nonce ? { nonce: c.nonce } : {}),
        ...(c.cumulativeAmount ? { cumulativeAmount: c.cumulativeAmount } : {}),
      })),
      cumulativeSource: result.cumulativeSource.toString(),
      cumulativeTarget: result.cumulativeTarget.toString(),
      state: result.state,
      ...(firstReject
        ? { code: firstReject.code, message: firstReject.message }
        : {}),
    };
  }

  /** Graceful teardown: close every relay + stop every apex client + read proxy. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const relay of this.relays.values()) relay.close();
    if (this.stopReadProxy) {
      try {
        await this.stopReadProxy();
      } catch (err) {
        this.log(`[runner] read proxy stop error: ${errMsg(err)}`);
      }
      this.stopReadProxy = undefined;
    }
    for (const apex of this.apexes.values()) {
      try {
        await apex.client.stop();
      } catch (err) {
        this.log(`[runner] client stop error (${apex.btpUrl}): ${errMsg(err)}`);
      }
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  private selectApex(btpUrl?: string): ApexConnection {
    if (btpUrl) {
      const apex = this.apexes.get(btpUrl);
      if (!apex) throw new TargetError(`No such apex: ${btpUrl}`);
      return apex;
    }
    const def = this.defaultApex();
    if (!def) throw new NotReadyError('No apex configured.');
    return def;
  }

  private assertApexReady(apex: ApexConnection): void {
    if (!apex.ready) {
      throw new NotReadyError(
        apex.bootstrapping
          ? 'Apex is still bootstrapping (BTP/anon coming up) — retry shortly.'
          : (apex.lastError ?? 'Apex is not ready.')
      );
    }
  }
}

/** Thrown by paid-write operations while the target apex is not yet ready. */
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

/** Thrown for invalid target add/remove/select operations (maps to HTTP 400/404). */
export class TargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TargetError';
  }
}

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Filesystem-safe slug for a per-apex channel-store filename. */
function sanitize(s: string): string {
  return s
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function isAnyoneHost(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith('.anyone');
  } catch {
    return false;
  }
}
