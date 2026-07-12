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
 * in the background. Until ready, writes against it report `bootstrapping` so
 * tools surface "retry".
 */

import { readFile, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { NostrEvent, EventTemplate } from 'nostr-tools/pure';
import { generateSecretKey } from 'nostr-tools/pure';
import { decodeEventFromToon } from '@toon-protocol/core';
import {
  STATUS_APPLIED_KIND,
  STATUS_CLOSED_KIND,
  STATUS_DRAFT_KIND,
  STATUS_OPEN_KIND,
  REPOSITORY_ANNOUNCEMENT_KIND,
} from '@toon-protocol/core/nip34';
import { arweaveUrls } from '@toon-protocol/arweave';
import type { ToonClientConfig } from '@toon-protocol/client';
import {
  extractArweaveTxId,
  fundWallet as faucetFund,
  mintExecutionCondition,
  type FaucetChain,
} from '@toon-protocol/client';
import {
  GitRepoReader,
  buildComment,
  buildIssue,
  buildPatch,
  buildStatus,
  executePush,
  fetchRemoteState,
  planPush,
  type Publisher,
  type PublishReceipt,
  type PushPlan,
  type PushResult,
  type RemoteState,
  type StatusKind,
  type UnsignedEvent,
  type UploadReceipt,
  type GitObjectUpload,
} from '@toon-protocol/rig';
import { streamSwap } from '@toon-protocol/sdk/swap';
import {
  AdaptiveDeltaController,
  JsonFileSwapControllerStateStore,
  type PacketProgress,
} from '@toon-protocol/sdk';
import { RelaySubscription } from '../relay-subscription.js';
import type {
  AddApexRequest,
  AddApexResponse,
  ApexTargetStatus,
  BalanceInfo,
  BalancesResponse,
  ChannelDepositRequest,
  ChannelDepositResponse,
  CloseChannelRequest,
  CloseChannelResponse,
  SettleChannelRequest,
  SettleChannelResponse,
  ChannelsResponse,
  ChainStatus,
  EventsResponse,
  FundStatusResponse,
  FundWalletRequest,
  FundWalletResponse,
  GitCommentRequest,
  GitEstimateRequest,
  GitEstimateResponse,
  GitEventResponse,
  GitFeeEstimate,
  GitIssueRequest,
  GitPatchRequest,
  GitPushRequest,
  GitPushResponse,
  GitRepoAddr,
  GitStatusRequest,
  HttpFetchPaidRequest,
  HttpFetchPaidResponse,
  NostrFilter,
  PublishResponse,
  PublishUnsignedRequest,
  RelayTargetStatus,
  SettlementChain,
  StatusResponse,
  SubscribeRequest,
  SubscribeResponse,
  SwapControllerParams,
  SwapPacketOutcome,
  SwapResponse,
  TargetsResponse,
  UploadMediaRequest,
  UploadMediaResponse,
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
    options?: {
      destination?: string;
      claim?: unknown;
      ilpAmount?: bigint;
      /** HTTP request-target the payment-proxy replays (default '/write';
       *  '/store' routes to the Arweave store/DVM backend). */
      proxyPath?: string;
    }
  ): Promise<{
    success: boolean;
    eventId?: string;
    data?: string;
    error?: string;
  }>;
  signBalanceProof(channelId: string, amount: bigint): Promise<unknown>;
  /**
   * Sign an unsigned event template with the daemon-held Nostr key (the key
   * never leaves the daemon). Backs the `publish-unsigned` / `upload-media`
   * paths so a UI/agent supplies only the event shell.
   */
  signEvent(template: EventTemplate): NostrEvent | Promise<NostrEvent>;
  /**
   * Upload bytes to Arweave via the kind:5094 blob-storage DVM (single-packet),
   * returning the Arweave tx id. Reuses the client's claim/channel plumbing.
   */
  uploadBlob(params: {
    blobData: Uint8Array;
    contentType?: string;
    bid?: string;
    destination?: string;
    ilpAmount?: bigint;
  }): Promise<{ success: boolean; txId?: string; eventId?: string; error?: string }>;
  openChannel(destination?: string): Promise<string>;
  getTrackedChannels(): string[];
  getChannelNonce(channelId: string): number;
  getChannelCumulativeAmount(channelId: string): bigint;
  getChannelDepositTotal(channelId: string): bigint;
  getBalances(): Promise<BalanceInfo[]>;
  depositToChannel(
    channelId: string,
    amount: string
  ): Promise<{ channelId: string; txHash?: string; depositTotal: string }>;
  closeChannel(
    channelId: string
  ): Promise<{ channelId: string; txHash?: string; closedAt: string; settleableAt: string }>;
  settleChannel(channelId: string): Promise<{ channelId: string; txHash?: string }>;
  getChannelCloseState(channelId: string): 'open' | 'closing' | 'settleable' | 'settled';
  getSettleableAt(channelId: string): bigint | undefined;
  /**
   * Re-read a resumed channel's on-chain deposit (persisted state omits it).
   * Optional so lightweight fakes need not implement it; the real ToonClient
   * does. Best-effort — callers await + catch.
   */
  rehydrateChannelDeposit?(
    channelId: string,
    opts: { chain: string; tokenNetworkAddress: string }
  ): Promise<bigint | undefined>;
  sendSwapPacket(params: {
    destination: string;
    amount: bigint;
    toonData: Uint8Array;
    claim?: unknown;
    /**
     * Sender-chosen 32-byte execution condition (toon-client#350). The
     * transport puts it on the PREPARE and verifies the FULFILL preimage
     * (`sha256(fulfillment) == condition`); absent/all-zero = legacy packet.
     */
    executionCondition?: Uint8Array;
    /** Explicit ILP expiry; defaults to `now + timeout` in the transport. */
    expiresAt?: Date;
  }): Promise<{
    accepted: boolean;
    data?: string;
    code?: string;
    message?: string;
  }>;
  /**
   * Payment-aware HTTP fetch: issue the request and, on a `402 Payment
   * Required`, transparently pay over TOON and retry, returning the settled Web
   * `Response`. Pinned to the `ToonClient.h402Fetch` shape (issue #50).
   */
  h402Fetch(
    url: string,
    opts?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string | Uint8Array;
      timeout?: number;
      destination?: string;
    }
  ): Promise<Response>;
}

/** A started managed proxy: just the teardown handle the runner needs. */
/** Builds a `ToonClient` (or a fake) for a given resolved client config. */
export type CreateClient = (config: ToonClientConfig) => ToonClientLike;

/** Builds a `RelaySubscription` for a given relay URL. */
export type CreateRelay = (opts: {
  relayUrl: string;
  onEvent: (subId: string, event: NostrEvent) => void;
  logger?: (msg: string) => void;
}) => RelaySubscription;

export interface ClientRunnerDeps {
  config: ResolvedDaemonConfig;
  /** Factory producing the (real or fake) ToonClient for a client config. */
  createClient: CreateClient;
  /** Factory producing a relay subscription (defaults to the real one). */
  createRelay?: CreateRelay;
  logger?: (msg: string) => void;
  /** Path to the dynamic-targets store (tests override). */
  targetsPath?: string;
  /**
   * Test seams for the `/git/*` pipeline (default: the real
   * @toon-protocol/rig implementations). `fetchRemoteState` opens relay
   * WebSockets, so tests inject a canned reader instead of hitting the network.
   */
  gitDeps?: {
    fetchRemoteState?: typeof fetchRemoteState;
    createRepoReader?: (repoPath: string) => GitRepoReader;
  };
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

/**
 * Per-attempt bound for an on-chain balance read, kept WELL under the control
 * client's `/balances` timeout (12s) so a stalled provider fast-fails inside the
 * daemon instead of letting the whole control request hang to the wire timeout
 * (#199). With {@link BALANCES_READ_ATTEMPTS} the worst case stays under 12s.
 */
const BALANCES_READ_TIMEOUT_MS = 5_000;
/** Bounded retry for a transient provider stall on a balance read (#199). */
const BALANCES_READ_ATTEMPTS = 2;

/**
 * In-memory record of one background faucet drip. Structurally identical to the
 * wire {@link FundWalletResponse} snapshot the daemon returns, so a job can be
 * handed back verbatim.
 */
type FundJob = FundWalletResponse;

export class ClientRunner {
  private readonly config: ResolvedDaemonConfig;
  private readonly createClient: CreateClient;
  private readonly createRelay: CreateRelay;
  private readonly log: (msg: string) => void;
  private readonly targetsPath?: string;

  /** Remote-state reader for `/git/*` (injectable — opens relay sockets). */
  private readonly fetchGitRemoteState: typeof fetchRemoteState;
  /** Local-repo reader factory for `/git/*` (injectable for tests). */
  private readonly createRepoReader: (repoPath: string) => GitRepoReader;

  /**
   * Identity-level chain-read client. Reading your OWN on-chain wallet balance is
   * a pure (wallet keys + chain RPC) operation that has nothing to do with the
   * ILP/payment peer, so it lives at the daemon level rather than inside an apex.
   * Built once from the daemon's own `toonClientConfig` (the same keys + chain
   * RPC config every apex shares) and REUSED as the default apex's client, so a
   * funded apex's `start()` (which derives Solana/Mina keys) also benefits this
   * reader. `getBalances` uses it directly, so balances work even with zero
   * apexes registered (follow-up to #199/#200).
   */
  private readonly identityClient: ToonClientLike;

