/**
 * The embedded-client (standalone) publisher backing every paid `rig`
 * command: build a nonce-guarded {@link StandalonePublisher} from the
 * caller's own identity and config.
 *
 * Identity comes from the #248 precedence chain (`./identity.ts`:
 * RIG_MNEMONIC env → TOON_CLIENT_MNEMONIC env alias → project `.env` →
 * `~/.toon-client` keystore/config). The remaining config resolution
 * DUPLICATES the toon-clientd conventions
 * (`packages/client-mcp/src/daemon/config.ts`) the same way
 * `../standalone/nonce-guard.ts` does — this package must not import
 * `@toon-protocol/client-mcp` (circular; see that module's doc). Keep in sync:
 *
 *   - state dir: `TOON_CLIENT_HOME`, else `~/.toon-client`; config `config.json`
 *   - env overrides: `TOON_CLIENT_PROXY_URL`, `TOON_CLIENT_BTP_URL`,
 *     `TOON_CLIENT_RELAY_URL`, `TOON_CLIENT_DESTINATION`,
 *     `TOON_CLIENT_PUBLISH_DESTINATION`, `TOON_CLIENT_STORE_DESTINATION`,
 *     `TOON_CLIENT_CHAIN`
 *
 * NETWORK BOOTSTRAP (#264): what explicit config does not pin is resolved
 * from the network itself — the payment peer's live kind:10032 announce on
 * the relay-origin, falling back to `@toon-protocol/core`'s committed
 * genesis peer seed. Uplink, channel anchor, publish/store routes, the
 * settlement chain and its TokenNetwork/token/RPC parameters all follow the
 * `explicit config > live announce > genesis seed` order documented in
 * `../standalone/network-bootstrap.ts`. The pure resolution lives in
 * {@link resolveNetworkTopology} (unit-testable without any network).
 *
 * TOPOLOGY CACHE (#279): the resolved topology is persisted under
 * `TOON_CLIENT_HOME` (`../standalone/topology-cache.ts`) keyed by
 * relay-origin + identity + an explicit-config fingerprint, with a 15-min
 * TTL (`RIG_TOPOLOGY_TTL_MS` overrides; `0` disables). A cache hit skips
 * announce discovery and the funded-chain probes entirely; a cached
 * topology that then fails to BOOTSTRAP is invalidated and re-resolved
 * live in-process ({@link TopologyRecoveringPublisher}), so staleness costs
 * one failed attempt, never a broken run. Only paid-path resolutions
 * (`requireUplink !== false`) are written — a free-read topology may lack
 * an uplink and must not shadow the paid path's MissingUplinkError.
 *
 * CORE COEXISTENCE NOTE: rig performs discovery with ITS OWN
 * `@toon-protocol/core` (^2.0.x — live genesis seed), while the embedded
 * `@toon-protocol/client` keeps its internal core (^1.6.x) for its own
 * bootstrap/negotiation. The two never exchange class instances — rig feeds
 * the client plain config (`knownPeers`, settlement maps), so the version
 * split is safe by construction.
 *
 * This module statically imports `@toon-protocol/client` (heavy: viem,
 * noble, nostr-tools), so it must only ever be reached through the dynamic
 * import in `push.ts` (see `./standalone-context.ts`).
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ToonClientConfig } from '@toon-protocol/client';
import { EvmSigner, deriveNostrKeyFromMnemonic } from '@toon-protocol/client';
import {
  decodeEventFromToon,
  encodeEventToToon,
} from '@toon-protocol/core';
import type {
  FeeRates,
  GitObjectUpload,
  Publisher,
  PublishReceipt,
  UploadReceipt,
} from '../publisher.js';
import type { UnsignedEvent } from '../nip34-events.js';
import {
  ChannelMapStore,
  RIG_CHANNEL_MAP_FILENAME,
  type ChannelMapRecord,
} from '../standalone/channel-map.js';
import {
  TOPOLOGY_CACHE_FILENAME,
  TOPOLOGY_TTL_ENV,
  TopologyCache,
  explicitConfigFingerprint,
  topologyCacheKey,
  topologyCacheTtlMs,
} from '../standalone/topology-cache.js';
import {
  DISCOVERY_TIMEOUT_MS,
  TokenNetworkUnderivableError,
  discoverAnnouncedPeers,
  evmTokenBalance,
  genesisSeedPubkeys,
  loadGenesisSeed,
  pickPaymentPeer,
  resolveChainSettlement,
  selectSettlementChain,
  type AnnouncedPeer,
  type ChainSelection,
  type ChannelRecordLike,
  type EvmBalanceProbe,
  type ExplicitChainConfig,
} from '../standalone/network-bootstrap.js';
import { StandalonePublisher } from '../standalone/standalone-publisher.js';
import { fetchRemoteState } from '../remote-state.js';
import { resolveIdentity } from './identity.js';
import type {
  StandaloneContext,
  StandaloneLoadOptions,
} from './standalone-context.js';

/** The subset of the shared client config file standalone mode consumes. */
export interface ClientConfigFile {
  network?: 'mainnet' | 'testnet' | 'devnet' | 'custom';
  mnemonicAccountIndex?: number;
  btpUrl?: string;
  proxyUrl?: string;
  relayUrl?: string;
  destination?: string;
  publishDestination?: string;
  storeDestination?: string;
  feePerEvent?: string;
  channelStorePath?: string;
  /** Settlement chain: family (`evm`) or full id (`evm:31337`). */
  chain?: string;
  supportedChains?: string[];
  settlementAddresses?: Record<string, string>;
  preferredTokens?: Record<string, string>;
  tokenNetworks?: Record<string, string>;
  chainRpcUrls?: Record<string, string>;
  solanaChannel?: ToonClientConfig['solanaChannel'];
  minaChannel?: ToonClientConfig['minaChannel'];
}

