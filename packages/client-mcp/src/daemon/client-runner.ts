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
import {
  decodeEventFromToon,
  GenesisPeerLoader,
  type IlpPeerInfo,
} from '@toon-protocol/core';
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
  ingestAndReveal,
  buildSwapSettlements,
  counterpartyMatch,
  InMemoryReceivedClaimStore,
  JsonFileReceivedClaimStore,
  InMemoryPreimageRetentionStore,
  isValidStreamNonce,
  encodeRollingFillPayload,
  sendRollingRfq,
  type RollingRfqResponse,
  type FaucetChain,
  type ReceivedClaimEntry,
  type ReceivedClaimStore,
  type RevealFn,
} from '@toon-protocol/client';
import {
  loadMinaSignerClient,
  type SettlementBundle,
} from '@toon-protocol/sdk';
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
  Nip59UnwrapResponse,
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
  SwapClaim,
  SwapError,
  SwapRejection,
  SwapRollingInfo,
  ListSwapClaimsResponse,
  ReceivedClaimInfo,
  SettleSwapClaimsRequest,
  SettleSwapClaimsResponse,
  SwapSettlementResult,
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
  supersedeApexChannel,
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
import type { OperatorNotice } from './notice.js';
import type { PublishEventResult } from '@toon-protocol/client';
import { RollingSwapSessionRegistry } from './rolling-swap-sessions.js';