  private readonly startedAt = Date.now();

  /** Apex write targets, keyed by btpUrl. */
  private readonly apexes = new Map<string, ApexConnection>();
  /** Relay read targets, keyed by relayUrl. */
  private readonly relays = new Map<string, RelaySubscription>();

  /**
   * Async faucet drip jobs, keyed by chain. A drip is launched in the background
   * (the Mina faucet legitimately takes ~75s — longer than the MCP host's ~60s
   * tool-call budget) and its terminal state is observed via {@link getFundStatus}
   * / re-reading balances rather than by blocking the caller.
   */
  private readonly fundJobs = new Map<FaucetChain, FundJob>();

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

  private stopped = false;
  private started = false;

  constructor(deps: ClientRunnerDeps) {
    this.config = deps.config;
    this.createClient = deps.createClient;
    this.log = deps.logger ?? ((): void => undefined);
    if (deps.targetsPath !== undefined) this.targetsPath = deps.targetsPath;
    this.fetchGitRemoteState = deps.gitDeps?.fetchRemoteState ?? fetchRemoteState;
    this.createRepoReader =
      deps.gitDeps?.createRepoReader ?? ((repoPath) => new GitRepoReader(repoPath));
    this.defaultBtpUrl = deps.config.toonClientConfig.btpUrl ?? '';
    this.defaultRelayUrl = deps.config.relayUrl;

    this.createRelay =
      deps.createRelay ??
      ((opts) =>
        new RelaySubscription({
          relayUrl: opts.relayUrl,
          ...(opts.logger ? { logger: opts.logger } : {}),
          onEvent: opts.onEvent,
          // The TOON relay sends events TOON-encoded (text) on reads, not JSON.
          decodeEvent: (raw) =>
            decodeEventFromToon(new TextEncoder().encode(raw)),
        }));

    // Build the permanent config-seeded default relay + apex up front (not yet
    // started/bootstrapped) so `bootstrap()` works standalone (the daemon and
    // tests both rely on constructing then awaiting bootstrap()).
    this.registerRelay(this.defaultRelayUrl);
    // Build the identity-level read client ONCE and reuse it as the default
    // apex's client (same keys + chain RPC config), so on-chain balance reads
    // never depend on an apex existing.
    this.identityClient = this.createClient(this.config.toonClientConfig);
    const defaultApex = this.makeApex({
      btpUrl: this.defaultBtpUrl,
      client: this.identityClient,
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
    for (const relay of this.relays.values()) relay.start();
    void this.bootstrap();
    this.replayPersistedTargets();
  }

  /** Await the default apex's bootstrap (kicking it off if not already running). */
  bootstrap(): Promise<void> {
    // Read-only daemon (no proxy/BTP uplink): never bootstrap an apex — there is
    // no write transport and FREE reads run off the relay subscription (#69).
    if (!this.config.hasUplink) return Promise.resolve();
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
  private registerRelay(relayUrl: string): RelaySubscription {
    const existing = this.relays.get(relayUrl);
    if (existing) return existing;
    const relay = this.createRelay({
      relayUrl,
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
   * Add a relay read target at runtime. Persisted unless `persist` is false.
   */
  async addRelay(relayUrl: string, persist = true): Promise<void> {
    if (this.relays.has(relayUrl)) return;
    const relay = this.registerRelay(relayUrl);
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

  /**
   * One-shot free read: subscribe the given filter(s) across all relays, wait a
   * bounded window for the relay(s) to deliver, then return every buffered event
   * matching the filter (matched by content, not subId — so events already
   * buffered by other subscriptions are included despite the global dedup).
   *
   * Backs the apps `toon_query` tool the generative-UI runtime calls to resolve
   * a ViewSpec node's data bind.
   */
  async query(
    filters: NostrFilter | NostrFilter[],
    timeoutMs = 1200
  ): Promise<NostrEvent[]> {
    const list = Array.isArray(filters) ? filters : [filters];
    const subId = `q-${++this.subIdCounter}`;
    const targets = [...this.relays.keys()];
    for (const url of targets) this.relays.get(url)?.subscribe(list, subId);
    await delay(timeoutMs);
    for (const url of targets) this.relays.get(url)?.unsubscribe(subId);
    return this.merged
      .map((m) => m.event)
      .filter((event) => list.some((f) => matchesFilter(event, f)));
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
      // PROXY mode (no BTP discovery): if no negotiation was supplied via config,
      // discover the apex's settlement params from its kind:10032 on the default
      // relay before opening the channel (#69). Config-supplied negotiation wins.
      // In BTP mode the legacy bootstrap path handles discovery, so skip this.
      if (!apex.negotiation && this.config.proxyUrl) {
        await this.discoverApexNegotiation(apex);
      }
      await apex.client.start();
      this.injectApexNegotiation(apex);
      // PROXY mode: resume a previously-opened channel up front, else DEFER the
      // on-chain open to the first write / `POST /channels` so the wallet can be
      // funded AFTER the daemon starts (the fund→open→publish demo flow, #69).
      // The apex is "ready" once negotiation is in place — `openChannel` /
      // `publish` open lazily and idempotently via the ChannelManager.
      // BTP mode keeps the historical eager open at bootstrap.
      const deferOpen = Boolean(this.config.proxyUrl);
      apex.apexChannelId = await this.openOrResumeApexChannel(apex, {
        resumeOnly: deferOpen,
      });
      this.routeChildPeersThroughApexChannel(apex);
      apex.ready = true;
      apex.lastError = undefined;
      this.log(
        `[runner] apex ${apex.btpUrl || apex.destination} ready; channel ${
          apex.apexChannelId ?? '(deferred — open on first write)'
        }`
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
    // A DISCOVERED apex (e.g. the store DVM at `wss://proxy.store…:443`) lives on
    // a different connector than the default `proxyUrl`. In direct/HTTP transport
    // every paid packet POSTs to `proxyUrl`, so without a per-apex override the
    // discovered apex's packets go to the DEFAULT connector — which has no route
    // to its ILP prefix (F02 "No route to destination"). Derive the apex's own
    // HTTP `/ilp` base from its BTP url so its packets reach the right connector.
    const derivedProxyUrl = btpUrl
      .replace(/^wss:\/\//, 'https://')
      .replace(/^ws:\/\//, 'http://')
      .replace(/:443(\/|$)/, '$1')
      .replace(/\/btp\/?$/, '')
      .replace(/\/$/, '');
    return {
      ...base,
      ...(derivedProxyUrl ? { proxyUrl: derivedProxyUrl } : {}),
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

  // ── Channel / negotiation helpers (per-apex) ───────────────────────────────

  /**
   * Open the apex channel — or, on a restart, RESUME the existing one.
   *
   * With `resumeOnly`, only a persisted channel is resumed (no on-chain open);
   * returns undefined when none exists so the caller can defer the open to the
   * first write (funded-after-start demo flow, #69).
   */
  private async openOrResumeApexChannel(
    apex: ApexConnection,
    opts: { resumeOnly?: boolean } = {}
  ): Promise<string | undefined> {
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
      // Persisted channel state omits the on-chain deposit, so re-read it from
      // chain — otherwise the wallet shows 0 spendable on a funded channel.
      if (saved.context.chainType === 'evm') {
        await apex.client
          .rehydrateChannelDeposit?.(saved.channelId, {
            chain: `evm:${saved.context.chainId}`,
            tokenNetworkAddress: saved.context.tokenNetworkAddress,
          })
          .catch((err) =>
            this.log(
              `[runner] deposit re-hydrate for ${saved.channelId} failed: ${errMsg(err)}`
            )
          );
      }
      this.log(`[runner] resumed apex channel ${saved.channelId} (deposit re-read)`);
      return saved.channelId;
    }

    if (opts.resumeOnly) return undefined;

    const channelId = await apex.client.openChannel(destination);
    this.persistApexChannel(apex, channelId);
    return channelId;
  }

  /**
   * Persist a (lazily- or eagerly-) opened apex channel so a restart RESUMES it
   * (tracked, no re-deposit) rather than opening a second on-chain channel.
   * No-op when the apex carries no negotiation (nothing to key the store on).
   */
  private persistApexChannel(apex: ApexConnection, channelId: string): void {
    const a = apex.negotiation;
    if (!a) return;
    saveApexChannel(
      this.config.apexChannelStorePath,
      apex.destination,
      apex.chain,
      {
        channelId,
        context: {
          chainType: a.chain,
          chainId: a.chainId,
          tokenNetworkAddress: a.tokenNetwork ?? '',
          ...(a.tokenAddress ? { tokenAddress: a.tokenAddress } : {}),
          recipient: a.settlementAddress,
        },
      }
    );
  }

  /**
   * Discover the apex's settlement negotiation from its kind:10032 on the
   * default relay and attach it to the apex (proxy-mode fallback when no config
   * negotiation was supplied, #69). Throws ApexDiscoveryError on timeout/missing
   * settlement params so the apex's `lastError` reports exactly what is missing.
   */
  private async discoverApexNegotiation(apex: ApexConnection): Promise<void> {
    const relay = this.relays.get(this.defaultRelayUrl);
    if (!relay) {
      throw new TargetError(
        `Cannot discover apex "${apex.destination}": default relay ` +
          `${this.defaultRelayUrl} is not registered.`
      );
    }
    relay.start();
    const discovered = await discoverApex({
      relay,
      ilpAddress: apex.destination,
      chain: apex.chain,
      ...(apex.childPeers.length > 0 ? { childPeers: apex.childPeers } : {}),
    });
    apex.negotiation = discovered.negotiation;
    if (discovered.apexChildPeers) apex.childPeers = discovered.apexChildPeers;
    this.log(
      `[runner] discovered apex negotiation for "${apex.destination}" ` +
        `(chain ${discovered.negotiation.chainKey}, settle ` +
        `${discovered.negotiation.settlementAddress})`
    );
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

  /** Route apex CHILD peers (store/swap) through the SAME apex payment channel. */
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
      feePerEvent: (apex?.feePerEvent ?? this.config.feePerEvent).toString(),
      identity: {
        nostrPubkey: safe(() => client?.getPublicKey()) ?? '',
        evmAddress: safe(() => client?.getEvmAddress()),
        solanaAddress: safe(() => client?.getSolanaAddress()),
        minaAddress: safe(() => client?.getMinaAddress()),
      },
      transport: {
        type: 'direct',
        ...(apex ? { btpUrl: apex.btpUrl } : {}),
      },
      relay: {
        url: this.defaultRelayUrl,
        connected: relay?.isConnected() ?? false,
        buffered: relay?.bufferedCount() ?? 0,
        subscriptions: relay?.activeSubscriptions() ?? [],
      },
      ...(network ? { network } : {}),
      ...(apex?.lastError ? { lastError: apex.lastError } : {}),
      // Advertise the optional-route surface this daemon build serves so a
      // version-skewed rig CLI can capability-gate the `/git/*` write path
      // BEFORE delegating (an old daemon lacking these routes 404s otherwise —
      // #306). Static: these routes are always registered by this build.
      capabilities: ['git'],
    };
  }

  /**
   * Drip devnet test funds to a wallet from the configured faucet. Defaults the
   * chain to the active settlement chain and the address to this client's own
   * address on that chain, so a no-arg call funds the caller's own wallet
   * (the typical "fund me before I open a channel" flow). The daemon holds the
   * faucet URL + the keys, so the MCP caller never needs either.
   */
  fundWallet(req: FundWalletRequest = {}): FundWalletResponse {
    const faucetUrl = this.config.faucetUrl;
    if (!faucetUrl) {
      throw new InvalidPayloadError(
        'no faucet configured — set faucetUrl in the daemon config (or the ' +
          'TOON_CLIENT_FAUCET_URL env var) to fund wallets.'
      );
    }
    const chain: FaucetChain = req.chain ?? this.config.chain;
    const client = this.defaultApex()?.client;
    const address =
      req.address ??
      safe(() =>
        chain === 'evm'
          ? client?.getEvmAddress()
          : chain === 'solana'
            ? client?.getSolanaAddress()
            : client?.getMinaAddress()
      );
    if (!address) {
      throw new InvalidPayloadError(
        `no ${chain} address available to fund — pass an explicit address ` +
          `(this client has no ${chain} key configured).`
      );
    }

    // Idempotent: a drip already in flight for this chain returns its snapshot
    // rather than launching a second faucet call (a re-click / poll mustn't
    // double-drip).
    const existing = this.fundJobs.get(chain);
    if (existing && existing.status === 'pending') {
      return { ...existing };
    }

    // The drip is ASYNC: launch the faucet call in the background and return a
    // 'pending' snapshot immediately. The Mina faucet mints native MINA + USDC
    // on a slow-settling chain and legitimately takes ~75s — longer than the MCP
    // host's ~60s tool-call budget and the control client's wire timeout — so a
    // blocking call surfaces a working drip as a misleading relay/apex timeout
    // (#199-class). The daemon happily waits the full chain-aware faucet budget
    // in the background; the caller observes the result via getFundStatus /
    // re-reading balances.
    const job: FundJob = {
      chain,
      address,
      faucetUrl,
      status: 'pending',
      startedAt: Date.now(),
    };
    this.fundJobs.set(chain, job);

    // The drip runs in the BACKGROUND, so there is no caller to protect from a
    // slow faucet — use a GENEROUS timeout. The faucet client default (30s for
    // evm/solana) is tuned for a synchronous call and falsely aborts a drip that
    // succeeds server-side a bit later: e.g. a loaded EVM faucet answers >30s but
    // the tx still lands, so the job would report `error` while the balance
    // actually went up — causing a misleading failure + double-fund risk. Await
    // the real outcome instead (config `faucetTimeoutMs` still overrides).
    const faucetTimeout =
      this.config.faucetTimeoutMs ?? (chain === 'mina' ? 130_000 : 90_000);
    void faucetFund(faucetUrl, address, chain, { timeout: faucetTimeout })
      .then(({ response }) => {
        job.status = 'success';
        job.response = response;
        job.finishedAt = Date.now();
        this.log(`[runner] faucet drip succeeded: ${chain} → ${address}`);
      })
      .catch((err: unknown) => {
        // The background promise must never become an unhandled rejection.
        try {
          const msg = errMsg(err);
          // A timeout is NOT a definitive failure — the on-chain drip may still
          // settle after the client gives up (observed on EVM). Mark it as a
          // distinct, non-terminal-sounding state and advise re-checking
          // balances before re-funding, rather than asserting it failed.
          const timedOut = /timed out|timeout|aborted/i.test(msg);
          job.status = timedOut ? 'timeout' : 'error';
          job.error = timedOut
            ? `${msg} — the on-chain drip may still have settled; re-check balances before re-funding.`
            : msg;
          job.finishedAt = Date.now();
          this.log(
            `[runner] faucet drip ${timedOut ? 'timed out' : 'failed'}: ${chain} → ${address}: ${msg}`
          );
        } catch {
          // Swallow — recording the failure must not itself reject.
        }
      });

    return { ...job };
  }

  /**
   * Snapshots of tracked faucet drip jobs — all of them, or just the one for
   * `chain`. Lets a caller poll for the terminal state of an async drip without
   * re-dripping.
   */
  getFundStatus(chain?: FaucetChain): FundStatusResponse {
    const jobs = chain
      ? this.fundJobs.has(chain)
        ? [{ ...this.fundJobs.get(chain)! }]
        : []
      : [...this.fundJobs.values()].map((j) => ({ ...j }));
    return { jobs };
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

  /**
   * Lazily open the apex channel on first paid write (deferred at bootstrap so
   * the wallet can be funded after start, #69) and persist it for resume.
   */
  private async ensureApexChannel(
    apex: ApexConnection,
    destination?: string
  ): Promise<string> {
    let channelId = apex.apexChannelId;
    if (!channelId) {
      channelId = await apex.client.openChannel(destination);
      if (!destination || destination === apex.destination) {
        apex.apexChannelId = channelId;
        this.persistApexChannel(apex, channelId);
      }
    }
    return channelId;
  }

  /** Pay-to-write a single event through the selected (or default) apex. */
  async publish(req: PublishRequest): Promise<PublishResponse> {
    const apex = this.selectApex(req.btpUrl);
    this.assertApexReady(apex);
    const channelId = await this.ensureApexChannel(apex, req.destination);
    const fee = req.fee !== undefined ? BigInt(req.fee) : apex.feePerEvent;
    const claim = await apex.client.signBalanceProof(channelId, fee);
    // Relay writes default to the configured publish destination (e.g.
    // g.proxy.relay) — NOT the apex anchor, which on the devnet proxy is
    // g.proxy.relay.store and would forward a /write to the store (→ 404). An
    // explicit per-call destination still wins. The claim is pre-signed on the
    // apex channel, so the destination is pure routing (settlement is unaffected).
    const result = await apex.client.publishEvent(req.event, {
      destination: req.destination ?? this.config.publishDestination,
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
      feePaid: fee.toString(),
      channelBalanceAfter: this.channelAvailable(apex, channelId),
    };
  }

  /**
   * Available (spendable) balance for a channel after a write — locked collateral
   * minus cumulative spent, clamped at 0. Same math as {@link getChannels}; used
   * to report a truthful post-write balance in publish/upload receipts. Returns
   * undefined if the channel isn't tracked on this apex (balance unknown).
   */
  private channelAvailable(apex: ApexConnection, channelId: string): string | undefined {
    if (!apex.client.getTrackedChannels().includes(channelId)) return undefined;
    const cumulative = apex.client.getChannelCumulativeAmount(channelId);
    const depositTotal = apex.client.getChannelDepositTotal(channelId);
    const available = depositTotal > cumulative ? depositTotal - cumulative : 0n;
    return available.toString();
  }

  /**
   * Build, sign (with the daemon-held key), and pay-to-write an event. The
   * caller supplies only the event shell; the private key never leaves the
   * daemon. Payloads are MODEL-AUTHORED → validated server-side here (the model
   * is not a security boundary). Replaceable kinds (0/3) merge the latest known
   * event's tags before signing.
   */
  async publishUnsigned(req: PublishUnsignedRequest): Promise<PublishResponse> {
    const apex = this.selectApex(req.btpUrl);
    this.assertApexReady(apex);
    const template = this.buildTemplate(apex, req);
    const signed = await apex.client.signEvent(template);
    return this.publish({
      event: signed,
      ...(req.destination ? { destination: req.destination } : {}),
      ...(req.fee ? { fee: req.fee } : {}),
      ...(req.btpUrl ? { btpUrl: req.btpUrl } : {}),
    });
  }

  /**
   * Upload media to Arweave (kind:5094 blob DVM, single-packet) then sign+publish
   * a media event referencing the resulting URL. One spendy operation, two steps,
   * entirely server-side.
   */
  async uploadMedia(req: UploadMediaRequest): Promise<UploadMediaResponse> {
    const apex = this.selectApex(req.btpUrl);
    this.assertApexReady(apex);
    // Source the bytes from EXACTLY ONE of inline base64 or an on-disk path.
    // `filePath` lets agent callers skip materializing the whole payload as a
    // tool argument (it never touches the model context); `dataBase64` stays for
    // back-compat. Both-or-neither is a payload error.
    const hasData = typeof req.dataBase64 === 'string' && req.dataBase64 !== '';
    const hasPath = typeof req.filePath === 'string' && req.filePath !== '';
    if (hasData === hasPath) {
      throw new InvalidPayloadError(
        'exactly one of dataBase64 (base64 media bytes) | filePath (absolute path) is required.'
      );
    }
    const blobData = hasPath
      ? await this.readUploadFile(req.filePath as string)
      : new Uint8Array(Buffer.from(req.dataBase64 as string, 'base64'));
    const fee = req.fee !== undefined ? BigInt(req.fee) : apex.feePerEvent;
    // ── Leg 1: Arweave blob upload ──────────────────────────────────────────
    // Blob storage terminates at the store/DVM backend (POST /store → Arweave),
    // so it routes to the configured store destination (e.g. g.proxy.store,
    // derived from the `….relay.store` anchor by #143). This makes uploads work
    // via the default apex without the caller hand-passing a store `btpUrl`. A
    // failure here is distinct from the kind:1-equivalent publish below; label
    // it so the UI/agent can tell the upload leg apart from the publish leg.
    const upload = await apex.client.uploadBlob({
      blobData,
      destination: this.config.storeDestination,
      ...(req.mime ? { contentType: req.mime } : {}),
      ilpAmount: fee,
    });
    if (!upload.success || !upload.txId) {
      throw new PublishRejectedError(
        `Arweave upload leg failed (store ${this.config.storeDestination}): ${upload.error ?? 'blob upload rejected'}`
      );
    }
    const { url, fallbacks } = arweaveUrls(upload.txId, this.config.arweaveGateways);
    const kind = req.kind ?? 1063;
    const signed = await apex.client.signEvent({
      kind,
      created_at: nowSeconds(),
      tags: this.buildMediaTags(kind, url, fallbacks, req),
      content: req.caption ?? '',
    });
    // ── Leg 2: publish the NIP-94/NIP-68 reference event ────────────────────
    // The reference event is a normal Nostr write, so it must publish through a
    // RELAY apex, not the store/DVM. `this.publish` routes it to the configured
    // publish destination (e.g. g.proxy.relay) — the exact path #143 made kind:1
    // work. Omit `btpUrl` so it uses the default (relay) apex. Label any failure
    // here as the post-upload publish leg (the blob already stored OK).
    let pub: PublishResponse;
    try {
      pub = await this.publish({
        event: signed,
        ...(req.fee ? { fee: req.fee } : {}),
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new PublishRejectedError(
        `kind:${kind} publish leg failed after upload (blob stored at ${url}): ${detail}`
      );
    }
    // An upload pays TWICE — the blob (leg 1) and the reference event (leg 2) —
    // so the truthful total is the sum, not just the publish leg's fee. The
    // post-write balance from the (last) publish leg is already current.
    const feePaid = (fee + BigInt(pub.feePaid)).toString();
    return { ...pub, feePaid, url, txId: upload.txId };
  }

  /**
   * Read media bytes off disk for an upload `filePath`. The path is resolved
   * and, when an `uploadAllowedRoot` is configured, must resolve inside it —
   * bounding which filesystem locations the daemon reads on an agent's behalf.
   * A missing/unreadable file (or an out-of-bounds path) surfaces as an
   * `InvalidPayloadError` (HTTP 400), not an unhandled crash.
   */
  private async readUploadFile(filePath: string): Promise<Uint8Array> {
    const resolved = resolve(filePath);
    const root = this.config.uploadAllowedRoot;
    if (root && resolved !== root && !resolved.startsWith(root + sep)) {
      throw new InvalidPayloadError(
        `filePath must resolve inside the configured upload root (${root}).`
      );
    }
    try {
      const buf = await readFile(resolved);
      return new Uint8Array(buf);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new InvalidPayloadError(`failed to read filePath ${resolved}: ${detail}`);
    }
  }

  /** Validate + assemble a signable event template (with replaceable merge). */
  private buildTemplate(
    apex: ApexConnection,
    req: PublishUnsignedRequest
  ): EventTemplate {
    if (!Number.isInteger(req.kind) || req.kind < 0 || req.kind > 65535) {
      throw new InvalidPayloadError('kind must be an integer in [0, 65535].');
    }
    if (req.content !== undefined && typeof req.content !== 'string') {
      throw new InvalidPayloadError('content must be a string.');
    }
    const tags = normalizeTags(req.tags);
    const content = req.content ?? '';

    // Replaceable kinds: merge the latest known self-authored event so a single
    // "follow X" / profile edit doesn't clobber prior tags. Best-effort from the
    // read buffer (v1 — concurrent edits can still race; see plan risk #6).
    if (req.kind === 0 || req.kind === 3) {
      const prior = this.latestSelfReplaceable(apex, req.kind);
      if (prior) {
        return {
          kind: req.kind,
          created_at: nowSeconds(),
          tags: mergeTags(prior.tags, tags),
          content: content !== '' ? content : prior.content,
        };
      }
    }
    return { kind: req.kind, created_at: nowSeconds(), tags, content };
  }

  /** Latest self-authored event of `kind` currently in the merged read buffer. */
  private latestSelfReplaceable(
    apex: ApexConnection,
    kind: number
  ): NostrEvent | undefined {
    const pubkey = safe(() => apex.client.getPublicKey());
    if (!pubkey) return undefined;
    let latest: NostrEvent | undefined;
    for (const m of this.merged) {
      if (m.event.kind !== kind || m.event.pubkey !== pubkey) continue;
      if (!latest || m.event.created_at > latest.created_at) latest = m.event;
    }
    return latest;
  }

  /**
   * Tags for a published media event referencing an Arweave URL. `url` is the
   * primary gateway; `fallbacks` are mirror URLs for the same tx id on other
   * gateways, emitted so readers can fail over if the primary is unreachable.
   */
  private buildMediaTags(
    kind: number,
    url: string,
    fallbacks: string[],
    req: UploadMediaRequest
  ): string[][] {
    const mime = req.mime ?? 'application/octet-stream';
    const extra = normalizeTags(req.tags);
    if (kind === 1063) {
      // NIP-94 file metadata: separate url/m tags, mirrors as `fallback` tags.
      return [
        ['url', url],
        ['m', mime],
        ...fallbacks.map((f) => ['fallback', f]),
        ...extra,
      ];
    }
    // NIP-68/71 picture/video + NIP-92 inline note: a single `imeta` tag with
    // the primary `url` first and the remaining gateways as `fallback` mirrors.
    return [
      ['imeta', `url ${url}`, `m ${mime}`, ...fallbacks.map((f) => `fallback ${f}`)],
      ...extra,
    ];
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
      const firstOpen = apex.apexChannelId !== channelId;
      apex.apexChannelId = channelId;
      // Persist the (possibly lazily-opened) apex channel for restart-resume.
      if (firstOpen) this.persistApexChannel(apex, channelId);
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
        const cumulative = apex.client.getChannelCumulativeAmount(channelId);
        const depositTotal = apex.client.getChannelDepositTotal(channelId);
        // Available (spendable) balance = locked collateral − cumulative spent.
        // Clamp at 0 so an over-spend estimate never surfaces as negative.
        const available = depositTotal > cumulative ? depositTotal - cumulative : 0n;
        const settleableAt = apex.client.getSettleableAt(channelId);
        channels.push({
          channelId,
          nonce: apex.client.getChannelNonce(channelId),
          cumulativeAmount: cumulative.toString(),
          depositTotal: depositTotal.toString(),
          availableBalance: available.toString(),
          closeState: apex.client.getChannelCloseState(channelId),
          ...(settleableAt !== undefined ? { settleableAt: settleableAt.toString() } : {}),
        });
      }
    }
    return { channels };
  }

  /**
   * On-chain wallet balances. The wallet is identity-level (same keys across
   * apexes), so this reads from the daemon's {@link identityClient} — NOT an apex
   * — and therefore works even with zero apexes / no payment peer configured
   * (reading your own balance is a pure wallet-keys + chain-RPC operation).
   * Per-chain reads are best-effort inside the client (a failing chain is simply
   * omitted).
   *
   * Each underlying read hits per-chain RPC providers that can stall
   * indefinitely on devnet (a provider being `detail: "configured"` in
   * toon_status means it is WIRED, not that its RPC is live). A stall here used
   * to block the whole control request until the client aborted, surfacing as a
   * misleading "relay/apex unreachable" timeout (#199). Bound each attempt well
   * under the control API timeout and retry once so a single transient
   * provider stall FAST-FAILS with an honest "balances handler / provider
   * stalled" error instead of hanging.
   */
  async getBalances(): Promise<BalancesResponse> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= BALANCES_READ_ATTEMPTS; attempt++) {
      try {
        const balances = (await withTimeout(
          this.identityClient.getBalances(),
          BALANCES_READ_TIMEOUT_MS,
          `chain balance read timed out after ${BALANCES_READ_TIMEOUT_MS}ms`
        )) as BalanceInfo[];
        return { balances };
      } catch (err) {
        lastErr = err;
      }
    }
    throw new BalancesUnavailableError(
      `the balances control handler's chain RPC/provider read did not return ` +
        `(${BALANCES_READ_ATTEMPTS} attempts, ${BALANCES_READ_TIMEOUT_MS}ms each) — ` +
        `the on-chain provider stalled, not the relay or apex. Retry shortly.`,
      lastErr instanceof Error ? lastErr.message : undefined
    );
  }

  /**
   * Deposit additional collateral into an open channel. Routes to the apex whose
   * client tracks the channel (each apex client opens/tracks its own channels);
   * the client signs its own on-chain tx.
   */
  async depositToChannel(req: ChannelDepositRequest): Promise<ChannelDepositResponse> {
    return this.withTrackingApex(req.channelId, (client) =>
      client.depositToChannel(req.channelId, req.amount)
    );
  }

  /** Close a channel to begin the settlement grace period (withdraw, step 1). */
  async closeChannel(req: CloseChannelRequest): Promise<CloseChannelResponse> {
    return this.withTrackingApex(req.channelId, (client) => client.closeChannel(req.channelId));
  }

  /**
   * Settle a closed channel to release collateral (withdraw, step 2). The client
   * enforces the `now >= settleableAt` guard and throws a retryable error if
   * called early; `mapError` maps that to HTTP 425.
   */
  async settleChannel(req: SettleChannelRequest): Promise<SettleChannelResponse> {
    return this.withTrackingApex(req.channelId, (client) => client.settleChannel(req.channelId));
  }

  /** Run `fn` against the apex client that tracks `channelId`, else throw. */
  private async withTrackingApex<T>(
    channelId: string,
    fn: (client: ApexConnection['client']) => Promise<T>
  ): Promise<T> {
    for (const apex of this.apexes.values()) {
      if (apex.client.getTrackedChannels().includes(channelId)) {
        return fn(apex.client);
      }
    }
    throw new Error(`Channel "${channelId}" is not tracked by any apex.`);
  }

  /**
   * Swap source→target asset against a swap peer via the selected apex.
   *
   * sdk ≥2.0.0 (the `mill`→`swap` vocabulary rename, toon commit `af4cd24`):
   * `streamSwap` takes `swapPubkey`/`swapIlpAddress` and accumulated claims
   * carry `swapSignerAddress`. The rename has NO wire back-compat — a
   * pre-rename (sdk ≤1.x) swap peer still emits `millSignerAddress` in its
   * FULFILL settlement metadata, which `decodeFulfillMetadata` silently drops
   * as an unknown field. That skew would otherwise surface only much later as
   * `MISSING_SETTLEMENT_METADATA` in `buildSettlementTx`, so we detect it
   * here (accepted claims with no `swapSignerAddress`) and surface a loud
   * `warning` on the response at swap time (#349).
   *
   * With `req.senderConditions` set, every swap packet is sent with a FRESH
   * sender-minted execution condition (`C_i = sha256(P_i)`, one per packet —
   * toon-client#350, rolling-swap spec §3 R1/R2) and the transport verifies
   * each FULFILL's preimage; a mismatch counts the packet failed. This
   * requires a maker/connector implementing the sender-chosen fulfillment
   * contract (connector#309) — the deployed claim-issuing mill cannot satisfy
   * it — so it is opt-in and the default stays the legacy zero condition.
   *
   * Sender-side rolling-swap defenses (#351, sdk ≥2.1.0, spec §5/§6):
   *
   * - **Hard floor** — `req.minExchangeRate`, or derived
   *   `pair.rate × (1 − floorBps/10000)` from `req.floorBps` /
   *   `swapDefaults.floorBps`. A below-floor packet records `BELOW_FLOOR` and
   *   halts the stream (`abortReason: 'below-floor'`); the armed floor is
   *   echoed on the response so hosts can show the guaranteed worst case.
   * - **Adaptive controller** — `req.controller` (or
   *   `swapDefaults.controller` when the request pins no `packetCount`)
   *   replaces the static even split with `AdaptiveDeltaController` δ/W
   *   sizing; per-(source chain, maker, pair) state persists in
   *   `swap-controller-state.json` beside the daemon's channel stores. The
   *   controller is efficiency-only — it can never relax the floor.
   * - **Telemetry** — `onPacket` is always wired: per-packet outcomes,
   *   rejections, and a realized-rate summary land on the response, and each
   *   accepted packet is logged. Everything else is strictly opt-in: with no
   *   new params and no `swapDefaults`, the `streamSwap` call is the legacy
   *   request (no floor, no controller, no expiry stamping, no signal).
   * - **Abort** — `req.timeoutMs` arms an `AbortSignal`; on expiry in-flight
   *   packets drain and the partial fill is reported exactly (partial
   *   `claims`, cumulatives, `state`/`abortReason`).
   */
  async swap(req: SwapRequest): Promise<SwapResponse> {
    const apex = this.selectApex(req.btpUrl);
    this.assertApexReady(apex);
    if (req.controller && req.packetCount !== undefined) {
      throw new InvalidPayloadError(
        '`controller` and `packetCount` are mutually exclusive: the adaptive ' +
          'controller replaces the static even split with dynamic δ/W sizing.'
      );
    }
    const defaults = this.config.swapDefaults;
    // Floor precedence: explicit rate → per-request bps → daemon-default bps.
    const minExchangeRate =
      req.minExchangeRate ??
      deriveFloorRate(req.pair.rate, req.floorBps ?? defaults?.floorBps);
    const packetExpiryMs = req.packetExpiryMs ?? defaults?.packetExpiryMs;
    // Controller precedence: per-request params → daemon default — but an
    // explicit packetCount on the request always pins the legacy even split.
    const controllerParams =
      req.controller ??
      (req.packetCount === undefined ? defaults?.controller : undefined);
    const controller = controllerParams
      ? await this.createSwapController(req, controllerParams)
      : undefined;

    // Per-packet telemetry: collected for the response and logged. The
    // callback must never throw — streamSwap treats a throwing onPacket as a
    // stop signal, and telemetry must not be able to halt the stream.
    const packets: SwapPacketOutcome[] = [];
    let packetsTruncated = false;
    const onPacket = (p: PacketProgress): void => {
      try {
        this.log(
          `[runner] swap packet ${p.index}: ${p.sourceAmount} → ` +
            `${p.targetAmount} (rate ${p.effectiveRate.toFixed(6)}, ` +
            `deviation ${p.rateDeviation.toFixed(6)}` +
            (p.rate ? `, tape ${p.rate}` : '') +
            ')'
        );
        if (packets.length >= SWAP_PACKETS_RESPONSE_LIMIT) {
          packetsTruncated = true;
          return;
        }
        packets.push({
          index: p.index,
          sourceAmount: p.sourceAmount.toString(),
          targetAmount: p.targetAmount.toString(),
          effectiveRate: p.effectiveRate,
          rateDeviation: p.rateDeviation,
          ...(p.rate !== undefined ? { rate: p.rate } : {}),
          ...(p.rateTimestamp !== undefined
            ? { rateTimestamp: p.rateTimestamp }
            : {}),
        });
      } catch {
        // Swallow: telemetry failures must not stop the stream.
      }
    };

    const senderSecretKey = generateSecretKey();
    const swapClient = req.senderConditions
      ? this.withSenderConditions(apex.client)
      : apex.client;
    const result = await streamSwap({
      client: swapClient as unknown as Parameters<
        typeof streamSwap
      >[0]['client'],
      swapPubkey: req.swapPubkey,
      swapIlpAddress: req.destination,
      pair: req.pair,
      senderSecretKey,
      chainRecipient: req.chainRecipient,
      totalAmount: BigInt(req.amount),
      // EXACTLY ONE of controller / packetCount (sdk contract).
      ...(controller ? { controller } : { packetCount: req.packetCount ?? 1 }),
      onPacket,
      ...(minExchangeRate !== undefined ? { minExchangeRate } : {}),
      ...(packetExpiryMs !== undefined ? { packetExpiryMs } : {}),
      ...(req.timeoutMs !== undefined
        ? { signal: AbortSignal.timeout(req.timeoutMs) }
        : {}),
    });
    const firstReject = result.rejections[0];
    const claims = result.claims.map((c) => ({
      sourceAmount: c.sourceAmount.toString(),
      targetAmount: c.targetAmount.toString(),
      claim: Buffer.from(c.claimBytes).toString('base64'),
      ...(c.channelId ? { channelId: c.channelId } : {}),
      ...(c.recipient ? { recipient: c.recipient } : {}),
      ...(c.swapSignerAddress
        ? { swapSignerAddress: c.swapSignerAddress }
        : {}),
      ...(c.claimId ? { claimId: c.claimId } : {}),
      ...(c.nonce ? { nonce: c.nonce } : {}),
      ...(c.cumulativeAmount ? { cumulativeAmount: c.cumulativeAmount } : {}),
    }));
    // Wire-rename skew guard: claims were FULFILLed but none carries the
    // swapSignerAddress settlement metadata — the signature of a pre-rename
    // swap peer (emits `millSignerAddress`, silently dropped by sdk ≥2's
    // decodeFulfillMetadata). Settlement of these claims WILL fail with
    // MISSING_SETTLEMENT_METADATA; say so now instead of then.
    const missingSettlementSigner =
      claims.length > 0 && claims.every((c) => !c.swapSignerAddress);
    if (missingSettlementSigner) {
      this.log(
        '[runner] swap: accepted claims are missing swapSignerAddress ' +
          'settlement metadata — swap peer is likely pre-rename (sdk <2.0.0)'
      );
    }
    const realizedRate = computeRealizedRate(
      result.cumulativeSource,
      result.cumulativeTarget,
      req.pair
    );
    return {
      accepted: result.claims.length > 0,
      packetsAccepted: result.claims.length,
      claims,
      cumulativeSource: result.cumulativeSource.toString(),
      cumulativeTarget: result.cumulativeTarget.toString(),
      state: result.state,
      abortReason: result.abortReason,
      ...(packets.length > 0 ? { packets } : {}),
      ...(packetsTruncated ? { packetsTruncated } : {}),
      ...(result.rejections.length > 0
        ? {
            rejections: result.rejections.map((r) => ({
              packetIndex: r.packetIndex,
              sourceAmount: r.sourceAmount.toString(),
              code: r.code,
              message: r.message,
            })),
          }
        : {}),
      ...(realizedRate !== undefined ? { realizedRate } : {}),
      ...(minExchangeRate !== undefined ? { minExchangeRate } : {}),
      ...(firstReject
        ? { code: firstReject.code, message: firstReject.message }
        : {}),
      ...(missingSettlementSigner
        ? {
            warning:
              'Accepted claims are missing `swapSignerAddress` settlement ' +
              'metadata, so settling them will fail with ' +
              'MISSING_SETTLEMENT_METADATA. The swap peer is likely running ' +
              'a pre-rename SDK (<2.0.0, emits `millSignerAddress`, which ' +
              'sdk ≥2 silently drops). Upgrade the swap peer before settling.',
          }
        : {}),
    };
  }

  /**
   * Wrap an apex client so each `sendSwapPacket` call carries a freshly
   * minted sender-chosen execution condition (one preimage per packet, spec
   * R1 — reuse would let an observer of packet *i* fulfill packet *i+1*).
   * `streamSwap` calls `sendSwapPacket` once per packet, so minting here
   * yields exactly one condition per packet. The transports verify each
   * FULFILL's preimage against the condition and fail the packet on mismatch.
   *
   * NOTE: the minted preimage is intentionally NOT retained yet — leg-B
   * receive-side ingestion (where the sender reveals `P_i`) is a separate
   * rolling-swap workstream (toon-meta docs/rolling-swap.md §3.2). Until a
   * maker implements the connector#309 contract end-to-end, packets sent with
   * conditions will fail closed rather than settle unverified.
   */
  private withSenderConditions(client: ToonClientLike): ToonClientLike {
    const wrapped: ToonClientLike = Object.create(client) as ToonClientLike;
    wrapped.sendSwapPacket = (params) => {
      const { condition } = mintExecutionCondition();
      return client.sendSwapPacket({
        ...params,
        executionCondition: condition,
      });
    };
    return wrapped;
  }

  /**
   * Build the adaptive δ/W controller for one swap session (#351, spec §6).
   * State is keyed per-(source chain, maker, pair) and persisted in the
   * daemon's data dir via the sdk's atomic JSON-file store, so ramp/trust
   * survives across swaps and daemon restarts.
   */
  private async createSwapController(
    req: SwapRequest,
    params: SwapControllerParams
  ): Promise<AdaptiveDeltaController> {
    if (
      typeof params.advertisedSpread !== 'number' ||
      !(params.advertisedSpread > 0)
    ) {
      throw new InvalidPayloadError(
        'controller.advertisedSpread must be a positive fraction (e.g. ' +
          '0.004 = 40 bps): ε is denominated off the half-spread and the sdk ' +
          'deliberately has no default.'
      );
    }
    const store = new JsonFileSwapControllerStateStore(
      this.swapControllerStatePath()
    );
    return AdaptiveDeltaController.create({
      makerPubkey: req.swapPubkey,
      pair: req.pair,
      advertisedSpread: params.advertisedSpread,
      ...(params.maxPacketAmount !== undefined
        ? { maxPacketAmount: BigInt(params.maxPacketAmount) }
        : {}),
      ...(params.minPacketAmount !== undefined
        ? { minPacketAmount: BigInt(params.minPacketAmount) }
        : {}),
      ...(params.maxWindow !== undefined
        ? { maxWindow: params.maxWindow }
        : {}),
      ...(params.cleanStreakLength !== undefined
        ? { cleanStreakLength: params.cleanStreakLength }
        : {}),
      ...(params.coldStartDivisor !== undefined
        ? { coldStartDivisor: params.coldStartDivisor }
        : {}),
      ...(params.ewmaAlpha !== undefined
        ? { ewmaAlpha: params.ewmaAlpha }
        : {}),
      store,
    });
  }

  /**
   * Controller-state file path: resolved config value, or the same
   * `<configDir>` the other daemon stores live in (`channels.json`,
   * `apex-channels.json`) for manually-built configs.
   */
  private swapControllerStatePath(): string {
    return (
      this.config.swapControllerStatePath ??
      join(configDir(), 'swap-controller-state.json')
    );
  }

  /**
   * Payment-aware HTTP fetch through an apex's client. The client issues the
   * request and, on `402 Payment Required`, pays over TOON and retries; we
   * translate the resulting Web `Response` into the wire envelope.
   */
  async httpFetchPaid(
    req: HttpFetchPaidRequest
  ): Promise<HttpFetchPaidResponse> {
    const apex = this.selectApex();
    this.assertApexReady(apex);
    const res = await apex.client.h402Fetch(req.url, {
      ...(req.method ? { method: req.method } : {}),
      ...(req.headers ? { headers: req.headers } : {}),
      ...(req.body !== undefined ? { body: req.body } : {}),
      ...(req.timeout !== undefined ? { timeout: req.timeout } : {}),
    });
    return {
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      body: await res.text(),
    };
  }

  // ── Git write path (/git/*, epic #222 ticket #227) ────────────────────────

  /**
   * The daemon `Publisher` implementation (see @toon-protocol/rig) for one
   * apex. Maps the interface onto the runner's production paid-write
   * machinery:
   *
   *  - `getFeeRates`: flat `apex.feePerEvent` per publish + the network
   *    per-byte upload rate.
   *  - `uploadGitObject`: kind:5094 store write with Git-SHA/Git-Type/Repo
   *    tags (the proven seed-pipeline shape), signed with the daemon key,
   *    paid via signBalanceProof on the apex channel, routed to the store
   *    destination (`POST /store`); the Arweave txId is decoded from the
   *    FULFILL HTTP envelope.
   *  - `publishEvent`: sign with the daemon key + the standard paid publish
   *    path (signBalanceProof → publishEvent → feePaid). The daemon owns its
   *    write routing (config-seeded relay via the apex), so the advisory
   *    `relayUrls` list is not consulted here — remote-state reads DO use it.
   */
  private gitPublisher(apex: ApexConnection): Publisher {
    return {
      getFeeRates: async () => ({
        uploadFeePerByte: UPLOAD_FEE_PER_BYTE,
        eventFee: apex.feePerEvent,
      }),
      uploadGitObject: (upload) => this.gitUploadObject(apex, upload),
      publishEvent: (event) => this.gitPublishEvent(apex, event),
    };
  }

  /** Upload one git object body as a paid kind:5094 store write. */
  private async gitUploadObject(
    apex: ApexConnection,
    upload: GitObjectUpload
  ): Promise<UploadReceipt> {
    const channelId = await this.ensureApexChannel(apex);
    const fee = BigInt(upload.body.length) * UPLOAD_FEE_PER_BYTE;
    const claim = await apex.client.signBalanceProof(channelId, fee);
    const signed = await apex.client.signEvent({
      kind: 5094,
      content: '',
      tags: [
        ['i', upload.body.toString('base64'), 'blob'],
        ['bid', fee.toString(), 'usdc'],
        ['output', 'application/octet-stream'],
        ['Git-SHA', upload.sha],
        ['Git-Type', upload.type],
        ['Repo', upload.repoId],
      ],
      created_at: nowSeconds(),
    });
    const result = await apex.client.publishEvent(signed, {
      destination: this.config.storeDestination,
      claim,
      ilpAmount: fee,
      // The store/DVM backend serves POST /store (not the relay's /write).
      proxyPath: '/store',
    });
    if (!result.success) {
      throw new PublishRejectedError(
        `git object ${upload.sha} upload failed (store ` +
          `${this.config.storeDestination}): ${result.error ?? 'store rejected the write'}`
      );
    }
    if (!result.data) {
      throw new PublishRejectedError(
        `git object ${upload.sha} upload FULFILL carried no data — expected the Arweave tx ID`
      );
    }
    let txId: string;
    try {
      txId = extractArweaveTxId(result.data);
    } catch (err) {
      throw new PublishRejectedError(
        `git object ${upload.sha} upload: ${errMsg(err)}`
      );
    }
    return { txId, feePaid: fee };
  }

  /** Sign (daemon key) + pay-to-publish one NIP-34 event via the apex. */
  private async gitPublishEvent(
    apex: ApexConnection,
    event: UnsignedEvent
  ): Promise<PublishReceipt> {
    const signed = await apex.client.signEvent(event);
    const pub = await this.publish({
      event: signed,
      ...(apex.btpUrl ? { btpUrl: apex.btpUrl } : {}),
    });
    return { eventId: pub.eventId, feePaid: BigInt(pub.feePaid) };
  }

  /**
   * Plan a push: read the local repo + the remote NIP-34 state, classify ref
   * updates, compute the object delta, and price it. Shared by
   * estimate (returns the plan) and push (executes it).
   */
  private async planGitPush(
    apex: ApexConnection,
    req: GitEstimateRequest
  ): Promise<{
    plan: PushPlan;
    remoteState: RemoteState;
    repoReader: GitRepoReader;
    relayUrls: string[];
    publisher: Publisher;
  }> {
    await assertRepoPath(req.repoPath);
    if (typeof req.repoId !== 'string' || req.repoId === '') {
      throw new InvalidPayloadError('repoId is required.');
    }
    const relayUrls =
      req.relayUrls && req.relayUrls.length > 0
        ? req.relayUrls
        : [this.defaultRelayUrl];
    // Pushes publish kind:30617/30618 signed by the daemon key, so the daemon
    // identity IS the repo owner whose remote state we read.
    const ownerPubkey = apex.client.getPublicKey();
    const repoReader = this.createRepoReader(req.repoPath);
    const remoteState = await this.fetchGitRemoteState({
      relayUrls,
      ownerPubkey,
      repoId: req.repoId,
    });
    const publisher = this.gitPublisher(apex);
    const feeRates = await publisher.getFeeRates();
    const plan = await planPush({
      repoReader,
      remoteState,
      feeRates,
      repoId: req.repoId,
      ...(req.refspecs !== undefined ? { refs: req.refspecs } : {}),
      ...(req.force !== undefined ? { force: req.force } : {}),
      ...(req.announcement !== undefined
        ? { announcement: req.announcement }
        : {}),
    });
    return { plan, remoteState, repoReader, relayUrls, publisher };
  }

  /** Plan + price a push WITHOUT paying (backs `POST /git/estimate`). */
  async gitEstimate(req: GitEstimateRequest): Promise<GitEstimateResponse> {
    const apex = this.selectApex();
    this.assertApexReady(apex);
    const { plan } = await this.planGitPush(apex, req);
    return serializePushPlan(plan);
  }

  /** Plan + EXECUTE a push: paid uploads + paid publishes (`POST /git/push`). */
  async gitPush(req: GitPushRequest): Promise<GitPushResponse> {
    if (req.confirm !== true) {
      throw new InvalidPayloadError(
        'a push uploads objects to Arweave and publishes events — permanent ' +
          'and paid. Run /git/estimate first, then set confirm: true to proceed.'
      );
    }
    const apex = this.selectApex();
    this.assertApexReady(apex);
    const { plan, remoteState, repoReader, relayUrls, publisher } =
      await this.planGitPush(apex, req);
    const result = await executePush({
      plan,
      publisher,
      remoteState,
      repoReader,
      relayUrls,
    });
    return serializePushResult(plan, result);
  }

  /** Build, sign, and pay-to-publish a kind:1621 issue. */
  async gitIssue(req: GitIssueRequest): Promise<GitEventResponse> {
    const addr = validateRepoAddr(req.repoAddr);
    assertNonEmptyString(req.title, 'title');
    assertNonEmptyString(req.body, 'body');
    const event = buildIssue(
      addr.ownerPubkey,
      addr.repoId,
      req.title,
      req.body,
      req.labels ?? []
    );
    return this.gitPublishSigned(event);
  }

  /** Build, sign, and pay-to-publish a kind:1622 comment on an issue/patch. */
  async gitComment(req: GitCommentRequest): Promise<GitEventResponse> {
    const addr = validateRepoAddr(req.repoAddr);
    assertNonEmptyString(req.rootEventId, 'rootEventId');
    assertNonEmptyString(req.body, 'body');
    const event = buildComment(
      addr.ownerPubkey,
      addr.repoId,
      req.rootEventId,
      req.parentAuthorPubkey ?? addr.ownerPubkey,
      req.body,
      req.marker ?? 'root'
    );
    return this.gitPublishSigned(event);
  }

  /**
   * Build, sign, and pay-to-publish a kind:1617 patch. Content is either the
   * supplied `patchText` or real `git format-patch --stdout <range>` output
   * from a local repository — exactly one source must be given.
   */
  async gitPatch(req: GitPatchRequest): Promise<GitEventResponse> {
    const addr = validateRepoAddr(req.repoAddr);
    assertNonEmptyString(req.title, 'title');
    const hasText = typeof req.patchText === 'string' && req.patchText !== '';
    const hasRange =
      typeof req.repoPath === 'string' &&
      req.repoPath !== '' &&
      typeof req.range === 'string' &&
      req.range !== '';
    if (hasText === hasRange) {
      throw new InvalidPayloadError(
        'exactly one of patchText | repoPath+range is required.'
      );
    }
    let content: string;
    if (hasRange) {
      await assertRepoPath(req.repoPath as string);
      content = await this.createRepoReader(req.repoPath as string).formatPatch(
        req.range as string
      );
      if (content === '') {
        throw new InvalidPayloadError(
          `range ${JSON.stringify(req.range)} selects no commits — nothing to publish.`
        );
      }
    } else {
      content = req.patchText as string;
    }
    const event = buildPatch(
      addr.ownerPubkey,
      addr.repoId,
      req.title,
      req.commits ?? [],
      req.branch,
      content,
      // PR body → `description` tag; never the content (git am safety, #280).
      typeof req.description === 'string' && req.description !== ''
        ? req.description
        : undefined
    );
    return this.gitPublishSigned(event);
  }

  /** Build, sign, and pay-to-publish a kind:1630-1633 status event. */
  async gitStatus(req: GitStatusRequest): Promise<GitEventResponse> {
    const addr = validateRepoAddr(req.repoAddr);
    assertNonEmptyString(req.targetEventId, 'targetEventId');
    const kind = STATUS_KIND_BY_VALUE[req.status];
    if (kind === undefined) {
      throw new InvalidPayloadError(
        'status must be one of open | applied | closed | draft.'
      );
    }
    const event = buildStatus(req.targetEventId, kind, req.targetPubkey);
    // NIP-34 status events also carry the repo `a` tag so readers can scope
    // a status stream to the repository without resolving the target first.
    event.tags.push([
      'a',
      `${REPOSITORY_ANNOUNCEMENT_KIND}:${addr.ownerPubkey}:${addr.repoId}`,
    ]);
    return this.gitPublishSigned(event);
  }

  /** Sign a built NIP-34 event with the daemon key and pay-to-publish it. */
  private async gitPublishSigned(event: UnsignedEvent): Promise<GitEventResponse> {
    const apex = this.selectApex();
    this.assertApexReady(apex);
    const signed = await apex.client.signEvent(event);
    const pub = await this.publish({ event: signed });
    return { ...pub, kind: event.kind };
  }

  /** Graceful teardown: close every relay + stop every apex client. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const relay of this.relays.values()) relay.close();
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
    // FREE reads need no uplink; a write does. Reject early with an actionable
    // message rather than letting the apex sit forever un-bootstrapped (#69).
    if (!this.config.hasUplink) {
      throw new TargetError(
        'No write uplink configured — this daemon is read-only. Set ' +
          'TOON_CLIENT_PROXY_URL (connector proxy) or TOON_CLIENT_BTP_URL to ' +
          'enable paid writes.'
      );
    }
    if (!apex.ready) {
      throw new NotReadyError(
        apex.bootstrapping
          ? 'Apex is still bootstrapping (transport/channel coming up) — retry shortly.'
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

/** Thrown when a model-authored publish/upload payload fails validation (HTTP 400). */
export class InvalidPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPayloadError';
  }
}

/**
 * Thrown when the on-chain balance read stalls past its per-call provider
 * timeout (after the bounded retry). Retryable, and explicitly attributed to the
 * balances handler / chain provider — NOT the relay/apex — so the user-facing
 * message names the real failing subsystem (#199). Maps to HTTP 504.
 */
export class BalancesUnavailableError extends Error {
  readonly retryable = true;
  /** The underlying provider error message, when one was captured. */
  readonly providerError?: string;
  constructor(message: string, providerError?: string) {
    super(message);
    this.name = 'BalancesUnavailableError';
    if (providerError !== undefined) this.providerError = providerError;
  }
}

/**
 * Upload price per git-object body byte, micro-USDC. Matches the network
 * default `basePricePerByte` (10) the ToonClient prices writes with and the
 * seed pipeline bids (`bytes × 10`); the bid tag, the signed claim, and the
 * ILP amount all use this same figure so the pre-push estimate is exactly
 * what a push pays.
 */
const UPLOAD_FEE_PER_BYTE = 10n;

/** NIP-34 status kinds by wire value (`GitStatusRequest.status`). */
const STATUS_KIND_BY_VALUE: Record<string, StatusKind> = {
  open: STATUS_OPEN_KIND,
  applied: STATUS_APPLIED_KIND,
  closed: STATUS_CLOSED_KIND,
  draft: STATUS_DRAFT_KIND,
};

/** Validate that `repoPath` names an existing directory (a git repo check
 *  proper happens on first plumbing call — a non-repo dir surfaces as a
 *  GitError the routes map to 400). */
async function assertRepoPath(repoPath: unknown): Promise<void> {
  if (typeof repoPath !== 'string' || repoPath === '') {
    throw new InvalidPayloadError('repoPath is required.');
  }
  let stats;
  try {
    stats = await stat(resolve(repoPath));
  } catch {
    throw new InvalidPayloadError(`repoPath does not exist: ${repoPath}`);
  }
  if (!stats.isDirectory()) {
    throw new InvalidPayloadError(`repoPath is not a directory: ${repoPath}`);
  }
}

function assertNonEmptyString(value: unknown, what: string): void {
  if (typeof value !== 'string' || value === '') {
    throw new InvalidPayloadError(`${what} is required.`);
  }
}

/** Validate a NIP-34 repo address (owner pubkey + repo id). */
function validateRepoAddr(addr: GitRepoAddr | undefined): GitRepoAddr {
  if (
    !addr ||
    typeof addr.ownerPubkey !== 'string' ||
    !/^[0-9a-f]{64}$/.test(addr.ownerPubkey)
  ) {
    throw new InvalidPayloadError(
      'repoAddr.ownerPubkey must be a 64-char lowercase hex Nostr pubkey.'
    );
  }
  if (typeof addr.repoId !== 'string' || addr.repoId === '') {
    throw new InvalidPayloadError('repoAddr.repoId is required.');
  }
  return addr;
}

/** Serialize a PushPlan onto the wire (bigints → strings, Maps → records). */
function serializePushPlan(plan: PushPlan): GitEstimateResponse {
  return {
    repoId: plan.repoId,
    refUpdates: plan.refUpdates,
    newRefs: plan.newRefs,
    headSymref: plan.headSymref,
    objects: plan.objects,
    knownShaToTxId: Object.fromEntries(plan.knownShaToTxId),
    announceNeeded: plan.announceNeeded,
    announcement: plan.announcement,
    estimate: serializeFeeEstimate(plan),
  };
}

function serializeFeeEstimate(plan: PushPlan): GitFeeEstimate {
  return {
    objectCount: plan.estimate.objectCount,
    totalObjectBytes: plan.estimate.totalObjectBytes,
    uploadFee: plan.estimate.uploadFee.toString(),
    eventCount: plan.estimate.eventCount,
    eventFees: plan.estimate.eventFees.toString(),
    totalFee: plan.estimate.totalFee.toString(),
  };
}

/** Serialize a PushResult onto the wire (bigints → strings, Maps → records). */
function serializePushResult(
  plan: PushPlan,
  result: PushResult
): GitPushResponse {
  return {
    repoId: plan.repoId,
    refUpdates: plan.refUpdates,
    uploads: result.uploads.map((u) => ({
      sha: u.sha,
      txId: u.txId,
      feePaid: u.feePaid.toString(),
      skipped: u.skipped,
    })),
    announceReceipt: result.announceReceipt
      ? {
          eventId: result.announceReceipt.eventId,
          feePaid: result.announceReceipt.feePaid.toString(),
        }
      : null,
    refsReceipt: {
      eventId: result.refsReceipt.eventId,
      feePaid: result.refsReceipt.feePaid.toString(),
    },
    arweaveMap: Object.fromEntries(result.arweaveMap),
    totalFeePaid: result.totalFeePaid.toString(),
    estimate: serializeFeeEstimate(plan),
  };
}

/** Current time in whole seconds (Nostr `created_at` unit). */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Resolve after `ms` (bounded wait for relay delivery in `query`). */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Race a promise against a timeout, rejecting with `message` if it does not
 * settle in `ms`. The underlying work is NOT cancelled (it may complete in the
 * background) — this just bounds how long the caller waits, so a stalled chain
 * RPC fast-fails instead of blocking the control request (#199).
 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/** NIP-01 filter match (kinds/authors/ids/since/until + `#<letter>` tag filters). */
function matchesFilter(event: NostrEvent, filter: NostrFilter): boolean {
  if (filter.ids && !filter.ids.includes(event.id)) return false;
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  if (filter.since !== undefined && event.created_at < filter.since) return false;
  if (filter.until !== undefined && event.created_at > filter.until) return false;
  for (const [key, values] of Object.entries(filter)) {
    if (!key.startsWith('#') || !Array.isArray(values)) continue;
    const letter = key.slice(1);
    const hit = event.tags.some(
      (t) => t[0] === letter && t[1] !== undefined && values.includes(t[1])
    );
    if (!hit) return false;
  }
  return true;
}

/** Validate that `raw` is an array of string arrays, returning it typed. */
function normalizeTags(raw: unknown): string[][] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new InvalidPayloadError('tags must be an array.');
  return raw.map((tag, i) => {
    if (!Array.isArray(tag) || !tag.every((x) => typeof x === 'string')) {
      throw new InvalidPayloadError(`tags[${i}] must be an array of strings.`);
    }
    return tag as string[];
  });
}

/** Append `additions` to `base`, de-duping whole tags (for replaceable merges). */
function mergeTags(base: string[][], additions: string[][]): string[][] {
  const seen = new Set(base.map((t) => JSON.stringify(t)));
  const out = [...base];
  for (const tag of additions) {
    const key = JSON.stringify(tag);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(tag);
    }
  }
  return out;
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

/**
 * Cap on per-packet outcomes echoed on a `SwapResponse`. Adaptive sizing can
 * schedule an unbounded packet count (δ_min defaults to 1 micro-unit); the
 * cumulative totals stay exact, only the per-packet echo is truncated.
 */
const SWAP_PACKETS_RESPONSE_LIMIT = 500;

/**
 * Derive the hard floor from the advertised rate (#351, rolling-swap spec §5:
 * `minExchangeRate = R₀ × (1 − tolerance)`): exact decimal-string
 * `rate × (10000 − floorBps) / 10000` — no float round-trip, so the floor is
 * bit-stable for the sdk's BigInt comparison. Returns `undefined` when no
 * tolerance is configured. Exported for tests.
 */
export function deriveFloorRate(
  rate: string,
  floorBps: number | undefined
): string | undefined {
  if (floorBps === undefined) return undefined;
  if (!Number.isInteger(floorBps) || floorBps < 0 || floorBps >= 10_000) {
    throw new InvalidPayloadError(
      `floorBps must be an integer in [0, 10000), got ${String(floorBps)}.`
    );
  }
  const m = /^(\d+)(?:\.(\d+))?$/.exec(rate.trim());
  if (!m) {
    throw new InvalidPayloadError(
      `pair.rate "${rate}" is not a plain positive decimal — cannot derive ` +
        'a floor from floorBps; pass minExchangeRate explicitly.'
    );
  }
  const [, intDigits = '', fracDigits = ''] = m;
  const digits = intDigits + fracDigits;
  const scale = fracDigits.length + 4; // ×(10000−bps) adds 4 decimal places
  const scaled = (BigInt(digits) * BigInt(10_000 - floorBps))
    .toString()
    .padStart(scale + 1, '0');
  const intPart = scaled.slice(0, -scale);
  const fracPart = scaled.slice(-scale).replace(/0+$/, '');
  return fracPart ? `${intPart}.${fracPart}` : intPart;
}

/**
 * Realized-rate summary: delivered/spent in WHOLE units, adjusted for the
 * pair's asset scales (display-only `number`, same convention as the sdk's
 * `PacketProgress.effectiveRate`). `undefined` when nothing was filled.
 */
function computeRealizedRate(
  cumulativeSource: bigint,
  cumulativeTarget: bigint,
  pair: SwapRequest['pair']
): number | undefined {
  if (cumulativeSource <= 0n) return undefined;
  return (
    (Number(cumulativeTarget) / Number(cumulativeSource)) *
    10 ** (pair.from.assetScale - pair.to.assetScale)
  );
}