/** An identity was resolved, but there is no way to send paid writes. */
export class MissingUplinkError extends Error {
  constructor(configPath: string, relayUrl: string | undefined) {
    const discovered = relayUrl
      ? `no announce with a btp/http endpoint was found on ${relayUrl} and ` +
        'the genesis seed has none; '
      : '';
    super(
      `no write uplink configured: ${discovered}set TOON_CLIENT_PROXY_URL ` +
        '(connector payment proxy) or TOON_CLIENT_BTP_URL, or add ' +
        `proxyUrl/btpUrl to ${configPath}`
    );
    this.name = 'MissingUplinkError';
  }
}

function configDir(env: NodeJS.ProcessEnv): string {
  return env['TOON_CLIENT_HOME'] ?? join(homedir(), '.toon-client');
}

function readClientConfig(path: string): ClientConfigFile {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ClientConfigFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(
      `failed to read client config at ${path}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** `https://host/ilp` → `https://host` (the client re-derives `/ilp`). */
function proxyBaseOf(httpEndpoint: string): string {
  return httpEndpoint.replace(/\/+$/, '').replace(/\/ilp$/i, '');
}

// ---------------------------------------------------------------------------
// Pure topology resolution (#264) — exported for tests
// ---------------------------------------------------------------------------

/** A genesis-seed peer as this module consumes it (rig's core 2.x shape). */
export interface GenesisSeedLike {
  pubkey: string;
  relayUrl: string;
  ilpAddress: string;
  btpEndpoint: string;
}

/** Inputs to {@link resolveNetworkTopology} (side-effect free). */
export interface NetworkTopologyInputs {
  env: NodeJS.ProcessEnv;
  file: ClientConfigFile;
  /** For error messages ("add X to <configPath>"). */
  configPath: string;
  /** Resolved relay-origin (already precedence-resolved). */
  relayUrl: string;
  /** The discovered payment-peer announce, if any. */
  announce: AnnouncedPeer | undefined;
  /** The committed genesis seed entry, if any. */
  genesisSeed: GenesisSeedLike | undefined;
  identity: { mnemonic: string; accountIndex: number; pubkey: string };
  /**
   * #262 channel-map records for this identity (chain selection input).
   * A thunk so the (possibly corrupt-throwing) map read only happens when
   * chain selection actually needs it.
   */
  channelRecords: () => ChannelRecordLike[];
  /** Balance probe override (tests); default: raw `eth_call`. */
  probeBalance?: EvmBalanceProbe;
  /**
   * When false (#263 free reads, e.g. `rig balance`), a missing uplink is
   * tolerated instead of throwing {@link MissingUplinkError}.
   */
  requireUplink?: boolean;
  warn: (line: string) => void;
}

/** The resolved payment topology feeding the embedded client config. */
export interface NetworkTopology {
  proxyUrl?: string;
  btpUrl?: string;
  /** Channel anchor / default ILP destination. */
  destination: string;
  publishDestination?: string;
  storeDestination?: string;
  /** The peer the embedded client bootstraps + negotiates with. */
  knownPeers: { pubkey: string; relayUrl: string; btpEndpoint: string }[];
  /** The selected settlement chain + rationale (absent: nothing known). */
  selection?: ChainSelection;
  supportedChains?: string[];
  preferredTokens?: Record<string, string>;
  tokenNetworks?: Record<string, string>;
  chainRpcUrls?: Record<string, string>;
}

/**
 * Resolve the payment topology per the #264 precedence order —
 * `explicit config > live announce > genesis seed` for every field, plus the
 * documented settlement-chain selection rule (see
 * `../standalone/network-bootstrap.ts`).
 *
 * @throws {MissingUplinkError} when no source yields an uplink.
 * @throws {TokenNetworkUnderivableError} when the selected EVM chain's
 *   TokenNetwork cannot be derived from config, announce, or chain preset.
 */
export async function resolveNetworkTopology(
  inputs: NetworkTopologyInputs
): Promise<NetworkTopology> {
  const { env, file, configPath, relayUrl, announce, genesisSeed, warn } =
    inputs;

  // ── Explicit config (always wins, per field) ─────────────────────────────
  const explicitProxyUrl = env['TOON_CLIENT_PROXY_URL'] ?? file.proxyUrl;
  const explicitBtpUrl = env['TOON_CLIENT_BTP_URL'] ?? file.btpUrl;
  const explicitDestination =
    env['TOON_CLIENT_DESTINATION'] ?? file.destination;
  const explicitPublish =
    env['TOON_CLIENT_PUBLISH_DESTINATION'] ?? file.publishDestination;
  const explicitStore =
    env['TOON_CLIENT_STORE_DESTINATION'] ?? file.storeDestination;
  const explicitChain = env['TOON_CLIENT_CHAIN'] ?? file.chain;
  const explicitMaps: ExplicitChainConfig = {
    ...(file.chainRpcUrls ? { chainRpcUrls: file.chainRpcUrls } : {}),
    ...(file.preferredTokens ? { preferredTokens: file.preferredTokens } : {}),
    ...(file.tokenNetworks ? { tokenNetworks: file.tokenNetworks } : {}),
  };

  // ── Uplink: explicit > announce (http > btp) > genesis seed ──────────────
  let proxyUrl = explicitProxyUrl;
  let btpUrl = explicitBtpUrl;
  if (!proxyUrl && !btpUrl) {
    if (announce?.info.httpEndpoint) {
      proxyUrl = proxyBaseOf(announce.info.httpEndpoint);
    } else if (announce?.info.btpEndpoint) {
      btpUrl = announce.info.btpEndpoint;
    } else if (genesisSeed?.btpEndpoint) {
      btpUrl = genesisSeed.btpEndpoint;
    } else if (inputs.requireUplink !== false) {
      // Free reads (`rig balance`, #263) tolerate a missing uplink; paid
      // commands fail here, after every source has been tried.
      throw new MissingUplinkError(configPath, relayUrl);
    }
  }

  // ── Destination anchor + publish/store routes ────────────────────────────
  // The channel anchors at the peer's announced ilpAddress; publish/store
  // routes come from the announce's `routes` map. Explicit values always
  // win; with neither, the publisher's `<base>.relay.store` anchor-derivation
  // convention remains as the last-resort fallback (explicit anchors only).
  const destination =
    explicitDestination ??
    announce?.info.ilpAddress ??
    genesisSeed?.ilpAddress ??
    'g.proxy';
  const publishDestination = explicitPublish ?? announce?.routes?.publish;
  const storeDestination = explicitStore ?? announce?.routes?.store;

  // ── Known peer for the embedded client's own bootstrap ───────────────────
  // The client re-queries the peer's announce itself (its internal core) and
  // negotiates the settlement chain; rig just tells it WHO to bootstrap with.
  const knownPeers = announce
    ? [
        {
          pubkey: announce.pubkey,
          relayUrl,
          btpEndpoint: announce.info.btpEndpoint ?? '',
        },
      ]
    : genesisSeed
      ? [
          {
            pubkey: genesisSeed.pubkey,
            relayUrl: genesisSeed.relayUrl,
            btpEndpoint: genesisSeed.btpEndpoint,
          },
        ]
      : [];

  // ── Settlement chain + per-chain parameters ──────────────────────────────
  // NOTE: the `network` preset field is deliberately NOT forwarded to the
  // embedded client. `applyNetworkPresets` puts preset chains FIRST in
  // `supportedChains`, which is what steered devnet negotiation to the
  // unfunded public Solana preset (#260 root cause 4). The announce + the
  // rule below define the chain; presets only serve as per-chain parameter
  // fallbacks inside `resolveChainSettlement`.
  const announcedChains = announce?.info.supportedChains ?? [];
  const resolveSettlement = (chain: string) =>
    resolveChainSettlement(chain, explicitMaps, announce);

  let selection: ChainSelection | undefined;
  let supportedChains: string[] | undefined;
  let preferredTokens: Record<string, string> | undefined;
  let tokenNetworks: Record<string, string> | undefined;
  let chainRpcUrls: Record<string, string> | undefined;

  if (file.supportedChains?.length) {
    // Explicit chain list: pass through as-is (its order IS the negotiation
    // preference), filling per-chain parameter gaps from announce/presets.
    supportedChains = file.supportedChains;
    preferredTokens = { ...file.preferredTokens };
    tokenNetworks = { ...file.tokenNetworks };
    chainRpcUrls = { ...file.chainRpcUrls };
    for (const chain of supportedChains) {
      const s = resolveSettlement(chain);
      if (s.tokenAddress && !preferredTokens[chain]) {
        preferredTokens[chain] = s.tokenAddress;
      }
      if (s.tokenNetwork && !tokenNetworks[chain]) {
        tokenNetworks[chain] = s.tokenNetwork;
      }
      if (s.rpcUrl && !chainRpcUrls[chain]) {
        chainRpcUrls[chain] = s.rpcUrl;
      }
      // Same fail-fast guarantee as the announce/selection path below: an
      // explicitly configured EVM chain whose TokenNetwork/RPC cannot be
      // derived must fail HERE with an actionable error, not later as the
      // embedded client's generic "tokenNetwork address is required".
      if (s.family === 'evm') {
        if (!tokenNetworks[chain]) {
          throw new TokenNetworkUnderivableError(chain, announce, relayUrl);
        }
        if (!chainRpcUrls[chain]) {
          throw new Error(
            `no RPC URL is derivable for settlement chain "${chain}"` +
              ` — add chainRpcUrls["${chain}"] to ${configPath}`
          );
        }
      }
    }
    selection = {
      chain: supportedChains[0] as string,
      reason: 'explicit',
      detail: 'supportedChains set by config',
    };
  } else if (explicitChain || announcedChains.length > 0) {
    // Selection rule: explicit > persisted channel > funded > first EVM.
    const { secretKey } = deriveNostrKeyFromMnemonic(
      inputs.identity.mnemonic,
      inputs.identity.accountIndex
    );
    const evmAddress = new EvmSigner(secretKey).address;
    selection = await selectSettlementChain({
      ...(explicitChain ? { explicitChain } : {}),
      announcedChains,
      records: inputs.channelRecords(),
      evmAddress,
      resolveSettlement,
      probeBalance: inputs.probeBalance ?? evmTokenBalance,
    });
    const settlement = resolveSettlement(selection.chain);
    if (settlement.family === 'evm') {
      if (!settlement.tokenNetwork) {
        throw new TokenNetworkUnderivableError(
          selection.chain,
          announce,
          relayUrl
        );
      }
      if (!settlement.rpcUrl) {
        throw new Error(
          `no RPC URL is derivable for settlement chain "${selection.chain}"` +
            ` — add chainRpcUrls["${selection.chain}"] to ${configPath}`
        );
      }
    }
    supportedChains = [selection.chain];
    preferredTokens = settlement.tokenAddress
      ? { [selection.chain]: settlement.tokenAddress }
      : undefined;
    tokenNetworks = settlement.tokenNetwork
      ? { [selection.chain]: settlement.tokenNetwork }
      : undefined;
    chainRpcUrls = settlement.rpcUrl
      ? { [selection.chain]: settlement.rpcUrl }
      : undefined;
    if (selection.reason !== 'explicit') {
      warn(
        `rig: settlement chain ${selection.chain} selected — ` +
          `${selection.detail}; set TOON_CLIENT_CHAIN (or supportedChains ` +
          'in the client config) to override'
      );
    }
  } else {
    warn(
      'rig: no settlement chains are configured or announced — paid writes ' +
        'will fail until a chain is configured (supportedChains) or the ' +
        `payment peer announces its chains on ${relayUrl}`
    );
  }

  const network = env['TOON_CLIENT_NETWORK'] ?? file.network;
  if (network && network !== 'custom' && !file.supportedChains?.length) {
    warn(
      `rig: ignoring the "${network}" network preset for settlement — the ` +
        "settlement chain comes from the payment peer's announce and your " +
        'config, because preset chains can point at networks your wallet ' +
        'has no funds on; set supportedChains explicitly to use preset chains'
    );
  }

  return {
    ...(proxyUrl ? { proxyUrl } : {}),
    ...(btpUrl ? { btpUrl } : {}),
    destination,
    ...(publishDestination ? { publishDestination } : {}),
    ...(storeDestination ? { storeDestination } : {}),
    knownPeers,
    ...(selection ? { selection } : {}),
    ...(supportedChains ? { supportedChains } : {}),
    ...(preferredTokens && Object.keys(preferredTokens).length > 0
      ? { preferredTokens }
      : {}),
    ...(tokenNetworks && Object.keys(tokenNetworks).length > 0
      ? { tokenNetworks }
      : {}),
    ...(chainRpcUrls && Object.keys(chainRpcUrls).length > 0
      ? { chainRpcUrls }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Cached-topology recovery (#279)
// ---------------------------------------------------------------------------

/** Structural check for a cached {@link NetworkTopology} document. */
function isNetworkTopology(value: unknown): value is NetworkTopology {
  if (typeof value !== 'object' || value === null) return false;
  const t = value as Record<string, unknown>;
  return typeof t['destination'] === 'string' && Array.isArray(t['knownPeers']);
}

/**
 * Start failures that must NEVER trigger a cache-invalidation retry: they
 * are concurrency/state guards, not topology staleness — retrying would
 * bypass exactly what they protect.
 */
const NON_RECOVERABLE_START_ERRORS: ReadonlySet<string> = new Set([
  'DaemonIdentityConflictError',
  'StandaloneLockError',
  'ChannelMapCorruptError',
]);

/**
 * Publisher wrapper implementing the #279 cache-invalidation contract: when
 * the inner publisher was built from a CACHED topology and its bootstrap
 * (`start`/`startClientOnly`) fails, the cache entry is invalidated, the
 * topology is re-resolved LIVE, a fresh publisher replaces the inner one,
 * and the operation proceeds — one retry, never more. Bootstrap failures
 * are pre-payment by construction (start() completes before any claim is
 * signed), so the retry can never double-pay. Publishers built from a live
 * resolution get no recovery hook and fail through unchanged.
 */
class TopologyRecoveringPublisher implements Publisher {
  private inner: StandalonePublisher;
  private rebuild: (() => Promise<StandalonePublisher>) | undefined;
  private readonly warn: (line: string) => void;

  constructor(
    inner: StandalonePublisher,
    rebuild: (() => Promise<StandalonePublisher>) | undefined,
    warn: (line: string) => void
  ) {
    this.inner = inner;
    this.rebuild = rebuild;
    this.warn = warn;
  }

  getPublicKey(): string {
    return this.inner.getPublicKey();
  }

  getFeeRates(): Promise<FeeRates> {
    return this.inner.getFeeRates();
  }

  /**
   * Run the bootstrap step, recovering ONCE from a stale cached topology.
   * A rebuild failure surfaces the LIVE resolution's error — that is the
   * network's real state, strictly more actionable than the cached failure.
   */
  private async ensure(
    start: (p: StandalonePublisher) => Promise<void>
  ): Promise<StandalonePublisher> {
    try {
      await start(this.inner);
      return this.inner;
    } catch (err) {
      const rebuild = this.rebuild;
      this.rebuild = undefined;
      const name = err instanceof Error ? err.name : '';
      if (!rebuild || NON_RECOVERABLE_START_ERRORS.has(name)) throw err;
      this.warn(
        'rig: bootstrap with the cached network topology failed ' +
          `(${err instanceof Error ? err.message : String(err)}) — ` +
          'invalidating the cache and re-resolving live'
      );
      const fresh = await rebuild();
      try {
        // Failed starts release their own lock/state; stop() is idempotent.
        await this.inner.stop();
      } catch {
        // best-effort teardown of the abandoned publisher
      }
      this.inner = fresh;
      await start(this.inner);
      return this.inner;
    }
  }

  async publishEvent(
    event: UnsignedEvent,
    relayUrls: string[]
  ): Promise<PublishReceipt> {
    const p = await this.ensure((x) => x.start());
    return p.publishEvent(event, relayUrls);
  }

  async uploadGitObject(upload: GitObjectUpload): Promise<UploadReceipt> {
    const p = await this.ensure((x) => x.start());
    return p.uploadGitObject(upload);
  }

  // ── money lifecycle passthroughs (#263) — same recovery contract ─────────

  async openChannelExplicit(
    opts?: Parameters<StandalonePublisher['openChannelExplicit']>[0]
  ): ReturnType<StandalonePublisher['openChannelExplicit']> {
    const p = await this.ensure((x) => x.start());
    return p.openChannelExplicit(opts);
  }

  async closeRecordedChannel(
    record: ChannelMapRecord
  ): ReturnType<StandalonePublisher['closeRecordedChannel']> {
    const p = await this.ensure((x) => x.startClientOnly());
    return p.closeRecordedChannel(record);
  }

  async settleRecordedChannel(
    record: ChannelMapRecord
  ): ReturnType<StandalonePublisher['settleRecordedChannel']> {
    const p = await this.ensure((x) => x.startClientOnly());
    return p.settleRecordedChannel(record);
  }

  /** Free read on the unstarted client — no bootstrap, no recovery needed. */
  readWalletChainBalances(): ReturnType<
    StandalonePublisher['readWalletChainBalances']
  > {
    return this.inner.readWalletChainBalances();
  }

  async stop(): Promise<void> {
    await this.inner.stop();
  }
}

// ---------------------------------------------------------------------------
// Context factory
// ---------------------------------------------------------------------------

/**
 * #262 channel-map records for this identity, reduced to the slice chain
 * selection consumes (`closed` folds in the claim-watermark timers).
 */
function chainRecordsFor(
  map: ChannelMapStore,
  identity: string
): ChannelRecordLike[] {
  return map
    .list()
    .filter((r) => r.identity === identity)
    .map((r) => {
      const watermark = map.readWatermark(r.channelId);
      return {
        chain: r.chain,
        lastUsedAt: r.lastUsedAt,
        closed:
          watermark?.closedAt !== undefined ||
          watermark?.settledAt !== undefined,
      };
    });
}

/**
 * Assemble an embedded-client standalone context: resolved identity + config
 * → network bootstrap (announce discovery / genesis seed) → ToonClientConfig
 * → nonce-guarded StandalonePublisher (guard + client start + channel open
 * happen lazily on the first paid call, or eagerly via the publisher's own
 * `start`).
 */
export async function createStandaloneContext(
  options: StandaloneLoadOptions
): Promise<StandaloneContext> {
  const { env } = options;
  const warn = (line: string) => options.warn(line);
  const dir = configDir(env);
  const configPath = join(dir, 'config.json');
  const file = readClientConfig(configPath);
  const identity = await resolveIdentity(options);

  const genesisSeed = loadGenesisSeed();

  // ── Relay-origin ──────────────────────────────────────────────────────────
  // The relay the paid command resolved via `rig remote` (passed by the
  // command) is the user's clearest network statement; env/file follow, and
  // the genesis seed's relay is the out-of-the-box fallback.
  const relayUrl =
    options.relayUrl ??
    env['TOON_CLIENT_RELAY_URL'] ??
    file.relayUrl ??
    genesisSeed?.relayUrl ??
    'ws://localhost:7100';

  // ── Peer→channel persistence (#262) ──────────────────────────────────────
  const channelStorePath = file.channelStorePath ?? join(dir, 'channels.json');
  const channelMap = new ChannelMapStore({
    mapPath: join(dir, RIG_CHANNEL_MAP_FILENAME),
    watermarkPath: channelStorePath,
  });

  // ── Topology cache (#279): keyed by relay-origin + identity + explicit
  // config; a hit skips discovery AND the pure-but-probing resolution below.
  const cache = new TopologyCache<NetworkTopology>({
    path: join(dir, TOPOLOGY_CACHE_FILENAME),
    ttlMs: topologyCacheTtlMs(env),
    validate: isNetworkTopology,
  });
  const cacheKey = topologyCacheKey({
    relayUrl,
    identity: identity.pubkey,
    fingerprint: explicitConfigFingerprint(
      env,
      file as Record<string, unknown>
    ),
  });

  const resolveLiveTopology = async (): Promise<NetworkTopology> => {
    // ── Live announce discovery ────────────────────────────────────────────
    // Skipped when explicit config already pins the whole payment topology
    // (fully-configured setups keep their zero-roundtrip start and their
    // exact pre-#264 behavior). Discovery failure is non-fatal: warn +
    // genesis seed.
    const fullyExplicit =
      Boolean(
        (env['TOON_CLIENT_PROXY_URL'] ?? file.proxyUrl) ||
          (env['TOON_CLIENT_BTP_URL'] ?? file.btpUrl)
      ) &&
      Boolean(env['TOON_CLIENT_DESTINATION'] ?? file.destination) &&
      Boolean(file.supportedChains?.length);
    let announce: AnnouncedPeer | undefined;
    if (!fullyExplicit) {
      try {
        const peers = await discoverAnnouncedPeers(relayUrl, {
          timeoutMs: DISCOVERY_TIMEOUT_MS,
        });
        announce = pickPaymentPeer(peers, genesisSeedPubkeys());
        if (!announce) {
          warn(
            `rig: no payment-peer announce (kind:10032) found on ${relayUrl} — ` +
              'falling back to the genesis peer seed'
          );
        }
      } catch (err) {
        warn(
          `rig: announce discovery on ${relayUrl} failed ` +
            `(${err instanceof Error ? err.message : String(err)}) — falling ` +
            'back to the genesis peer seed'
        );
      }
    }

    // ── Topology resolution (pure; explicit > announce > genesis) ──────────
    const resolved = await resolveNetworkTopology({
      env,
      file,
      configPath,
      relayUrl,
      announce,
      genesisSeed,
      identity: {
        mnemonic: identity.mnemonic,
        accountIndex: identity.accountIndex,
        pubkey: identity.pubkey,
      },
      channelRecords: () => chainRecordsFor(channelMap, identity.pubkey),
      ...(options.requireUplink !== undefined
        ? { requireUplink: options.requireUplink }
        : {}),
      warn,
    });
    // Cache only paid-path resolutions: a `requireUplink: false` free read
    // may resolve WITHOUT an uplink, and caching that would let a later paid
    // command skip past MissingUplinkError with a broken topology.
    if (options.requireUplink !== false) cache.write(cacheKey, resolved);
    return resolved;
  };

  const cached = cache.read(cacheKey);
  if (cached) {
    warn(
      `rig: network topology from cache (${Math.round(cached.ageMs / 1000)}s ` +
        `old; ${TOPOLOGY_TTL_ENV}=0 disables) — skipping announce discovery`
    );
  }
  const topology = cached?.topology ?? (await resolveLiveTopology());

  const eventFee = BigInt(file.feePerEvent ?? '1');

  const buildPublisher = (topo: NetworkTopology): StandalonePublisher => {
    const clientConfig: ToonClientConfig = {
      // validateConfig requires connectorUrl OR proxyUrl; with BTP-only
      // config a dummy connectorUrl satisfies it (unused at runtime — same
      // convention as the daemon).
      ...(topo.proxyUrl
        ? { proxyUrl: topo.proxyUrl }
        : { connectorUrl: 'http://127.0.0.1:1' }),
      mnemonic: identity.mnemonic,
      mnemonicAccountIndex: identity.accountIndex,
      ilpInfo: {
        pubkey: '00'.repeat(32),
        ilpAddress: 'g.toon.client',
        btpEndpoint: topo.btpUrl ?? '',
        assetCode: 'USD',
        assetScale: 6,
      },
      toonEncoder: encodeEventToToon,
      toonDecoder: decodeEventFromToon,
      ...(topo.btpUrl ? { btpUrl: topo.btpUrl, btpAuthToken: '' } : {}),
      destinationAddress: topo.destination,
      // The embedded client bootstraps against the known peer above; its
      // `relayUrl` config only seeds ArDrive-merged peers, so it stays unset.
      relayUrl: '',
      knownPeers: topo.knownPeers,
      channelStorePath,
      ...(topo.supportedChains
        ? { supportedChains: topo.supportedChains }
        : {}),
      ...(file.settlementAddresses
        ? { settlementAddresses: file.settlementAddresses }
        : {}),
      ...(topo.preferredTokens ? { preferredTokens: topo.preferredTokens } : {}),
      ...(topo.tokenNetworks ? { tokenNetworks: topo.tokenNetworks } : {}),
      ...(topo.chainRpcUrls ? { chainRpcUrls: topo.chainRpcUrls } : {}),
      ...(file.solanaChannel ? { solanaChannel: file.solanaChannel } : {}),
      ...(file.minaChannel ? { minaChannel: file.minaChannel } : {}),
    };

    return new StandalonePublisher({
      clientConfig,
      eventFee,
      channelMap,
      warn,
      ...(topo.publishDestination
        ? { publishDestination: topo.publishDestination }
        : {}),
      ...(topo.storeDestination
        ? { storeDestination: topo.storeDestination }
        : {}),
      // `rig channel open --peer` (#263): anchor the channel (and its map
      // key) to an explicit peer destination instead of the configured
      // default.
      ...(options.channelDestination
        ? { channelDestination: options.channelDestination }
        : {}),
      // The peer's announce does not carry TokenNetwork/token parameters, so
      // the client's negotiation leaves them empty (#260 root cause 3) — the
      // publisher back-fills them from the derived per-chain maps before the
      // channel opens.
      ...(topo.tokenNetworks || topo.preferredTokens
        ? {
            negotiationFallbacks: {
              ...(topo.tokenNetworks
                ? { tokenNetworks: topo.tokenNetworks }
                : {}),
              ...(topo.preferredTokens
                ? { preferredTokens: topo.preferredTokens }
                : {}),
            },
          }
        : {}),
    });
  };

  // Cache-sourced publishers get the #279 recovery hook: a failed bootstrap
  // invalidates the entry, re-resolves live (which re-writes the cache), and
  // retries once. Live-resolved publishers fail through unchanged.
  const publisher = new TopologyRecoveringPublisher(
    buildPublisher(topology),
    cached
      ? async () => {
          cache.invalidate(cacheKey);
          return buildPublisher(await resolveLiveTopology());
        }
      : undefined,
    warn
  );

  return {
    ownerPubkey: publisher.getPublicKey(),
    identitySource: identity.source,
    identitySourceLabel: identity.sourceLabel,
    publisher,
    defaultRelayUrls: [relayUrl],
    fetchRemote: (args) => fetchRemoteState(args),
    // Money lifecycle (#263): same guard/start/channel-map machinery as the
    // paid-write path, surfaced for fund/balance/channel open|close|settle.
    money: {
      openChannel: (opts) => publisher.openChannelExplicit(opts),
      closeChannel: (record) => publisher.closeRecordedChannel(record),
      settleChannel: (record) => publisher.settleRecordedChannel(record),
      walletChainBalances: () => publisher.readWalletChainBalances(),
    },
    stop: () => publisher.stop(),
  };
}