/** The subset of `ToonClient` the runner depends on. */
export interface ToonClientLike {
  start(): Promise<{ peersDiscovered: number; mode: string }>;
  stop(): Promise<void>;
  getPublicKey(): string;
  getEvmAddress(): string | undefined;
  getSolanaAddress(): string | undefined;
  getMinaAddress(): string | undefined;
  getNetworkStatus(): { evm: string; solana: string; mina: string } | undefined;
  /**
   * The `IlpPeerInfo` a discovered kind:10032 announce author advertised, by
   * Nostr pubkey (issue #572) — used to source a swap MAKER's own
   * `settlementAddresses`/`tokenNetworks` (leg A) instead of trusting only
   * the local daemon config. Optional so lightweight fakes need not
   * implement it — the real `ToonClient` does.
   */
  getDiscoveredPeerInfo?(pubkey: string): IlpPeerInfo | undefined;
  /**
   * The **leg-B** `swapVerifyingContracts` map a swap MAKER announced
   * (toon-client#583) — chain key → its deployed `RollingSwapChannel`, the
   * EIP-712 `verifyingContract` a received balance-proof claim verifies
   * under. Read off the announce's raw content, since core's
   * `parseIlpPeerInfo` drops the field, so it is NOT reachable through
   * {@link getDiscoveredPeerInfo}. Optional for the same reason.
   */
  getSwapVerifyingContracts?(
    pubkey: string
  ): Record<string, string> | undefined;
  publishEvent(
    event: NostrEvent,
    options?: {
      destination?: string;
      claim?: unknown;
      ilpAmount?: bigint;
      /** Request-target inside the sealed envelope (default '/write';
       *  '/store' routes to the Arweave store/DVM backend). */
      proxyPath?: string;
    }
  ): Promise<PublishEventResult>;
  signBalanceProof(channelId: string, amount: bigint): Promise<unknown>;
  /**
   * Flat price of one packet to `destination`, from the connector that
   * terminates it (`GET /ilp/routes/price`); `null` when it terminates no
   * matching route. ADR 0020 prices a packet per handler, so this figure is
   * the whole fee — there is no per-byte rate to multiply it by.
   */
  getRoutePrice(destination: string): Promise<bigint | null>;
  /**
   * Sign an unsigned event template with the daemon-held Nostr key (the key
   * never leaves the daemon). Backs the `publish-unsigned` / `upload-media`
   * paths so a UI/agent supplies only the event shell.
   */
  signEvent(template: EventTemplate): NostrEvent | Promise<NostrEvent>;
  /**
   * Unwrap a NIP-59 gift wrap (kind:1059) addressed to this identity,
   * decrypting both NIP-44 layers with the daemon-held Nostr key (the key
   * never leaves the daemon). Backs `POST /nip59-unwrap` (toon-meta#256).
   * Throws `GiftWrapAddressError` (malformed/wrong-kind/not-addressed) or
   * `GiftWrapDecryptError` (a NIP-44 layer failed, or seal verification
   * failed) — see `@toon-protocol/client`'s `nip59.ts`.
   */
  unwrapGiftWrap(
    wrap: NostrEvent
  ): Nip59UnwrapResponse | Promise<Nip59UnwrapResponse>;
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
  }): Promise<{
    success: boolean;
    txId?: string;
    eventId?: string;
    error?: string;
  }>;
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
  closeChannel(channelId: string): Promise<{
    channelId: string;
    txHash?: string;
    closedAt: string;
    settleableAt: string;
  }>;
  settleChannel(
    channelId: string
  ): Promise<{ channelId: string; txHash?: string }>;
  getChannelCloseState(
    channelId: string
  ): 'open' | 'closing' | 'settleable' | 'settled';
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
  /**
   * Bind an already-open channel to a destination so the client's lazy-open
   * path RESUMES it instead of opening a second one (#489). Optional for the
   * same reason as `rehydrateChannelDeposit`; best-effort — callers catch.
   */
  adoptChannel?(destination: string, channelId: string): Promise<void>;
  /**
   * The ILP address this client RECEIVES on — the id its BTP session is bound
   * under at the connector, resolved there by EXACT match. Used as the
   * rolling-swap RFQ's `senderIlpAddress` (toon-client#585): the maker
   * addresses every leg-B PREPARE of the session to it verbatim and has no
   * fallback. Optional so lightweight fakes need not implement it; the real
   * `ToonClient` does.
   */
  getOwnIlpAddress?(): string | undefined;
  sendSwapPacket(params: {
    destination: string;
    amount: bigint;
    toonData: Uint8Array;
    claim?: unknown;
    /** Per-packet send timeout, ms (transport default ~30s). */
    timeout?: number;
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
  /**
   * Submit a receive-side swap settlement bundle on-chain (#352). EVM only;
   * env-gated on `chainRpcUrls[bundle.chain]`. Optional so lightweight fakes
   * need not implement it — the runner surfaces a result-shaped
   * `SUBMISSION_UNAVAILABLE` when absent.
   */
  settleSwapBundle?(
    bundle: SettlementBundle
  ): Promise<{ txHash: string; status?: 'success' | 'reverted' }>;
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
   * Pubkeys whose announce-carried operator notice (issue #544's client-mcp
   * half of toon-meta#252) is trusted and surfaced via `toon_status`.
   * Defaults to the committed genesis-seed pubkeys
   * (`GenesisPeerLoader.loadGenesisPeers()`), mirroring the trust rule
   * toon-protocol/rig#78 settled on for the same field. Anyone can publish a
   * kind:10032, so a notice from any other pubkey is silently dropped.
   */
  trustedNoticePubkeys?: readonly string[];
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
  /** The apex's announce-carried operator notice, when discovered from a trusted announcer. */
  notice?: OperatorNotice;
  /**
   * This apex's negotiation came out of the PERSISTED targets store, so it must
   * be re-validated against the live announce before it is trusted
   * (toon-client#581). Set only on the replay path — a config-supplied
   * negotiation is the operator's explicit instruction and wins, and a
   * negotiation `addApex` just discovered is already the announce.
   */
  revalidateNegotiation?: boolean;
  /**
   * The persisted target this apex was replayed from, so a drifted announce can
   * be written back once rather than re-corrected on every start.
   */
  replayedFrom?: PersistedApexTarget;
}

/**
 * An ESTABLISHED rolling-swap session, ready to fill against (#585). Produced
 * only by {@link ClientRunner.negotiateRollingSession} — either from a
 * kind:20034 quote or from a caller-pinned, out-of-band-registered nonce.
 */
interface RollingSessionArm {
  kind: 'rolling';
  streamNonce: string;
  /** The maker's kind:20034 quote; absent when the nonce was caller-pinned. */
  quote?: RollingRfqResponse;
  /** Whether an RFQ probe was actually sent for this session. */
  probed: boolean;
}

/** The outcome of rolling capability discovery: a session, or "use legacy". */
type RollingNegotiation =
  | RollingSessionArm
  | {
      kind: 'legacy';
      /**
       * Why the swap is on the legacy path — echoed onto the response, and
       * since #595 also raised as a `warning`, so an opted-into downgrade is
       * never merely inferable. Set on EVERY legacy outcome including
       * `rolling: 'off'` (`fallbackReason: 'off'`); absent only on the
       * caller-pinned-nonce arm, which is not a legacy outcome at all.
       */
      note?: SwapRollingInfo;
    };

/**
 * Packets for a rolling stream when the caller pinned no `packetCount`: one,
 * unless the quote caps per-packet size (`maxAmount`, spec §2.2), in which
 * case the smallest split that respects the cap. Sending a single packet over
 * the maker's own advertised cap is a guaranteed reject.
 */
function packetsForQuote(
  totalAmount: bigint,
  quote: RollingRfqResponse | undefined
): number {
  const cap = quote?.maxAmount;
  if (cap === undefined) return 1;
  let max: bigint;
  try {
    max = BigInt(cap);
  } catch {
    return 1;
  }
  if (max <= 0n || totalAmount <= max) return 1;
  const packets = (totalAmount + max - 1n) / max;
  return packets > BigInt(Number.MAX_SAFE_INTEGER) ? 1 : Number(packets);
}

/** A decimal-string amount as a bigint, or `undefined` if it is not one. */
function sizeHintOf(amount: string): bigint | undefined {
  if (!/^\d+$/.test(amount)) return undefined;
  try {
    return BigInt(amount);
  } catch {
    return undefined;
  }
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
  /** Pubkeys whose announce-carried notice is trusted — see {@link ClientRunnerDeps.trustedNoticePubkeys}. */
  private readonly trustedNoticePubkeys: readonly string[];

  /** Remote-state reader for `/git/*` (injectable — opens relay sockets). */
  private readonly fetchGitRemoteState: typeof fetchRemoteState;
  /** Local-repo reader factory for `/git/*` (injectable for tests). */
  private readonly createRepoReader: (repoPath: string) => GitRepoReader;

  /**
   * Rolling-swap leg-B inbound router (toon-client#573) — installed as every
   * apex client's `jobHandler` in the constructor (see `this.config`'s
   * assignment below), so a maker→sender leg-B PREPARE reaches whichever
   * `swap()` call currently has a matching `streamNonce` registered.
   */
  private readonly rollingSessions = new RollingSwapSessionRegistry();

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
   * Durable store for VERIFIED received swap claims (chain-B watermarks,
   * #352) — file-backed when the config names a path (production), in-memory
   * otherwise (manually-built test configs). Claims survive a daemon restart.
   */
  private readonly receivedClaimStore: ReceivedClaimStore;

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
  /**
   * BTP endpoint of the auto-registered STORE apex (issue #536 correction),
   * when the config names one distinct from the default uplink. The relay
   * and store connectors are independent boxes with no forwarding between
   * them, so store writes need their OWN uplink — a renamed destination on
   * the relay's uplink routes nowhere. Undefined means the single-apex
   * behaviour (store writes use the default apex, same as publishes).
   */
  private readonly defaultStoreBtpUrl?: string;

  private stopped = false;
  private started = false;

  constructor(deps: ClientRunnerDeps) {
    // Install the rolling-swap leg-B router as every apex's `jobHandler`
    // (toon-client#573) — `ToonClientConfig.jobHandler` is fixed at client
    // construction (toon-client#494), so this must happen before
    // `this.createClient` is ever called below. `deriveApexClientConfig`
    // spreads `this.config.toonClientConfig`, so every apex (default, store,
    // dynamically added, replayed) inherits it from this one assignment. A
    // caller-supplied `jobHandler` (none exist today) always wins.
    this.config = {
      ...deps.config,
      toonClientConfig: {
        ...deps.config.toonClientConfig,
        jobHandler:
          deps.config.toonClientConfig.jobHandler ??
          this.rollingSessions.jobHandler,
      },
    };
    this.createClient = deps.createClient;
    this.log = deps.logger ?? ((): void => undefined);
    if (deps.targetsPath !== undefined) this.targetsPath = deps.targetsPath;
    this.trustedNoticePubkeys =
      deps.trustedNoticePubkeys ??
      GenesisPeerLoader.loadGenesisPeers().map((p) => p.pubkey);
    this.fetchGitRemoteState =
      deps.gitDeps?.fetchRemoteState ?? fetchRemoteState;
    this.createRepoReader =
      deps.gitDeps?.createRepoReader ??
      ((repoPath) => new GitRepoReader(repoPath));
    this.defaultBtpUrl = deps.config.toonClientConfig.btpUrl ?? '';
    this.defaultRelayUrl = deps.config.relayUrl;
    this.defaultStoreBtpUrl =
      deps.config.storeBtpUrl && deps.config.storeBtpUrl !== this.defaultBtpUrl
        ? deps.config.storeBtpUrl
        : undefined;
    this.receivedClaimStore = deps.config.receivedClaimStorePath
      ? new JsonFileReceivedClaimStore(deps.config.receivedClaimStorePath)
      : new InMemoryReceivedClaimStore();

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

    // Second config-seeded apex: a store connector INDEPENDENT of the relay
    // (issue #536 correction). Built the same way a discovered/added apex
    // is (`deriveApexClientConfig`), so its packets reach the store's own
    // connector instead of the default uplink's — the same derivation the
    // `toon_add_apex` mechanism already relies on. No negotiation is
    // supplied here; `doBootstrapApex` discovers it (proxy mode: from the
    // default relay's kind:10032; BTP mode: via the client's own bootstrap),
    // exactly like a manually-added apex.
    if (this.defaultStoreBtpUrl) {
      const storeClientConfig = this.deriveApexClientConfig(
        this.defaultStoreBtpUrl,
        this.config.storeDestination
      );
      const storeApex = this.makeApex({
        btpUrl: this.defaultStoreBtpUrl,
        client: this.createClient(storeClientConfig),
        childPeers: [],
        destination: this.config.storeDestination,
        chain: this.config.chain,
        channelStorePath: this.apexChannelStorePathFor(this.defaultStoreBtpUrl),
        feePerEvent: this.config.feePerEvent,
        isDefault: true,
      });
      this.apexes.set(storeApex.btpUrl, storeApex);
    }
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

  /**
   * Await the default apex(es)' bootstrap (kicking it off if not already
   * running) — the relay apex, and the store apex too when `storeBtpUrl`
   * registered a second one (issue #536 correction).
   *
   * SEQUENTIAL, not `Promise.all`: each apex may open an on-chain payment
   * channel, and both legs sign from the SAME wallet. Bootstrapping them
   * concurrently builds two transactions against the same account nonce, so
   * the second is rejected ("nonce ... lower than the current nonce of the
   * account" / `already known`) and that uplink is left `ready: false` on
   * every fresh install — observed live on devnet against the relay+store
   * pair. Serializing the legs costs one extra round of latency on first
   * start only; the on-chain open it protects is the slow part either way.
   * A failing leg cannot strand the other: `doBootstrapApex` records its own
   * `lastError` and never rejects.
   */
  async bootstrap(): Promise<void> {
    // Read-only daemon (no proxy/BTP uplink): never bootstrap an apex — there is
    // no write transport and FREE reads run off the relay subscription (#69).
    if (!this.config.hasUplink) return;
    const targets = [this.defaultApex(), this.defaultStoreApex()].filter(
      (a): a is ApexConnection => a !== undefined
    );
    for (const apex of targets) await this.bootstrapApex(apex);
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
    revalidateNegotiation?: boolean;
    replayedFrom?: PersistedApexTarget;
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
    let staleNegotiationWarning: string | undefined;
    try {
      // PROXY mode (no BTP discovery): if no negotiation was supplied via config,
      // discover the apex's settlement params from its kind:10032 on the default
      // relay before opening the channel (#69). Config-supplied negotiation wins.
      // In BTP mode the legacy bootstrap path handles discovery, so skip this.
      if (!apex.negotiation && this.config.proxyUrl) {
        await this.discoverApexNegotiation(apex);
      } else if (apex.revalidateNegotiation && this.config.proxyUrl) {
        // A REPLAYED negotiation is a cache, not a fact (toon-client#581).
        staleNegotiationWarning = await this.revalidateApexNegotiation(apex);
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
      // An apex that came up on an UNVERIFIED (persisted) negotiation is ready
      // but not trustworthy — surface it rather than silently paying a ghost
      // (toon-client#581). A clean bootstrap clears the field as before.
      apex.lastError = staleNegotiationWarning;
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
      // Carried so the announce's endpoint can be judged against the relay it
      // came off (toon-client#593): a loopback relay means a local stack, a
      // public one means a loopback endpoint is pointing at the CALLER.
      relayUrl: req.relayUrl,
      trustedPubkeys: this.trustedNoticePubkeys,
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
    apex.notice = discovered.notice;
    return {
      btpUrl: apex.btpUrl,
      destination: apex.destination,
      chain: apex.chain,
      ready: apex.ready,
    };
  }

  /**
   * Build + register + bootstrap an apex from a (persisted) target record.
   *
   * `opts.replayed` marks a target read back off disk, whose negotiation is a
   * CACHE of an announce that may be years old — see
   * {@link revalidateApexNegotiation}. `addApex` passes it false: its
   * negotiation came straight off the live announce moments earlier.
   */
  private async instantiateApex(
    target: PersistedApexTarget,
    persist: boolean,
    opts: { replayed?: boolean } = {}
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
      ...(opts.replayed
        ? { revalidateNegotiation: true, replayedFrom: target }
        : {}),
    });
    this.apexes.set(apex.btpUrl, apex);
    if (persist) saveApexTarget(target, this.targetsPath);
    await this.bootstrapApex(apex);
  }

  /**
   * Remove an apex write target. Neither config-seeded default (relay or,
   * when configured, store — issue #536) can be removed.
   */
  async removeApex(btpUrl: string): Promise<void> {
    if (btpUrl === this.defaultBtpUrl || btpUrl === this.defaultStoreBtpUrl) {
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
      // Both config-seeded defaults (relay + the auto store apex, #536) are
      // already registered in the constructor; `instantiateApex`'s own
      // `apexes.has` guard would no-op these anyway, but skip explicitly so
      // the intent reads at the call site.
      if (
        a.btpUrl === this.defaultBtpUrl ||
        a.btpUrl === this.defaultStoreBtpUrl
      )
        continue;
      void this.instantiateApex(a, false, { replayed: true }).catch((err) =>
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
   *
   * A persisted record is only resumed while it still names the CURRENT
   * counterparty. The store's key is `destination|chain` — an ILP name, not a
   * node — so when the node terminating that name is replaced (the devnet apex
   * `g.toon` was retired and other nodes took over the names under it) both key
   * fields still match, and the runner used to resume, adopt AND re-bind a
   * channel the node now answering has no record of: every paid write came back
   * `F01 - claim rejected: names a channel this connector has no record of`
   * until the record was deleted by hand. On a mismatch the record is
   * superseded (archived, so its on-chain deposit stays reclaimable) and the
   * channel re-resolved below — `openChannel` binds whatever channel this
   * identity already holds with the new counterparty where one exists, rather
   * than opening and funding a fresh one.
   */
  private async openOrResumeApexChannel(
    apex: ApexConnection,
    opts: { resumeOnly?: boolean } = {}
  ): Promise<string | undefined> {
    const { destination, chain } = apex;
    const { apexChannelStorePath } = this.config;
    const recorded = loadApexChannel(apexChannelStorePath, destination, chain);
    const cm = (
      apex.client as unknown as {
        channelManager?: {
          trackChannel?: (id: string, ctx: PersistedChannelContext) => void;
        };
      }
    ).channelManager;

    const announced = apex.negotiation?.settlementAddress;
    let saved = recorded;
    if (
      recorded &&
      counterpartyMatch(recorded.context, announced) === 'mismatch'
    ) {
      this.log(
        `[runner] apex channel ${recorded.channelId} for ${destination} was opened ` +
          `against counterparty ${recorded.context.recipient}, but ${destination} ` +
          `now announces ${announced} — the node terminating that route was ` +
          'replaced. Re-resolving the channel; the old record is kept ' +
          `(superseded) in ${apexChannelStorePath} so its deposit stays reclaimable.`
      );
      supersedeApexChannel(apexChannelStorePath, destination, chain);
      // Nothing to resume: fall through to the open path below, which resolves
      // against the address announced NOW and binds the channel this identity
      // already holds with that counterparty where there is one.
      saved = null;
    }

    if (saved && cm && typeof cm.trackChannel === 'function') {
      // MIGRATION: records written before the counterparty was validated carry
      // no `context.recipient`. Nothing contradicts them, so the resume
      // proceeds — with the announced address filled in and written back, so
      // the next start is verifiable rather than unverifiable forever.
      const context =
        saved.context.recipient === undefined && announced
          ? { ...saved.context, recipient: announced }
          : saved.context;
      if (context !== saved.context) {
        saveApexChannel(apexChannelStorePath, destination, chain, {
          ...saved,
          context,
        });
      }
      cm.trackChannel(saved.channelId, context);
      // Tracking alone leaves the client's LAZY-open path unaware of this
      // channel, so the first paid write used to open (and fund) a second one
      // (#489). `adoptChannel` binds it to the destination — with its claim
      // watermark — so every later write resumes it. Best-effort: on an older
      // client (or before the peer negotiation is known) the tracked channel
      // above is still the pre-#489 behaviour.
      await apex.client
        .adoptChannel?.(destination, saved.channelId)
        .catch((err) =>
          this.log(
            `[runner] adopt of resumed channel ${saved.channelId} failed: ${errMsg(err)}`
          )
        );
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
      this.log(
        `[runner] resumed apex channel ${saved.channelId} (deposit re-read)`
      );
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
      relayUrl: this.defaultRelayUrl,
      chain: apex.chain,
      trustedPubkeys: this.trustedNoticePubkeys,
      ...(apex.childPeers.length > 0 ? { childPeers: apex.childPeers } : {}),
    });
    apex.negotiation = discovered.negotiation;
    apex.notice = discovered.notice;
    if (discovered.apexChildPeers) apex.childPeers = discovered.apexChildPeers;
    this.log(
      `[runner] discovered apex negotiation for "${apex.destination}" ` +
        `(chain ${discovered.negotiation.chainKey}, settle ` +
        `${discovered.negotiation.settlementAddress})`
    );
  }

  /**
   * Re-validate a REPLAYED apex negotiation against the live kind:10032
   * announce, and prefer the announce (toon-client#581).
   *
   * `replayPersistedTargets` → `instantiateApex` used to take a persisted
   * negotiation from `~/.toon-client/targets.json` VERBATIM, and
   * `discoverApexNegotiation` only ran when there was no negotiation at all. So
   * the "currently-announced" address that #578/#580's counterparty check
   * compares a channel record against could itself be a stale cache: recorded
   * `0xf29fd62c…` vs injected `0xf29fd62c…` read as `match`, and the dead
   * channel was resumed exactly as before. `0xf29fd62c…` is the retired `g.toon`
   * apex, destroyed 2026-08-14 — the one path where the whole guard was
   * defeated, because a check is only as good as its right-hand side.
   *
   * The announce is the authority (the same "trust the announce, not the
   * preset" rule as the sandbox contract-address drift). Discovery FAILING is a
   * separate, louder problem than drift: an apex that no longer announces at all
   * may be gone, so the persisted negotiation is kept as a last resort and the
   * fact is returned for `lastError` rather than swallowed.
   *
   * Drift is re-persisted so it is corrected ONCE rather than on every start.
   *
   * @returns a warning to surface as the apex's `lastError`, or `undefined`
   *   when the announce was reached (whether or not it had drifted).
   */
  private async revalidateApexNegotiation(
    apex: ApexConnection
  ): Promise<string | undefined> {
    const persisted = apex.negotiation;
    try {
      await this.discoverApexNegotiation(apex);
    } catch (err) {
      apex.negotiation = persisted;
      const warning =
        `apex "${apex.destination}" could not be re-validated against a live ` +
        `kind:10032 announce (${errMsg(err)}); falling back to the negotiation ` +
        `persisted in ${this.targetsPath}, which may name a node that no longer ` +
        'exists. Paid writes may be refused (F01) until it announces again.';
      this.log(`[runner] ${warning}`);
      return warning;
    }

    const fresh = apex.negotiation;
    if (!fresh || !persisted || negotiationsAgree(persisted, fresh)) {
      return undefined;
    }

    this.log(
      `[runner] apex "${apex.destination}" announce has DRIFTED from the ` +
        `persisted target: settlement ${persisted.settlementAddress} → ` +
        `${fresh.settlementAddress}, tokenNetwork ${persisted.tokenNetwork} → ` +
        `${fresh.tokenNetwork}. Preferring the announce and re-persisting.`
    );
    const replayed = apex.replayedFrom;
    saveApexTarget(
      {
        ...(replayed ?? { btpUrl: apex.btpUrl, negotiation: fresh }),
        btpUrl: apex.btpUrl,
        negotiation: fresh,
        ...(apex.childPeers.length > 0
          ? { apexChildPeers: apex.childPeers }
          : {}),
      },
      this.targetsPath
    );
    return undefined;
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

  /** The auto-registered STORE apex (issue #536 correction), when configured. */
  private defaultStoreApex(): ApexConnection | undefined {
    return this.defaultStoreBtpUrl
      ? this.apexes.get(this.defaultStoreBtpUrl)
      : undefined;
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
      ...(apex?.notice ? { notice: apex.notice } : {}),
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
      // The relay's answer is now a sealed response envelope (ADR 0018); this
      // control-plane field stays base64 bytes, so carry its body across.
      ...(result.response !== undefined
        ? { data: Buffer.from(result.response.body).toString('base64') }
        : {}),
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
  private channelAvailable(
    apex: ApexConnection,
    channelId: string
  ): string | undefined {
    if (!apex.client.getTrackedChannels().includes(channelId)) return undefined;
    const cumulative = apex.client.getChannelCumulativeAmount(channelId);
    const depositTotal = apex.client.getChannelDepositTotal(channelId);
    const available =
      depositTotal > cumulative ? depositTotal - cumulative : 0n;
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
   * Unwrap a NIP-59 gift wrap addressed to this daemon's identity, using the
   * daemon-held Nostr key for both NIP-44 layers (toon-meta#256). Free — no
   * apex/BTP/channel involved, since decryption is a pure identity-level
   * operation, not a paid write. Reaches `identityClient` (not a specific
   * apex) because the Nostr identity — and its secret key — is shared across
   * every apex; there is exactly one to unwrap with regardless of which
   * apexes are registered.
   *
   * Errors (`GiftWrapAddressError` / `GiftWrapDecryptError`) propagate as-is
   * for `routes.ts` to map to 400 / 422.
   */
  async nip59Unwrap(wrap: NostrEvent): Promise<Nip59UnwrapResponse> {
    return this.identityClient.unwrapGiftWrap(wrap);
  }

  /**
   * Upload media to Arweave (kind:5094 blob DVM, single-packet) then sign+publish
   * a media event referencing the resulting URL. One spendy operation, two steps,
   * entirely server-side.
   */
  async uploadMedia(req: UploadMediaRequest): Promise<UploadMediaResponse> {
    const apex = this.selectApex(req.btpUrl);
    // The blob leg terminates at the store backend, a DIFFERENT connector
    // than the relay apex above (issue #536 correction) — an explicit
    // `req.btpUrl` still pins BOTH legs to the same apex (back-compat).
    const storeApex = this.selectStoreApex(req.btpUrl);
    this.assertApexReady(apex);
    this.assertApexReady(storeApex);
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
    const fee = req.fee !== undefined ? BigInt(req.fee) : storeApex.feePerEvent;
    // ── Leg 1: Arweave blob upload ──────────────────────────────────────────
    // Blob storage terminates at the store/DVM backend (POST /store → Arweave),
    // so it routes to the configured store destination (e.g. g.proxy.store,
    // derived from the `….relay.store` anchor by #143) THROUGH the store
    // apex — the relay's uplink serves no route there (issue #536). This
    // makes uploads work without the caller hand-passing a store `btpUrl`. A
    // failure here is distinct from the kind:1-equivalent publish below; label
    // it so the UI/agent can tell the upload leg apart from the publish leg.
    const upload = await storeApex.client.uploadBlob({
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
    const { url, fallbacks } = arweaveUrls(
      upload.txId,
      this.config.arweaveGateways
    );
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
      throw new InvalidPayloadError(
        `failed to read filePath ${resolved}: ${detail}`
      );
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
      [
        'imeta',
        `url ${url}`,
        `m ${mime}`,
        ...fallbacks.map((f) => `fallback ${f}`),
      ],
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
        const available =
          depositTotal > cumulative ? depositTotal - cumulative : 0n;
        const settleableAt = apex.client.getSettleableAt(channelId);
        channels.push({
          channelId,
          nonce: apex.client.getChannelNonce(channelId),
          cumulativeAmount: cumulative.toString(),
          depositTotal: depositTotal.toString(),
          availableBalance: available.toString(),
          closeState: apex.client.getChannelCloseState(channelId),
          ...(settleableAt !== undefined
            ? { settleableAt: settleableAt.toString() }
            : {}),
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
  async depositToChannel(
    req: ChannelDepositRequest
  ): Promise<ChannelDepositResponse> {
    return this.withTrackingApex(req.channelId, (client) =>
      client.depositToChannel(req.channelId, req.amount)
    );
  }

  /** Close a channel to begin the settlement grace period (withdraw, step 1). */
  async closeChannel(req: CloseChannelRequest): Promise<CloseChannelResponse> {
    return this.withTrackingApex(req.channelId, (client) =>
      client.closeChannel(req.channelId)
    );
  }

  /**
   * Settle a closed channel to release collateral (withdraw, step 2). The client
   * enforces the `now >= settleableAt` guard and throws a retryable error if
   * called early; `mapError` maps that to HTTP 425.
   */
  async settleChannel(
    req: SettleChannelRequest
  ): Promise<SettleChannelResponse> {
    return this.withTrackingApex(req.channelId, (client) =>
      client.settleChannel(req.channelId)
    );
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
   * The chain-key → **leg-B** verifying-contract map the v2 EIP-712
   * receive-side verify reconstructs an EVM claim's `(chainId,
   * verifyingContract)` domain from (#365, corrected by #572, fixed by #583).
   *
   * Base: the swap MAKER's own kind:10032 `swapVerifyingContracts` key
   * (`getSwapVerifyingContracts(swapPubkey)`, swap#134) — the maker's deployed
   * `RollingSwapChannel` per chain, advertised precisely so a client can
   * reconstruct that domain (toon-meta#394 T2) — read best-effort, so a maker
   * the daemon has not (yet) discovered simply contributes nothing, same as an
   * unstarted/fake client without the optional method. Override: the daemon's
   * configured `swapVerifyingContracts`, applied ON TOP so an operator can
   * still pin a specific mapping and a counterparty is never the sole
   * authority on what verifies its own signature (#574).
   *
   * Config is never the SOLE source (#572: one map cannot hold two makers'
   * deployments, and a daemon usually has none configured at all).
   *
   * What this deliberately does NOT read is `tokenNetworks` — from either
   * source. That map is **leg A**: the `TokenNetwork` this daemon opens its
   * own payment channel against to PAY the maker. Using it as the leg-B
   * fallback is #583: on live devnet it made a genuine, correctly-signed maker
   * claim recover an unrelated address and report `SIGNER_MISMATCH`, which
   * reads as a key problem and is not one. A chain with no leg-B contract now
   * fails `MISSING_SWAP_VERIFYING_CONTRACT` instead, which says what is
   * missing.
   *
   * Returns `undefined` when NEITHER source has anything — merging `{}` with
   * `{}` would otherwise thread an empty object through where "unset" is
   * expected.
   */
  private swapVerifyingContractsFor(
    client: ApexConnection['client'],
    swapPubkey: string
  ): Record<string, string> | undefined {
    const announced = safe(() =>
      client.getSwapVerifyingContracts?.(swapPubkey)
    );
    const configured = this.config.toonClientConfig.swapVerifyingContracts;
    if (!announced && !configured) return undefined;
    return { ...announced, ...configured };
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
   * **Path selection (toon-client#585, #595)** is a PROBE, not a config read:
   * {@link negotiateRollingSession} sends a kind:20033 RFQ, and the ENTIRE
   * call goes to {@link swapRolling} only if the maker answered kind:20034
   * and thereby registered the session (spec §10.3 step 2, swap#135). Every
   * other outcome — a maker with no RFQ intake, a reject, an unreadable
   * answer, a local throw — now **throws** {@link RollingUnavailableError}
   * naming the maker, its ILP address and the reason (ADR 0003: the rolling
   * swap is the only swap). The body below is the unchanged LEGACY path — a
   * zero-condition gift-wrap packet — and it is reached only when the caller
   * asked for it: `req.rolling` / `swapDefaults.rolling` set to `'auto'`
   * (probe, then downgrade) or `'off'` (never probe). Both annotate
   * `SwapResponse.rolling` AND raise a `warning`; neither is silent, and both
   * go with the legacy sender in Stage 4 (toon-client#598).
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
   *
   * Apex selection ({@link selectSwapApex}): `req.btpUrl` picks WHICH apex
   * client the swap streams on, keyed on BTP URL exactly as `publish` is —
   * the way to reach a DIRECT-DIALLED maker, one deliberately absent from a
   * relay connector's routing table and reachable at its own advertised
   * `btpEndpoint` after `addApex` registers it (#579). Unset, the swap goes
   * to the registered apex that OWNS `req.destination` rather than to the
   * config-seeded default: only that apex's client holds the negotiation for
   * the maker, so any other one resolves no peer for the destination and
   * every packet dies locally on the error path below.
   *
   * Failure visibility: `streamSwap` reports two DIFFERENT failure kinds —
   * `rejections[]` (the maker/connector answered REJECT) and `errors[]` (the
   * packet threw before it was ever sent). Both are mapped onto the response
   * and the daemon's own logger is handed to the sdk, so a swap that failed
   * entirely on this side says why instead of returning a bare
   * `abortReason: 'complete'`.
   */
  async swap(req: SwapRequest): Promise<SwapResponse> {
    const apex = this.selectSwapApex(req.destination, req.btpUrl);
    this.assertApexReady(apex);
    this.log(
      `[runner] swap to ${req.destination} on apex ` +
        `${apex.btpUrl || apex.destination} (peer "${apex.negotiation?.peerId ?? '?'}")`
    );
    // toon-client#585: probe for rolling capability, then take the rolling
    // path only if the maker actually established a session. Everything else
    // — including every way the probe can fail — falls through to the LEGACY
    // body below, unchanged.
    const negotiated = await this.negotiateRollingSession(req, apex);
    if (negotiated.kind === 'rolling') {
      return this.swapRolling(req, apex, negotiated);
    }
    const rollingNote = negotiated.note;

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
    const result = await streamSwap({
      client: apex.client as unknown as Parameters<
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
      // Without this the sdk falls back to a NO-OP logger and every
      // `stream_swap.*` diagnostic — including `wrap_failed` / `send_failed`,
      // the only account of a packet that never reached the maker — is
      // written nowhere. Route them into the daemon log.
      logger: this.structuredLogger('swap'),
    });
    const firstReject = result.rejections[0];

    // #352: receipt-time verification + durable ingestion. Every FULFILLed
    // claim with settlement metadata is verified (signature against the
    // maker's advertised/pinned signer, recipient, chain, nonce/cumulative
    // monotonicity vs the persisted watermark) and, only if it passes,
    // persisted as the channel's highest-nonce watermark. Claims MISSING
    // settlement metadata take the legacy #349 path (warning, not
    // persisted) unchanged.
    //
    // This is the LEGACY (zero-condition) path — leg A already resolved
    // inline at `sendSwapPacket` time (the transport verified nothing, since
    // no condition was sent), so `reveal` always commits: there is nothing
    // left here to withhold. The REAL verify-before-reveal seam
    // (`ingestAndReveal`'s withhold/rollback branch) is exercised on the
    // rolling path (toon-client#573, {@link swapRolling}), where leg A is
    // still pending when this decision is made.
    const expectedChain = req.pair.to.chain;
    const minaSignerClient = expectedChain.startsWith('mina')
      ? await loadMinaSignerClient()
      : undefined;
    // The leg-B verifying-contract map the EVM claims' v2 EIP-712 domain is
    // rebuilt from: this maker's own announce, config as override (#572/#583).
    const verifyingContracts = this.swapVerifyingContractsFor(
      apex.client,
      req.swapPubkey
    );
    const reveal: RevealFn = () => ({ decision: 'revealed' });
    const ingest = await ingestAndReveal({
      claims: result.claims,
      expectedChain,
      chainRecipient: req.chainRecipient,
      ...(req.swapSignerAddress
        ? { expectedSignerAddress: req.swapSignerAddress }
        : {}),
      ...(verifyingContracts
        ? { swapVerifyingContracts: verifyingContracts }
        : {}),
      store: this.receivedClaimStore,
      ...(minaSignerClient ? { minaSignerClient } : {}),
      reveal,
    });
    const verifiedSet = new Set(ingest.revealed.map((v) => v.claim));
    const rejectionByClaim = new Map(
      ingest.rejected.map((r) => [r.claim, r] as const)
    );
    for (const r of ingest.rejected) {
      this.log(
        `[runner] swap: REJECTED received claim (packet ${r.claim.packetIndex}, ` +
          `channel ${r.claim.channelId ?? '?'}): ${r.code} — ${r.message}`
      );
    }

    const claims = result.claims.map((c): SwapClaim => {
      const rejection = rejectionByClaim.get(c);
      return {
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
        ...(verifiedSet.has(c) ? { verified: true } : {}),
        ...(rejection
          ? {
              verified: false,
              verificationError: {
                code: rejection.code,
                message: rejection.message,
              },
            }
          : {}),
      };
    });

    // Wire-rename skew guard (#349): claims were FULFILLed but none carries
    // the swapSignerAddress settlement metadata — the signature of a
    // pre-rename swap peer (emits `millSignerAddress`, silently dropped by
    // sdk ≥2's decodeFulfillMetadata). Settlement of these claims WILL fail
    // with MISSING_SETTLEMENT_METADATA; say so now instead of then.
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
    const warnings: string[] = [];
    // #595: reaching this body at all means the swap ran LEGACY, which only
    // happens now because the caller explicitly asked for it. Say so on the
    // response itself — `rolling.fallbackReason` alone is a field a host has
    // to know to look at, and the point of this stage is that a downgrade to
    // verify-after-commit is never something a caller finds out by accident.
    if (rollingNote) {
      warnings.push(
        `This swap ran on the LEGACY zero-condition path (` +
          `${rollingNote.fallbackReason ?? 'unknown'}` +
          `), not the rolling one: the target-chain claim was verified only ` +
          `AFTER leg A committed and the two legs were not coupled. ` +
          `${rollingNote.fallbackMessage ?? ''} Legacy is being removed ` +
          `(ADR 0003) — the default \`rolling: "require"\` turns this into an ` +
          `error naming the maker.`
      );
    }
    if (missingSettlementSigner) {
      warnings.push(
        'Accepted claims are missing `swapSignerAddress` settlement ' +
          'metadata, so settling them will fail with ' +
          'MISSING_SETTLEMENT_METADATA. The swap peer is likely running ' +
          'a pre-rename SDK (<2.0.0, emits `millSignerAddress`, which ' +
          'sdk ≥2 silently drops). Upgrade the swap peer before settling.'
      );
    }
    const firstRejected = ingest.rejected[0];
    if (firstRejected) {
      warnings.push(
        `${ingest.rejected.length} received claim(s) FAILED verification and ` +
          `were NOT counted as value received (first: ${firstRejected.code} — ` +
          `${firstRejected.message}). See per-claim verificationError.`
      );
    }

    // Packets that THREW before the maker ever answered (the sdk's
    // `errors[]`: gift-wrap build failure, transport/peer-resolution throw).
    // These were previously dropped on the floor entirely — a swap that
    // failed 100% locally returned `abortReason: 'complete'` and nothing
    // else, because the sdk only rewrites that to 'all-rejected' when there
    // are rejections and NO errors.
    const errors: SwapError[] = result.errors.map((e) => ({
      packetIndex: e.packetIndex,
      message: errMsg(e.cause),
      ...(e.cause instanceof Error && e.cause.name
        ? { name: e.cause.name }
        : {}),
    }));
    const firstError = errors[0];
    if (firstError) {
      warnings.push(
        `${errors.length} packet(s) FAILED LOCALLY and never reached the ` +
          `maker (first: ${firstError.name ?? 'Error'} — ` +
          `${firstError.message}). See errors[]. A destination that is not ` +
          'routable from the selected apex fails here — name the apex that ' +
          'can reach it via `btpUrl` (toon_targets / toon_add_apex).'
      );
      for (const e of errors) {
        this.log(
          `[runner] swap: packet ${e.packetIndex} FAILED LOCALLY — ` +
            `${e.name ?? 'Error'}: ${e.message}`
        );
      }
    }

    const hadIngestibleClaims =
      ingest.revealed.length + ingest.rejected.length > 0;
    return {
      // A swap only counts as accepted when it yielded a VERIFIED+REVEALED
      // claim (or a legacy no-metadata claim, whose path is unchanged).
      // FULFILLed packets whose claims all failed verification are a failed
      // swap, loudly.
      accepted: ingest.revealed.length + ingest.legacy.length > 0,
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
      ...(errors.length > 0 ? { errors } : {}),
      ...(realizedRate !== undefined ? { realizedRate } : {}),
      ...(minExchangeRate !== undefined ? { minExchangeRate } : {}),
      // A maker REJECT is the more specific diagnosis, so it wins `code` /
      // `message`; with no reject at all, a local throw is what there is to
      // report — without this fallback the failure had no message anywhere.
      ...(firstReject
        ? { code: firstReject.code, message: firstReject.message }
        : firstError
          ? { code: 'LOCAL_SEND_FAILED', message: firstError.message }
          : {}),
      ...(warnings.length > 0 ? { warning: warnings.join('\n') } : {}),
      ...(hadIngestibleClaims
        ? {
            claimsVerified: ingest.revealed.length,
            claimsRejected: ingest.rejected.length,
            valueReceived: ingest.valueRevealed.toString(),
          }
        : {}),
      ...(rollingNote ? { rolling: rollingNote } : {}),
    };
  }

  /**
   * Drive a swap against a ROLLING-capable maker (toon-client#573, spec §3):
   * each fill packet's leg A (sender→maker) and leg B (maker→sender) share
   * ONE sender-minted execution condition `C_i = sha256(P_i)`, so the legs
   * commit or fail together. Unlike the legacy path (a single round trip
   * whose FULFILL already carries the settlement metadata), this bypasses
   * the sdk's `streamSwap` entirely: leg A is sent directly via
   * `sendSwapPacket` with a rolling-shaped `data` payload
   * (`encodeRollingFillPayload`), and leg B arrives as a SEPARATE inbound
   * PREPARE the daemon's `jobHandler` (`RollingSwapSessionRegistry`,
   * installed once in the constructor) routes to THIS call's registered
   * session by `streamNonce`.
   *
   * The atomicity property (spec R5/R8 — a withheld/failed leg-B
   * verification leaves leg A unfulfilled too) is not extra logic here: the
   * daemon only learns `P_i` (via `handleRollingAdvance`'s
   * verify-before-reveal) when it FULFILLs leg B, and the maker's connector
   * can only FULFILL leg A upstream once it has relayed that SAME `P_i` —
   * so an unrevealed leg B is, by construction, an unfulfilled leg A. The
   * per-packet `sendSwapPacket` await below simply reports whichever
   * happened.
   *
   * The session reaching here is ESTABLISHED — {@link negotiateRollingSession}
   * either got a kind:20034 quote back (toon-client#585) or the caller pinned
   * a `streamNonce` it registered itself. The maker commits the session before
   * answering, so `seq 1` can go out immediately.
   *
   * Guards armed from that session (spec §5): the hard floor is
   * `req.minExchangeRate`, else `R₀ × (1 − floorBps/10000)` derived from the
   * QUOTE's `R₀` (falling back to the advertised `pair.rate` when the session
   * was pinned without a quote). It is enforced at the verify-before-reveal
   * seam, so a below-floor fill is WITHHELD rather than merely reported —
   * leg A never fulfills and the packet costs nothing. `swapSignerAddress`
   * likewise prefers the request's pin and falls back to the quote's, arming
   * R5 before the first advance instead of trusting the first advance's echo.
   *
   * Packetization is a static even split, additionally capped by the quote's
   * per-packet `maxAmount` when the caller pinned no `packetCount`.
   *
   * **The adaptive δ/W controller is DROPPED here, not ported** (toon-client
   * #597, decided on the record — see the issue for the full writeup). Both
   * knobs solved a problem specific to the legacy honeypot protocol that
   * rolling does not have:
   * - **δ** (packet size) bounded *value at risk to one stale quote* — real
   *   when a maker's FULFILL commits before verification. Every rolling
   *   packet is priced at a FRESH `R_i` and verified BEFORE leg A reveals
   *   (spec R5/R8, above): a mispriced or stale-quoted packet is WITHHELD,
   *   not partially executed, so there is no exposure left for δ to bound.
   *   What bounds packet size in the end state is the maker's own advertised
   *   `maxAmount` (`packetsForQuote`, kind:20034) plus the hard floor.
   * - **W** (in-flight window) bounded *timing/liveness risk* across
   *   concurrently-outstanding packets. This fill loop is, and stays,
   *   strictly sequential (toon-client#596: "at most one packet is ever
   *   'in flight'") — sending packet *i+1* before packet *i* resolves would
   *   require a second concurrent registration per `streamNonce` this
   *   session registry does not support. W is therefore fixed at 1 in the
   *   end state; porting a knob that can never move off its floor value
   *   would be dead configuration surface, not a capability.
   *
   * `createSwapController` and `req.controller` remain reachable on the
   * legacy path (see {@link negotiateRollingSession}) until Stage 4 removes
   * that path entirely — this ticket only decides and records the rationale
   * Stage 4's PR cites; it deletes nothing. `req.packetCount` is unaffected
   * by the decision: it is the static split, honoured on BOTH paths (above).
   *
   * Observability parity with the legacy path (toon-client#596): `packets[]`
   * carries one entry per accepted fill (`effectiveRate`/`rateDeviation`
   * computed the same way, `rate`/`rateTimestamp` echoing the maker's
   * quote-tape from that fill's own advance, not just the session quote);
   * `errors[]` carries packets that threw before the maker ever answered —
   * distinct from `rejections[]`, a maker/leg-B answer that said no — and
   * `code: 'LOCAL_SEND_FAILED'` is reported when every failure was local;
   * `req.timeoutMs` bounds the loop (checked before each send, and handed to
   * `sendSwapPacket` as the remaining per-call budget) and is echoed as
   * `abortReason: 'aborted'` / `state: 'stopped'` with the partial fill
   * intact.
   */
  private async swapRolling(
    req: SwapRequest,
    apex: ApexConnection,
    session: RollingSessionArm
  ): Promise<SwapResponse> {
    const streamNonce = session.streamNonce;
    if (!isValidStreamNonce(streamNonce)) {
      throw new InvalidPayloadError(
        '`streamNonce` must be exactly 16 bytes, lowercase hex (32 chars).'
      );
    }
    const totalAmount = BigInt(req.amount);
    const quote = session.quote;
    const packetCount = req.packetCount ?? packetsForQuote(totalAmount, quote);
    if (!Number.isInteger(packetCount) || packetCount < 1) {
      throw new InvalidPayloadError(
        '`packetCount` must be a positive integer.'
      );
    }
    // Floor basis: the quote's R₀ when the session negotiated one (spec §5's
    // `minExchangeRate = R₀ × (1 − tolerance)`), else the advertised rate —
    // the same source the legacy path uses.
    const minExchangeRate =
      req.minExchangeRate ??
      deriveFloorRate(
        quote?.rate ?? req.pair.rate,
        req.floorBps ?? this.config.swapDefaults?.floorBps
      );
    const expectedSignerAddress =
      req.swapSignerAddress ?? quote?.swapSignerAddress;
    const expectedChain = req.pair.to.chain;
    const minaSignerClient = expectedChain.startsWith('mina')
      ? await loadMinaSignerClient()
      : undefined;
    const preimages = new InMemoryPreimageRetentionStore();
    // The SAME leg-B source as the legacy path (#583): this maker's own
    // announced `swapVerifyingContracts`, with local config as an operator
    // override. Before #583 this path read the daemon's `tokenNetworks` — leg
    // A, the contract the client PAYS the maker through — so a rolling claim
    // that was correctly signed and accepted on the wire still recovered an
    // unrelated address and was rejected `SIGNER_MISMATCH`, delivering zero
    // verified value.
    const verifyingContracts = this.swapVerifyingContractsFor(
      apex.client,
      req.swapPubkey
    );

    const live = this.rollingSessions.register(streamNonce, {
      pair: req.pair,
      expectedChain,
      chainRecipient: req.chainRecipient,
      ...(expectedSignerAddress ? { expectedSignerAddress } : {}),
      ...(verifyingContracts
        ? { swapVerifyingContracts: verifyingContracts }
        : {}),
      store: this.receivedClaimStore,
      ...(minaSignerClient ? { minaSignerClient } : {}),
      preimages,
      ...(minExchangeRate !== undefined ? { minExchangeRate } : {}),
    });

    const claims: SwapClaim[] = [];
    const rejections: SwapRejection[] = [];
    const errors: SwapError[] = [];
    let cumulativeSource = 0n;
    let cumulativeTarget = 0n;
    let firstReject: { code: string; message: string } | undefined;
    const recordRejection = (
      packetIndex: number,
      sourceAmount: bigint,
      code: string,
      message: string
    ): void => {
      rejections.push({
        packetIndex,
        sourceAmount: sourceAmount.toString(),
        code,
        message,
      });
      firstReject ??= { code, message };
    };
    // Packets that THREW before the maker ever answered — a send that never
    // reached the wire (transport/peer-resolution throw). Distinct from
    // `rejections` (the maker/leg-B DID answer, and said no): folding both
    // into `rejections` under a synthetic `T00` — the pre-#596 behaviour —
    // reported "the maker rejected this" for a failure that never left the
    // client, and gave a caller nothing to distinguish `errors[]` for.
    const recordError = (packetIndex: number, err: unknown): SwapError => {
      const name = err instanceof Error ? err.name : undefined;
      const entry: SwapError = {
        packetIndex,
        message: errMsg(err),
        ...(name ? { name } : {}),
      };
      errors.push(entry);
      return entry;
    };

    // Per-packet telemetry (#596 parity with the legacy path's `onPacket`):
    // one entry per accepted fill, capped like the legacy response.
    const packets: SwapPacketOutcome[] = [];
    let packetsTruncated = false;
    const advertisedRate = Number(req.pair.rate);
    const recordPacket = (
      packetIndex: number,
      sourceAmount: bigint,
      targetAmount: bigint,
      rate?: string,
      rateTimestamp?: number
    ): void => {
      if (packets.length >= SWAP_PACKETS_RESPONSE_LIMIT) {
        packetsTruncated = true;
        return;
      }
      const effectiveRate =
        computeRealizedRate(sourceAmount, targetAmount, req.pair) ?? 0;
      const rateDeviation =
        Number.isFinite(advertisedRate) && advertisedRate > 0
          ? Math.abs(effectiveRate - advertisedRate) / advertisedRate
          : 0;
      packets.push({
        index: packetIndex,
        sourceAmount: sourceAmount.toString(),
        targetAmount: targetAmount.toString(),
        effectiveRate,
        rateDeviation,
        ...(rate !== undefined ? { rate } : {}),
        ...(rateTimestamp !== undefined ? { rateTimestamp } : {}),
      });
    };

    // Even split, remainder folded into the last packet — mirrors the legacy
    // static-split default. This is the END-STATE sizing on this path: the
    // adaptive δ/W controller is dropped, not pending (toon-client#597 — see
    // this method's doc comment).
    const evenSplitAmount = totalAmount / BigInt(packetCount);
    const lastPacketAmount =
      totalAmount - evenSplitAmount * BigInt(packetCount - 1);

    // `req.timeoutMs` bounds the WHOLE fill loop (#596 parity with the
    // legacy path's `AbortSignal.timeout`), not just one packet: checked
    // before every send, so a deadline that has already passed stops the
    // next packet from going out at all, and passed as the remaining budget
    // to `sendSwapPacket`'s own per-call `timeout` so a packet already
    // in flight is bounded too. Sequential sends mean at most one packet is
    // ever "in flight" — there is nothing else here to drain.
    const deadline =
      req.timeoutMs !== undefined ? Date.now() + req.timeoutMs : undefined;
    let timedOut = false;

    try {
      for (let seq = 1; seq <= packetCount; seq++) {
        if (deadline !== undefined && Date.now() >= deadline) {
          timedOut = true;
          break;
        }
        const packetIndex = seq - 1;
        const sourceAmount =
          seq === packetCount ? lastPacketAmount : evenSplitAmount;

        const { preimage, condition } = mintExecutionCondition();
        preimages.retain({
          packetIndex,
          preimage,
          condition,
          retainedAt: Date.now(),
        });
        const toonData = encodeRollingFillPayload({ streamNonce, seq });

        let result: { accepted: boolean; code?: string; message?: string };
        try {
          result = await apex.client.sendSwapPacket({
            destination: req.destination,
            amount: sourceAmount,
            toonData,
            executionCondition: condition,
            ...(req.packetExpiryMs !== undefined
              ? { expiresAt: new Date(Date.now() + req.packetExpiryMs) }
              : {}),
            ...(deadline !== undefined
              ? { timeout: Math.max(1, deadline - Date.now()) }
              : {}),
          });
        } catch (err) {
          const failure = recordError(packetIndex, err);
          this.log(
            `[runner] swap: rolling packet seq ${seq} FAILED LOCALLY — ` +
              `${failure.name ?? 'Error'}: ${failure.message}`
          );
          continue;
        }

        if (!result.accepted) {
          // A leg-B verification failure is the INTERESTING rejection (spec
          // R5/R8) and is the more precise diagnosis, so it wins over the
          // leg-A reject the maker sent back once it unwound.
          const rejection = live.rejections.get(seq);
          const code = rejection?.code ?? result.code ?? 'F99';
          const message =
            rejection?.message ?? result.message ?? 'rolling fill rejected';
          recordRejection(packetIndex, sourceAmount, code, message);
          this.log(
            `[runner] swap: rolling packet seq ${seq} REJECTED — ${code}: ${message}`
          );
          continue;
        }

        const outcome = live.outcomes.get(seq);
        if (!outcome) {
          // Unreachable in practice (a FULFILLed leg A implies our own
          // reveal ran), but fail loud rather than silently under-counting.
          recordRejection(
            packetIndex,
            sourceAmount,
            'F99',
            'leg-A fulfilled with no recorded leg-B outcome'
          );
          continue;
        }

        cumulativeSource += sourceAmount;
        cumulativeTarget += outcome.claim.targetAmount;
        claims.push({
          sourceAmount: sourceAmount.toString(),
          targetAmount: outcome.claim.targetAmount.toString(),
          claim: Buffer.from(outcome.claim.claimBytes).toString('base64'),
          ...(outcome.claim.channelId
            ? { channelId: outcome.claim.channelId }
            : {}),
          ...(outcome.advance.recipient
            ? { recipient: outcome.advance.recipient }
            : {}),
          ...(outcome.claim.swapSignerAddress
            ? { swapSignerAddress: outcome.claim.swapSignerAddress }
            : {}),
          ...(outcome.advance.claimId
            ? { claimId: outcome.advance.claimId }
            : {}),
          ...(outcome.claim.nonce ? { nonce: outcome.claim.nonce } : {}),
          ...(outcome.claim.cumulativeAmount
            ? { cumulativeAmount: outcome.claim.cumulativeAmount }
            : {}),
          verified: true,
        });
        recordPacket(
          packetIndex,
          sourceAmount,
          outcome.claim.targetAmount,
          outcome.claim.rate,
          outcome.claim.rateTimestamp
        );
        this.log(
          `[runner] swap: rolling packet seq ${seq}: ${sourceAmount} → ` +
            `${outcome.claim.targetAmount} (verified)`
        );
      }
    } finally {
      this.rollingSessions.unregister(streamNonce);
      preimages.clear();
    }

    const realizedRate = computeRealizedRate(
      cumulativeSource,
      cumulativeTarget,
      req.pair
    );
    const warnings: string[] = [];
    if (rejections.length > 0) {
      warnings.push(
        `${rejections.length} packet(s) failed on the rolling path (first: ` +
          `${firstReject?.code} — ${firstReject?.message}). Per spec R5/R8 a ` +
          'withheld/failed leg-B verification never reveals leg A — no ' +
          'collectable claim advance for that packet.'
      );
    }
    if (rejections.length > 0 && claims.length === 0) {
      // NOT a silent retry. `rolling: "auto"` falls back when the RFQ FAILS,
      // and this branch is the other shape: the RFQ succeeded, a session was
      // established, and then every fill failed. Re-running the same swap on
      // the legacy path from here is what would risk paying or delivering
      // twice, so the caller decides — but a caller that is told only
      // `leg B failed; fill not executed` has no way to know the legacy path
      // is right there and working. Say so.
      warnings.push(
        'EVERY packet failed on the rolling path, so this swap delivered ' +
          'nothing. It also cost nothing: no leg A was revealed and no claim ' +
          'is collectable (spec R5/R8). This is NOT retried as legacy ' +
          'automatically — re-running a fill after a rolling attempt is what ' +
          'risks double-paying. To settle this swap on the legacy path, ' +
          'repeat it with `rolling: "off"`.'
      );
    }
    const firstError = errors[0];
    if (firstError) {
      warnings.push(
        `${errors.length} packet(s) FAILED LOCALLY and never reached the ` +
          `maker (first: ${firstError.name ?? 'Error'} — ` +
          `${firstError.message}). See errors[].`
      );
    }
    if (timedOut) {
      // Every attempted packet ends as exactly one of claim/rejection/error,
      // so the rest are the ones the deadline stopped from going out.
      const neverAttempted =
        packetCount - claims.length - rejections.length - errors.length;
      warnings.push(
        `\`timeoutMs\` (${String(req.timeoutMs)}) elapsed with ` +
          `${String(neverAttempted)} packet(s) never attempted. Partial fill ` +
          'reported exactly — see `claims` / `cumulativeSource` / ' +
          '`cumulativeTarget`.'
      );
    }
    const hadIngestibleClaims = claims.length + rejections.length > 0;
    // Mirrors the sdk's own `finalizeResult` rewrite rule (see
    // `SwapError`'s doc comment): `abortReason` stays `'complete'` unless
    // there were rejections and NO local errors (`'all-rejected'`), or the
    // loop was cut short by `timeoutMs` (`'aborted'`, which wins outright).
    // A local-only failure therefore keeps the same diagnostic signature as
    // the legacy path: `state: 'failed'` + `abortReason: 'complete'` +
    // `packetsAccepted: 0` — read `errors[]` for why.
    let abortReason = 'complete';
    let state: 'completed' | 'failed' | 'stopped' = 'completed';
    if (timedOut) {
      abortReason = 'aborted';
      state = 'stopped';
    } else if (rejections.length > 0 || errors.length > 0) {
      if (rejections.length > 0 && errors.length === 0) {
        abortReason = 'all-rejected';
      }
      state = 'failed';
    }

    return {
      accepted: claims.length > 0,
      packetsAccepted: claims.length,
      claims,
      cumulativeSource: cumulativeSource.toString(),
      cumulativeTarget: cumulativeTarget.toString(),
      state,
      abortReason,
      ...(packets.length > 0 ? { packets } : {}),
      ...(packetsTruncated ? { packetsTruncated } : {}),
      ...(rejections.length > 0 ? { rejections } : {}),
      ...(errors.length > 0 ? { errors } : {}),
      ...(realizedRate !== undefined ? { realizedRate } : {}),
      ...(minExchangeRate !== undefined ? { minExchangeRate } : {}),
      // A maker REJECT is the more specific diagnosis, so it wins `code` /
      // `message`; with no reject at all, a local throw is what there is to
      // report (mirrors the legacy path's `LOCAL_SEND_FAILED`).
      ...(firstReject
        ? { code: firstReject.code, message: firstReject.message }
        : firstError
          ? { code: 'LOCAL_SEND_FAILED', message: firstError.message }
          : {}),
      ...(warnings.length > 0 ? { warning: warnings.join('\n') } : {}),
      ...(hadIngestibleClaims
        ? {
            claimsVerified: claims.length,
            claimsRejected: rejections.length,
            valueReceived: cumulativeTarget.toString(),
          }
        : {}),
      rolling: {
        probed: session.probed,
        used: true,
        streamNonce,
        ...(quote
          ? {
              rate: quote.rate,
              rateTimestamp: quote.rateTimestamp,
              expiresAt: quote.expiresAt,
              ...(quote.maxRateAge !== undefined
                ? { maxRateAge: quote.maxRateAge }
                : {}),
              ...(quote.spreadBps !== undefined
                ? { spreadBps: quote.spreadBps }
                : {}),
            }
          : {}),
      },
    };
  }

  /**
   * Capability discovery for the rolling protocol — a PROBE, not an announce
   * read (spec §10.3 step 2: *"A maker without it is legacy; `toon_swap`
   * keeps the legacy path until the RFQ succeeds"*). swap#135 deliberately
   * ships no `rollingCapable` flag, precisely so there is one source of truth
   * and it is the round trip itself.
   *
   * One paid, zero-condition kind:20033 write goes out; a kind:20034 quote
   * means the maker registered the session and the rolling path is live.
   *
   * **Any other outcome is now an ERROR, not a downgrade (toon-client#595).**
   * ADR 0003 decides that the rolling swap is the only swap, so a maker that
   * stops answering RFQs is a fault to be reported — not a reason to serve
   * every caller the strictly less safe protocol (verify-after-commit against
   * an unbounded held price, uncoupled legs) without telling them. The
   * fallback existed to cope with makers that predate rolling; the deployed
   * maker is rolling-capable, and a silent downgrade is exactly how a maker
   * regression would go unnoticed fleet-wide.
   *
   * `req.rolling` (or `swapDefaults.rolling`) selects:
   * - `'require'` — **the default**. Probe, and throw
   *   {@link RollingUnavailableError} naming the maker pubkey, its ILP
   *   address, the reason discriminator and the underlying diagnosis.
   * - `'auto'` — probe, fall back to legacy on any failure, annotating
   *   `SwapResponse.rolling` and adding a downgrade `warning`. A transitional
   *   escape hatch: it survives exactly one release and is removed with the
   *   legacy sender (Stage 4, toon-client#598).
   * - `'off'` — never probe; no RFQ packet is paid for at all. Also annotated
   *   and warned (`fallbackReason: 'off'`): under #592 this is the documented
   *   move when a rolling fill cannot be DELIVERED (swap#148), so it must
   *   remain reachable — but it is never silent.
   *
   * `req.streamNonce` skips the probe and uses that session id directly — the
   * pre-#585 out-of-band registration path (toon-client#573), kept because a
   * maker operator can still register one in-process.
   */
  private async negotiateRollingSession(
    req: SwapRequest,
    apex: ApexConnection
  ): Promise<RollingNegotiation> {
    const mode = req.rolling ?? this.config.swapDefaults?.rolling ?? 'require';
    const required = mode === 'require';

    /** Fall back to legacy — or, by default (`require`), refuse loudly. */
    const legacy = (
      probed: boolean,
      reason: string,
      message: string
    ): RollingNegotiation => {
      if (required) {
        throw new RollingUnavailableError({
          reason,
          detail: message,
          swapPubkey: req.swapPubkey,
          destination: req.destination,
          probed,
        });
      }
      this.log(
        `[runner] swap: rolling unavailable (${reason}) — legacy path: ${message}`
      );
      return {
        kind: 'legacy',
        note: {
          probed,
          used: false,
          fallbackReason: reason,
          fallbackMessage: message,
        },
      };
    };

    if (mode === 'off') {
      if (req.streamNonce !== undefined || req.senderConditions) {
        throw new InvalidPayloadError(
          '`rolling: "off"` cannot be combined with `streamNonce` / ' +
            '`senderConditions` — those select the rolling path, which "off" ' +
            'disables. Drop one of them.'
        );
      }
      // #595: 'off' still works — it is the escape hatch #592's own warning
      // points at — but it stops being INVISIBLE. Before this, a swap that ran
      // legacy because the daemon default said so carried no `rolling` block
      // at all, so nothing downstream could tell it apart from a rolling one.
      this.log(
        '[runner] swap: rolling DISABLED by `rolling: "off"` — no RFQ probe ' +
          'sent; this swap runs the legacy zero-condition path'
      );
      return {
        kind: 'legacy',
        note: {
          probed: false,
          used: false,
          fallbackReason: 'off',
          fallbackMessage:
            '`rolling: "off"` was set (on the request or as ' +
            '`swapDefaults.rolling`), so no kind:20033 RFQ was sent and this ' +
            'swap ran the LEGACY zero-condition path: the target-chain claim ' +
            'is verified only AFTER leg A has committed, and the legs are not ' +
            'coupled. The legacy path is being removed (ADR 0003).',
        },
      };
    }

    // Caller-pinned session: registered out of band (toon-client#573). No
    // probe — the nonce IS the establishment, and re-RFQing it would mint a
    // second session the maker never asked for.
    if (req.streamNonce !== undefined) {
      if (!isValidStreamNonce(req.streamNonce)) {
        throw new InvalidPayloadError(
          '`streamNonce` must be exactly 16 bytes, lowercase hex (32 chars).'
        );
      }
      if (req.controller) {
        // Contradictory: a pinned session names the ROLLING path, and the
        // adaptive controller exists only on the legacy one. Silently
        // dropping either would be worse than refusing.
        throw new InvalidPayloadError(
          '`streamNonce` (the rolling path) and `controller` (a legacy-path ' +
            'feature, not implemented on the rolling fill loop) are mutually ' +
            'exclusive. Drop `controller`, or drop `streamNonce` to let the ' +
            'RFQ probe choose the path.'
        );
      }
      return { kind: 'rolling', streamNonce: req.streamNonce, probed: false };
    }

    // The adaptive δ/W controller is DROPPED on rolling, not merely
    // unported (toon-client#597, decided on the record: rolling's
    // per-packet re-quote + verify-before-reveal already bounds pick-off
    // risk, and the sequential fill loop pins W at 1 — see swapRolling's
    // doc comment for the full reasoning). Asking for one is an explicit
    // request for the legacy path, where it still lives until Stage 4;
    // probing anyway would pay for a rolling session we then would not use.
    if (req.controller) {
      return legacy(
        false,
        'controller',
        'the adaptive δ/W controller (`controller`) is a legacy-path feature, ' +
          'DROPPED (not ported) on the rolling fill loop — toon-client#597'
      );
    }

    // The leg-B destination. Load-bearing with NO maker-side fallback: the
    // maker addresses every leg-B PREPARE of the session to this string
    // verbatim, and the connector resolves a client session by EXACT match on
    // the id it greeted with. Without one, an RFQ would establish a session
    // whose leg B can never arrive — worse than not having one.
    const senderIlpAddress =
      req.senderIlpAddress ?? safe(() => apex.client.getOwnIlpAddress?.());
    if (senderIlpAddress === undefined || senderIlpAddress.length === 0) {
      return legacy(
        false,
        'no-sender-address',
        'this client cannot state the ILP address it receives leg-B PREPAREs ' +
          'on — pass `senderIlpAddress` explicitly'
      );
    }

    const outcome = await sendRollingRfq({
      client: apex.client,
      destination: req.destination,
      swapPubkey: req.swapPubkey,
      pair: req.pair,
      chainRecipient: req.chainRecipient,
      senderIlpAddress,
      amount: await this.rfqProbeAmount(req, apex),
      ...(sizeHintOf(req.amount) !== undefined
        ? { sizeHint: sizeHintOf(req.amount) }
        : {}),
      ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}),
    });
    if (!outcome.ok) {
      return legacy(outcome.sent, outcome.reason, outcome.message);
    }

    this.log(
      `[runner] swap: rolling session ${outcome.streamNonce} established — ` +
        `R₀ ${outcome.quote.rate} (leg B to ${senderIlpAddress})`
    );
    return {
      kind: 'rolling',
      streamNonce: outcome.streamNonce,
      quote: outcome.quote,
      probed: true,
    };
  }

  /**
   * What the RFQ probe packet itself pays. The probe buys a quote, not value,
   * so the right figure is the terminating connector's flat packet price
   * (`GET /ilp/routes/price`, ADR 0020) — not the swap notional. Falls back
   * to one micro-unit when the price is unknown (a direct-dialled maker often
   * serves no price route), and `req.rfqAmount` pins it outright.
   */
  private async rfqProbeAmount(
    req: SwapRequest,
    apex: ApexConnection
  ): Promise<bigint> {
    if (req.rfqAmount !== undefined) {
      const pinned = sizeHintOf(req.rfqAmount);
      if (pinned !== undefined && pinned > 0n) return pinned;
      throw new InvalidPayloadError(
        '`rfqAmount` must be a positive integer decimal string.'
      );
    }
    let price: bigint | null = null;
    try {
      price = await apex.client.getRoutePrice(req.destination);
    } catch {
      price = null;
    }
    return price !== null && price > 0n ? price : 1n;
  }

  // ── Received swap claims: persistence + settlement surfaces (#352) ─────────

  /** List the persisted received-claim watermarks (`GET /swap/claims`). */
  listSwapClaims(): ListSwapClaimsResponse {
    return {
      claims: this.receivedClaimStore.list().map(toReceivedClaimInfo),
    };
  }

  /**
   * Build (and, where chain plumbing is configured, submit) on-chain
   * settlements for persisted received claims (`POST /swap/settle`).
   *
   * Per (chain, channelId) the persisted entry IS the highest-nonce
   * watermark, so N received advances redeem as ONE close. Result-shaped
   * throughout: a channel that cannot build or submit reports `error` instead
   * of failing the batch. Submission is the env-gated seam — it requires the
   * identity client's EVM plumbing plus `chainRpcUrls[chain]`; without them
   * the built (re-verified) tx is returned as `unsignedTx` for an external
   * signer. Solana submission and the Mina receive-side co-sign path are
   * explicit follow-ups (spec §9 dependency 2).
   */
  async settleSwapClaims(
    req: SettleSwapClaimsRequest = {}
  ): Promise<SettleSwapClaimsResponse> {
    const submit = req.submit !== false;
    const entries = this.receivedClaimStore
      .list()
      .filter((e) => (req.chain ? e.chain === req.chain : true))
      .filter((e) => (req.channelId ? e.channelId === req.channelId : true));

    const results: SwapSettlementResult[] = [];
    const pending: ReceivedClaimEntry[] = [];
    for (const entry of entries) {
      if (
        entry.settledNonce !== undefined &&
        entry.settledNonce >= entry.nonce
      ) {
        results.push({
          chain: entry.chain,
          channelId: entry.channelId,
          built: false,
          submitted: false,
          error: {
            code: 'ALREADY_SETTLED',
            message: `watermark nonce ${entry.nonce} was already settled (tx ${entry.settleTxHash ?? 'unknown'})`,
          },
        });
        continue;
      }
      pending.push(entry);
    }

    const minaSignerClient = pending.some((e) => e.chain.startsWith('mina'))
      ? await loadMinaSignerClient()
      : undefined;
    const builds = buildSwapSettlements({
      entries: pending,
      // Solana `programId` only — EVM settles on the leg-B contract below.
      ...(this.config.toonClientConfig.tokenNetworks
        ? { tokenNetworks: this.config.toonClientConfig.tokenNetworks }
        : {}),
      // EVM fallback for watermarks persisted before #572 pinned a contract.
      // Entries written since carry their own `verifyingContract` and settle
      // against THAT; this map is never the leg-A `tokenNetworks` (#583).
      ...(this.config.toonClientConfig.swapVerifyingContracts
        ? {
            swapVerifyingContracts:
              this.config.toonClientConfig.swapVerifyingContracts,
          }
        : {}),
      // Re-verify the stored watermark's signature at settle time
      // (defense-in-depth over the store file). The published v2 sdk
      // (`@toon-protocol/sdk@^3`) verifies EVM claims against the SAME v2
      // EIP-712 domain-separated digest the receive-side used (#365), so a
      // valid v2 signature verifies correctly here — `buildSwapSettlements`
      // threads `chainId` + `verifyingContract` (the entry's pinned one, else
      // `swapVerifyingContracts`) into the sdk signer config so the EIP-712
      // domain is reconstructed.
      verifySignatures: true,
      ...(minaSignerClient ? { minaSignerClient } : {}),
    });

    for (const [i, build] of builds.entries()) {
      const entry = pending[i];
      if (!entry) continue; // builds is index-aligned with pending
      if (!build.bundle) {
        results.push({
          chain: build.chain,
          channelId: build.channelId,
          built: false,
          submitted: false,
          ...(build.error ? { error: build.error } : {}),
        });
        continue;
      }
      const bundle = build.bundle;
      const base: SwapSettlementResult = {
        chain: build.chain,
        channelId: build.channelId,
        built: true,
        submitted: false,
        nonce: bundle.nonce,
        cumulativeAmount: bundle.cumulativeAmount,
        unsignedTx: Buffer.from(bundle.unsignedTxBytes).toString('base64'),
      };
      if (!submit) {
        results.push(base);
        continue;
      }
      if (bundle.chainKind === 'solana') {
        results.push({
          ...base,
          error: {
            code: 'SUBMISSION_UNSUPPORTED',
            message:
              'Solana settlement submission is not wired yet (bundle carries a serialized Message; follow-up under toon-meta#145).',
          },
        });
        continue;
      }
      if (bundle.chainKind === 'mina') {
        // Mina receive-side redemption (#357): the client produces the
        // recipient's co-signature and drives the dual-party `claimFromChannel`
        // (o1js proving) via `settleSwapBundle`. Fails closed with a stable
        // MinaSettlementError code (e.g. NO_GRAPHQL_CONFIGURED,
        // MINA_MAKER_COSIGN_REQUIRED) surfaced as SUBMISSION_FAILED.
        if (!this.identityClient.settleSwapBundle) {
          results.push({
            ...base,
            error: {
              code: 'SUBMISSION_UNAVAILABLE',
              message: 'The active client does not implement settleSwapBundle.',
            },
          });
          continue;
        }
        try {
          const submitted = await this.identityClient.settleSwapBundle(bundle);
          const latest =
            this.receivedClaimStore.load(entry.chain, entry.channelId) ?? entry;
          this.receivedClaimStore.save({
            ...latest,
            settledAt: Date.now(),
            settledNonce: BigInt(bundle.nonce),
            settleTxHash: submitted.txHash,
          });
          this.log(
            `[runner] swap settle: submitted ${bundle.chain}/${bundle.channelId} ` +
              `nonce ${bundle.nonce} cumulative ${bundle.cumulativeAmount} → ${submitted.txHash}`
          );
          results.push({
            ...base,
            submitted: true,
            txHash: submitted.txHash,
            ...(submitted.status ? { txStatus: submitted.status } : {}),
          });
        } catch (err) {
          results.push({
            ...base,
            error: {
              code: 'SUBMISSION_FAILED',
              message: err instanceof Error ? err.message : String(err),
            },
          });
        }
        continue;
      }
      const rpcUrl = this.config.toonClientConfig.chainRpcUrls?.[bundle.chain];
      if (!rpcUrl) {
        results.push({
          ...base,
          error: {
            code: 'NO_RPC_CONFIGURED',
            message: `No RPC URL configured for "${bundle.chain}" (chainRpcUrls) — returning the built tx unsubmitted.`,
          },
        });
        continue;
      }
      if (!this.identityClient.settleSwapBundle) {
        results.push({
          ...base,
          error: {
            code: 'SUBMISSION_UNAVAILABLE',
            message: 'The active client does not implement settleSwapBundle.',
          },
        });
        continue;
      }
      try {
        const submitted = await this.identityClient.settleSwapBundle(bundle);
        // Mark the watermark settled so a re-run skips it.
        const latest =
          this.receivedClaimStore.load(entry.chain, entry.channelId) ?? entry;
        this.receivedClaimStore.save({
          ...latest,
          settledAt: Date.now(),
          settledNonce: BigInt(bundle.nonce),
          settleTxHash: submitted.txHash,
        });
        this.log(
          `[runner] swap settle: submitted ${bundle.chain}/${bundle.channelId} ` +
            `nonce ${bundle.nonce} cumulative ${bundle.cumulativeAmount} → ${submitted.txHash}`
        );
        results.push({
          ...base,
          submitted: true,
          txHash: submitted.txHash,
          ...(submitted.status ? { txStatus: submitted.status } : {}),
        });
      } catch (err) {
        results.push({
          ...base,
          error: {
            code: 'SUBMISSION_FAILED',
            message: err instanceof Error ? err.message : String(err),
          },
        });
      }
    }
    return { results };
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
   * What one store write costs: the store destination's flat route price, as
   * the terminating connector reports it.
   *
   * This used to be `bytes × 10n`, a constant kept in step with three other
   * copies by comment. ADR 0020 removed byte-proportional pricing from the
   * protocol — one handler, one price — so there is nothing left to compute
   * and nothing local that could disagree with what the connector charges.
   * The bid tag, the signed claim and the ILP amount all still use this one
   * figure, so a pre-push estimate remains exactly what a push pays.
   *
   * @throws {PublishRejectedError} when the connector terminates no store
   *   route — a distinguishable refusal rather than a zero-priced packet that
   *   would be rejected downstream for a reason nobody could read.
   */
  private async storeUploadFee(apex: ApexConnection): Promise<bigint> {
    const price = await apex.client.getRoutePrice(this.config.storeDestination);
    if (price === null) {
      throw new PublishRejectedError(
        `The connector terminates no store route for "${this.config.storeDestination}", ` +
          'so it cannot say what an upload costs. Check `storeDestination`.'
      );
    }
    return price;
  }

  /**
   * The daemon `Publisher` implementation (see @toon-protocol/rig) for one
   * push. `apex` handles the RELAY leg (publishEvent — kind:30617/30618);
   * `storeApex` handles the STORE leg (uploadGitObject + its route price) —
   * two DIFFERENT connectors since core@3.3.0's two-node genesis seed (issue
   * #536 correction). The two coincide (same `ApexConnection`) whenever no
   * `storeBtpUrl` is configured, so this is a no-op split for that topology.
   *
   * Maps the interface onto the runner's production paid-write machinery:
   *
   *  - `getFeeRates`: flat `apex.feePerEvent` per publish + the store route's
   *    flat price as `storeApex`'s connector reports it.
   *  - `uploadGitObject`: kind:5094 store write with Git-SHA/Git-Type/Repo
   *    tags (the proven seed-pipeline shape), signed with the daemon key,
   *    paid via signBalanceProof on the STORE apex channel, routed to the
   *    store destination (`POST /store`); the Arweave txId is decoded from
   *    the FULFILL HTTP envelope.
   *  - `publishEvent`: sign with the daemon key + the standard paid publish
   *    path (signBalanceProof → publishEvent → feePaid) on the relay apex.
   *    The daemon owns its write routing (config-seeded relay via the apex),
   *    so the advisory `relayUrls` list is not consulted here — remote-state
   *    reads DO use it.
   */
  private gitPublisher(
    apex: ApexConnection,
    storeApex: ApexConnection
  ): Publisher {
    return {
      getFeeRates: async () => ({
        uploadFee: await this.storeUploadFee(storeApex),
        eventFee: apex.feePerEvent,
      }),
      uploadGitObject: (upload) => this.gitUploadObject(storeApex, upload),
      publishEvent: (event) => this.gitPublishEvent(apex, event),
    };
  }

  /** Upload one git object body as a paid kind:5094 store write. */
  private async gitUploadObject(
    apex: ApexConnection,
    upload: GitObjectUpload
  ): Promise<UploadReceipt> {
    const channelId = await this.ensureApexChannel(apex);
    const fee = await this.storeUploadFee(apex);
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
    if (!result.response) {
      throw new PublishRejectedError(
        `git object ${upload.sha} upload FULFILL carried no sealed response — expected the Arweave tx ID`
      );
    }
    let txId: string;
    try {
      txId = extractArweaveTxId(result.response);
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
    storeApex: ApexConnection,
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
    const publisher = this.gitPublisher(apex, storeApex);
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
    const storeApex = this.selectStoreApex();
    this.assertApexReady(apex);
    this.assertApexReady(storeApex);
    const { plan } = await this.planGitPush(apex, storeApex, req);
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
    const storeApex = this.selectStoreApex();
    this.assertApexReady(apex);
    this.assertApexReady(storeApex);
    const { plan, remoteState, repoReader, relayUrls, publisher } =
      await this.planGitPush(apex, storeApex, req);
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
  private async gitPublishSigned(
    event: UnsignedEvent
  ): Promise<GitEventResponse> {
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

  /**
   * Adapt the daemon's line-oriented `log` to the pino-shaped logger the sdk
   * expects (`{ debug, info, warn, error }`, each called with ONE structured
   * event object). The daemon has no pino, so each event is flattened to a
   * single readable line — the alternative (the sdk's default) is a no-op
   * logger that drops `stream_swap.wrap_failed` / `send_failed` on the floor.
   */
  private structuredLogger(scope: string): {
    debug: (...a: unknown[]) => void;
    info: (...a: unknown[]) => void;
    warn: (...a: unknown[]) => void;
    error: (...a: unknown[]) => void;
  } {
    const emit =
      (level: string) =>
      (...args: unknown[]): void => {
        try {
          const parts = args.map((a) =>
            typeof a === 'string' ? a : formatStructuredEvent(a)
          );
          this.log(`[runner] ${scope} ${level}: ${parts.join(' ')}`);
        } catch {
          // Logging must never be able to break the operation it describes.
        }
      };
    return {
      debug: emit('debug'),
      info: emit('info'),
      warn: emit('warn'),
      error: emit('error'),
    };
  }

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

  /**
   * Select the apex a SWAP streams on.
   *
   * An explicit `btpUrl` still wins and is still the only selector on the
   * wire (#579) — this only decides where an otherwise-defaulted swap goes.
   * With none, the swap goes to the REGISTERED apex that owns `destination`
   * (its own ILP address, or the longest ILP prefix of it), not to the
   * config-seeded default.
   *
   * Why this is load-bearing rather than a convenience: every apex has its
   * OWN `ToonClient`, and the negotiation for a `toon_add_apex` target is
   * injected into THAT client alone, under the peer id `resolvePeerId`
   * returns for its destination ({@link injectApexNegotiation} — the last
   * dot-segment, e.g. `g.toon.swap.maker` → `maker`). Streaming the swap on
   * any other apex's client hands `ToonClient.sendSwapPacket` a destination
   * that client has never negotiated: `resolvePeerId` throws PEER_NOT_FOUND,
   * `peerIdForClaim` falls back to the raw destination as the key, nothing
   * is registered under a full ILP address, and every packet dies locally
   * with `No negotiation metadata for peer "g.toon.swap.maker"`. Routing to
   * the owning apex makes the destination and its registered peer id agree,
   * so the lookup hits on identity and never rides that fallback.
   */
  private selectSwapApex(destination: string, btpUrl?: string): ApexConnection {
    if (btpUrl) return this.selectApex(btpUrl);
    return this.apexOwning(destination) ?? this.selectApex();
  }

  /**
   * The registered apex whose own ILP destination owns `destination` — an
   * exact match, else the longest registered prefix (`g.toon.swap.maker` is
   * owned by the maker apex over the `g.toon` default). `undefined` when no
   * registered apex claims it at all.
   */
  private apexOwning(destination: string): ApexConnection | undefined {
    let best: ApexConnection | undefined;
    for (const apex of this.apexes.values()) {
      const owned = apex.destination;
      if (!owned) continue;
      if (destination !== owned && !destination.startsWith(`${owned}.`))
        continue;
      if (!best || owned.length > best.destination.length) best = apex;
    }
    return best;
  }

  /**
   * Select the apex for STORE-bound writes (blob uploads, git objects, the
   * store route price). An explicit `btpUrl` always wins (back-compat with
   * the manual `toon_add_apex` single-target flow — both legs of a write use
   * the SAME apex it names). With none, prefer the auto-registered store
   * apex (issue #536 correction); fall back to the default apex when no
   * `storeBtpUrl` is configured — the single-connector topology where store
   * writes have always shared the default apex's uplink.
   */
  private selectStoreApex(btpUrl?: string): ApexConnection {
    if (btpUrl) return this.selectApex(btpUrl);
    return this.defaultStoreApex() ?? this.selectApex();
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
 * Thrown when a swap could not run on the ROLLING path and the caller did not
 * ask for the legacy downgrade (toon-client#595, ADR 0003 — "the rolling swap
 * is the only swap"). This is a COUNTERPARTY fault, not a bad request: the
 * request is well-formed and the maker did not establish a session, so it maps
 * to 502 alongside `PublishRejectedError` rather than to 400.
 *
 * The message is the diagnosis a stranded caller needs — which maker, at which
 * ILP address, which reason discriminator, and what to do — and the same facts
 * are carried as fields so a host can branch on them without parsing prose.
 */
export class RollingUnavailableError extends Error {
  /** The discriminator: `rejected`, `no-response`, `not-a-quote`, `nonce-mismatch`, `send-failed`, `controller`, `no-sender-address`. */
  readonly reason: string;
  /** The underlying diagnosis (maker reject code, decode failure, …). */
  readonly detail: string;
  /** The maker's kind:10032 pubkey — which counterparty to fix. */
  readonly swapPubkey: string;
  /** The maker's ILP address the probe was sent to. */
  readonly destination: string;
  /** Whether an RFQ packet actually left this client (and was paid for). */
  readonly probed: boolean;
  constructor(params: {
    reason: string;
    detail: string;
    swapPubkey: string;
    destination: string;
    probed: boolean;
  }) {
    super(
      `Rolling swap unavailable: maker ${params.swapPubkey} at ` +
        `${params.destination} did not establish a rolling session ` +
        `(reason: ${params.reason}) — ${params.detail}. TOON supports the ` +
        'rolling swap protocol only (ADR 0003): the legacy zero-condition ' +
        'path verifies the target-chain claim only AFTER leg A has ' +
        'committed, so it is not taken silently. Fix the maker — it needs ' +
        'kind:20033 RFQ intake and a `swapVerifyingContracts` announce — or, ' +
        'to settle this one swap on the legacy path anyway, repeat it with ' +
        '`rolling: "auto"` (probe, then downgrade) or `rolling: "off"` (no ' +
        'probe at all). Both are removed when the legacy sender goes.'
    );
    this.name = 'RollingUnavailableError';
    this.reason = params.reason;
    this.detail = params.detail;
    this.swapPubkey = params.swapPubkey;
    this.destination = params.destination;
    this.probed = params.probed;
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
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string
): Promise<T> {
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
  if (filter.since !== undefined && event.created_at < filter.since)
    return false;
  if (filter.until !== undefined && event.created_at > filter.until)
    return false;
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
  if (!Array.isArray(raw))
    throw new InvalidPayloadError('tags must be an array.');
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

/**
 * Whether a persisted apex negotiation still says what the live announce says
 * (toon-client#581). Only the SETTLEMENT-BEARING fields are compared — these
 * are exactly the values a payment channel is opened and claimed against, and
 * the ones whose drift produced the retired-apex `F01`. Cosmetic differences
 * (a re-derived `peerId`, a relabelled `chainKey`) are not drift worth
 * rewriting the store for.
 *
 * Settlement addresses are compared case-insensitively: an EVM address is the
 * same address whether or not it is EIP-55 checksummed, and treating a
 * re-cased announce as drift would rewrite the store on every start.
 */
function negotiationsAgree(
  persisted: ApexNegotiationConfig,
  fresh: ApexNegotiationConfig
): boolean {
  return (
    persisted.settlementAddress.toLowerCase() ===
      fresh.settlementAddress.toLowerCase() &&
    persisted.chain === fresh.chain &&
    persisted.chainId === fresh.chainId &&
    (persisted.tokenNetwork ?? '') === (fresh.tokenNetwork ?? '') &&
    (persisted.tokenAddress ?? '') === (fresh.tokenAddress ?? '') &&
    persisted.destination === fresh.destination
  );
}

/**
 * Flatten one structured log event (the sdk calls its logger with a single
 * object, pino-style) into a `k=v` line the daemon's line logger can carry.
 * Falls back to `String(value)` for anything unserializable — a logger that
 * throws would take the operation down with it.
 */
function formatStructuredEvent(value: unknown): string {
  if (value === null || typeof value !== 'object') return String(value);
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return '{}';
  return entries
    .map(([k, v]) => {
      if (v === null || v === undefined) return `${k}=${String(v)}`;
      if (typeof v === 'object') {
        const json = safe(() => JSON.stringify(v));
        return `${k}=${json ?? String(v)}`;
      }
      return `${k}=${String(v)}`;
    })
    .join(' ');
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

/** Map a persisted received-claim entry onto the wire shape (#352). */
function toReceivedClaimInfo(e: ReceivedClaimEntry): ReceivedClaimInfo {
  return {
    chain: e.chain,
    channelId: e.channelId,
    nonce: e.nonce.toString(),
    cumulativeAmount: e.cumulativeAmount.toString(),
    recipient: e.recipient,
    swapSignerAddress: e.swapSignerAddress,
    receivedAt: e.receivedAt,
    updatedAt: e.updatedAt,
    ...(e.settledAt !== undefined ? { settledAt: e.settledAt } : {}),
    ...(e.settledNonce !== undefined
      ? { settledNonce: e.settledNonce.toString() }
      : {}),
    ...(e.settleTxHash !== undefined ? { settleTxHash: e.settleTxHash } : {}),
  };
}
