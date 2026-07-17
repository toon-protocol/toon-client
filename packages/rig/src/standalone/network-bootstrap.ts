/**
 * Network bootstrap for the standalone (embedded-client) rig path (#264):
 * resolve the payment topology — uplink, ILP destinations/routes, settlement
 * chain and its on-chain parameters — from the network itself instead of
 * hand-fed constants.
 *
 * Sources, in strict precedence order (first hit wins, per field):
 *
 *   1. EXPLICIT USER CONFIG — env vars / shared client-config file fields.
 *   2. LIVE kind:10032 ANNOUNCE — the payment peer's `IlpPeerInfo` event
 *      discovered on the relay-origin (the relay the paid command resolved
 *      via `rig remote`, i.e. what the user pointed rig at). The announce
 *      carries `btpEndpoint`/`httpEndpoint` (uplink), `ilpAddress` (channel
 *      anchor), `supportedChains` + `settlementAddresses` (settlement), and
 *      the out-of-band `routes` map (`{publish, store}` ILP destinations).
 *   3. GENESIS SEED — `@toon-protocol/core`'s committed genesis peer seed
 *      (core >= 2.0.1 ships the live devnet apex), the offline fallback when
 *      the relay is unreachable or serves no valid announce.
 *
 * Chain-level parameters the announce does NOT carry (EVM TokenNetwork
 * contract, token address, RPC URL) are derived per selected chain:
 * explicit config > announce (`tokenNetworks`/`preferredTokens`, when a peer
 * announces them) > the deployed-devnet endpoint table (canonical
 * `*.devnet.toonprotocol.dev` hosts, keyed off the announce's own hostnames)
 * > core's deterministic chain presets (`CHAIN_PRESETS`, matched by chain
 * id — e.g. `evm:31337` is the Foundry/anvil deploy whose TOON contract
 * addresses are deterministic).
 *
 * Settlement-chain selection (#260 root cause 4) — simple and predictable:
 *
 *   1. EXPLICIT — `TOON_CLIENT_CHAIN` env / `chain` config field (family or
 *      full chain id), or the first entry of an explicit `supportedChains`.
 *   2. PERSISTED CHANNEL — the chain of the most recently used live channel
 *      recorded for this identity in the #262 channel map (a channel there
 *      means collateral is already locked on that chain).
 *   3. FUNDED — the first announced chain (EVM or Solana, in announce
 *      order) where the identity's token balance is > 0 (one `eth_call` /
 *      `getTokenAccountsByOwner` per candidate).
 *   4. DEFAULT — the first EVM chain the peer announces (else the first
 *      announced chain), with a printed rationale.
 *
 * This module is pure Node + `@toon-protocol/core` (rig's own core 2.x —
 * distinct from the embedded client's internal core; see
 * `../cli/standalone-mode.ts` for the coexistence note).
 */

import {
  CHAIN_PRESETS,
  GenesisPeerLoader,
  isEventExpired,
  parseIlpPeerInfo,
  resolveClientNetwork,
  type GenesisPeer,
  type IlpPeerInfo,
} from '@toon-protocol/core';
import {
  queryRelay,
  type NostrEvent,
  type WebSocketFactory,
} from '../remote-state.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** kind:10032 — ILP peer info announcement (mirrors core's constant). */
export const ILP_PEER_INFO_KIND = 10032;

/** Publish/store ILP route hints riding out-of-band in announce content. */
export interface AnnouncedRoutes {
  publish?: string;
  store?: string;
}

/** One schema-valid, unexpired kind:10032 announce seen on the relay. */
export interface AnnouncedPeer {
  /** Announcing identity (event author, hex). */
  pubkey: string;
  /** Parsed + validated `IlpPeerInfo` (rig's core 2.x parser). */
  info: IlpPeerInfo;
  /** Out-of-band `routes` content field, when present and well-formed. */
  routes?: AnnouncedRoutes;
  /** Announce timestamp (freshness tiebreaker). */
  createdAt: number;
}

/** Per-chain settlement parameters resolved for the embedded client. */
export interface ChainSettlement {
  /** Chain id as announced/configured, e.g. `evm:31337`. */
  chain: string;
  /** `evm` | `solana` | `mina` | … (first chain-id segment). */
  family: string;
  /** JSON-RPC / GraphQL endpoint, when derivable. */
  rpcUrl?: string;
  /** Preferred token (USDC / SPL mint) address, when derivable. */
  tokenAddress?: string;
  /** EVM TokenNetwork contract, when derivable (EVM only). */
  tokenNetwork?: string;
  /** Solana payment-channel program id, when derivable (Solana only). */
  programId?: string;
}

/** Why a settlement chain was selected (documented rule, in order). */
export type ChainSelectionReason =
  | 'explicit'
  | 'persisted-channel'
  | 'funded'
  | 'default';

/** The selected settlement chain plus its rationale. */
export interface ChainSelection {
  chain: string;
  reason: ChainSelectionReason;
  /** One human-readable line explaining the pick. */
  detail: string;
}

// ---------------------------------------------------------------------------
// Announce discovery
// ---------------------------------------------------------------------------

/** Default bounded wait for the kind:10032 relay query. */
export const DISCOVERY_TIMEOUT_MS = 5000;

function parseRoutes(content: string): AnnouncedRoutes | undefined {
  try {
    const parsed = JSON.parse(content) as { routes?: unknown };
    const routes = parsed.routes;
    if (typeof routes !== 'object' || routes === null) return undefined;
    const { publish, store } = routes as Record<string, unknown>;
    const out: AnnouncedRoutes = {
      ...(typeof publish === 'string' && publish.length > 0 ? { publish } : {}),
      ...(typeof store === 'string' && store.length > 0 ? { store } : {}),
    };
    return out.publish || out.store ? out : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Query `relayUrl` for kind:10032 announces and return the latest
 * schema-valid, unexpired announce per author. Invalid/expired events are
 * skipped silently (the relay serves plenty of non-peer 10032 experiments).
 */
export async function discoverAnnouncedPeers(
  relayUrl: string,
  options: {
    timeoutMs?: number;
    webSocketFactory?: WebSocketFactory;
  } = {}
): Promise<AnnouncedPeer[]> {
  const factory =
    options.webSocketFactory ?? defaultDiscoveryWebSocketFactory();
  const events = await queryRelay(
    relayUrl,
    { kinds: [ILP_PEER_INFO_KIND], limit: 100 },
    options.timeoutMs ?? DISCOVERY_TIMEOUT_MS,
    factory
  );

  const latestByAuthor = new Map<string, NostrEvent>();
  for (const event of events) {
    if (event.kind !== ILP_PEER_INFO_KIND) continue;
    const prev = latestByAuthor.get(event.pubkey);
    if (!prev || event.created_at > prev.created_at) {
      latestByAuthor.set(event.pubkey, event);
    }
  }

  const peers: AnnouncedPeer[] = [];
  for (const event of latestByAuthor.values()) {
    if (isEventExpired(event as Parameters<typeof isEventExpired>[0])) {
      continue;
    }
    let info: IlpPeerInfo;
    try {
      info = parseIlpPeerInfo(event as Parameters<typeof parseIlpPeerInfo>[0]);
    } catch {
      continue; // not a schema-valid IlpPeerInfo announce
    }
    const routes = parseRoutes(event.content);
    peers.push({
      pubkey: event.pubkey,
      info,
      ...(routes ? { routes } : {}),
      createdAt: event.created_at,
    });
  }
  return peers;
}

function defaultDiscoveryWebSocketFactory(): WebSocketFactory {
  return (url) => {
    const ctor = (
      globalThis as {
        WebSocket?: new (url: string) => ReturnType<WebSocketFactory>;
      }
    ).WebSocket;
    if (!ctor) {
      throw new Error(
        'No global WebSocket constructor (Node >= 22 required) for announce discovery'
      );
    }
    return new ctor(url);
  };
}

/**
 * Pick THE payment peer among discovered announces:
 *
 *   1. the announce authored by a genesis-seed pubkey (the committed apex
 *      identity — the strongest signal),
 *   2. else an announce that can actually take paid writes: has an uplink
 *      endpoint AND `settlementAddresses`, preferring one whose own
 *      `ilpAddress` is its `routes.publish` (the publish edge — that is
 *      where rig pays first),
 *   3. freshest `created_at` breaks remaining ties.
 */
export function pickPaymentPeer(
  peers: AnnouncedPeer[],
  seedPubkeys: readonly string[]
): AnnouncedPeer | undefined {
  const seeded = peers.filter((p) => seedPubkeys.includes(p.pubkey));
  if (seeded.length > 0) {
    return seeded.sort((a, b) => b.createdAt - a.createdAt)[0];
  }

  const payable = peers.filter(
    (p) =>
      (p.info.httpEndpoint || p.info.btpEndpoint) &&
      p.info.settlementAddresses &&
      Object.keys(p.info.settlementAddresses).length > 0
  );
  if (payable.length === 0) return undefined;
  const publishEdges = payable.filter(
    (p) => p.routes?.publish !== undefined && p.routes.publish === p.info.ilpAddress
  );
  const pool = publishEdges.length > 0 ? publishEdges : payable;
  return pool.sort((a, b) => b.createdAt - a.createdAt)[0];
}

// ---------------------------------------------------------------------------
// Per-chain settlement derivation
// ---------------------------------------------------------------------------

/**
 * The one deployed-network endpoint table rig ships: the canonical TOON
 * devnet (`*.devnet.toonprotocol.dev`, see toon-meta docs/deployment.md).
 * Chain RPC endpoints are deployment infrastructure the kind:10032 announce
 * does not carry (yet), so when the discovered peer's own endpoints live
 * under this zone, its self-hosted chains resolve to the canonical hosts.
 * Same status as `DEVNET_FAUCET_URL` in `../cli/fund.ts`. Everything here
 * is overridable by explicit `chainRpcUrls` config.
 */
export const DEVNET_ZONE = 'devnet.toonprotocol.dev';

/** Canonical devnet chain RPC endpoints (self-hosted chains only). */
export const DEVNET_CHAIN_RPC_URLS: Readonly<Record<string, string>> = {
  'evm:31337': 'https://evm-rpc.devnet.toonprotocol.dev',
  'solana:devnet': 'https://solana-rpc.devnet.toonprotocol.dev',
};

/**
 * Devnet endpoint-table lookup. EVM entries match by NUMERIC CHAIN ID, not
 * exact key: announces spell the same chain both `evm:31337` and
 * `evm:anvil:31337` (`evm:{network}:{chainId}` — the network label is
 * cosmetic), and an exact-key miss here left the announced EVM chain
 * without a reachable RPC, so zero-config devnet negotiation could not
 * balance-probe it and fell through to an unusable chain (#384).
 */
export function devnetChainRpcUrl(chain: string): string | undefined {
  const exact = DEVNET_CHAIN_RPC_URLS[chain];
  if (exact) return exact;
  const chainId = evmChainIdOf(chain);
  if (chainId === undefined) return undefined;
  for (const [key, url] of Object.entries(DEVNET_CHAIN_RPC_URLS)) {
    if (evmChainIdOf(key) === chainId) return url;
  }
  return undefined;
}

/** Hostname of a ws(s)/http(s) URL, or undefined when unparsable. */
function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/** True when the announce's own endpoints live under the TOON devnet zone. */
export function isDevnetZonePeer(
  peer: Pick<AnnouncedPeer, 'info'> | undefined
): boolean {
  if (!peer) return false;
  return [
    hostOf(peer.info.httpEndpoint),
    hostOf(peer.info.btpEndpoint),
    hostOf(peer.info.relayUrl),
  ].some((h) => h !== undefined && (h === DEVNET_ZONE || h.endsWith(`.${DEVNET_ZONE}`)));
}

/** Numeric chain id of an `evm:<id>` / `evm:<name>:<id>` chain key. */
export function evmChainIdOf(chain: string): number | undefined {
  const parts = chain.split(':');
  if (parts[0] !== 'evm') return undefined;
  const raw = parts.length >= 3 ? parts[2] : parts[1];
  const id = Number.parseInt(raw ?? '', 10);
  return Number.isNaN(id) ? undefined : id;
}

/**
 * Core chain preset matching an EVM chain key by numeric chain id. Presets
 * carry the DETERMINISTIC TOON contract addresses per chain (e.g. the
 * `anvil` 31337 Foundry deploy), which is what makes `tokenNetwork`
 * derivable without the announce carrying it.
 */
export function evmPresetForChain(chain: string):
  | { rpcUrl: string; usdcAddress: string; tokenNetworkAddress: string }
  | undefined {
  const id = evmChainIdOf(chain);
  if (id === undefined) return undefined;
  for (const preset of Object.values(CHAIN_PRESETS)) {
    if (preset.chainId === id) {
      return {
        rpcUrl: preset.rpcUrl,
        usdcAddress: preset.usdcAddress,
        tokenNetworkAddress: preset.tokenNetworkAddress,
      };
    }
  }
  return undefined;
}

/**
 * Public-cluster Solana preset matching a `solana:<cluster>` chain key. Draws
 * from core's client network presets (`resolveClientNetwork`) — the same
 * tables the daemon and townhouse resolve — so the deployed public-devnet
 * program/mint and the mainnet-beta RPC + Circle USDC mint come from ONE
 * source. `programId` is present only where the TOON payment-channel program
 * is actually deployed (public devnet today; mainnet-beta once deployed).
 * Self-hosted validators (e.g. the TOON devnet's own `solana-rpc.*` box) have
 * their own regenerated program ids — those must come from the announce or
 * explicit config, never a preset.
 */
export function solanaPresetForChain(chain: string):
  | { rpcUrl?: string; tokenMint?: string; programId?: string }
  | undefined {
  const [family, cluster] = chain.split(':');
  if (family !== 'solana' || !cluster) return undefined;
  const tier =
    cluster === 'mainnet-beta'
      ? 'mainnet'
      : cluster === 'devnet'
        ? 'devnet'
        : cluster === 'testnet'
          ? 'testnet'
          : undefined;
  if (!tier) return undefined;
  const presets = resolveClientNetwork(tier);
  // Look up by the exact chain key: the `testnet` tier resolves to the
  // deployed `solana:devnet` cluster, so `solana:testnet` correctly finds
  // nothing (TOON has no deployment on Solana's testnet cluster).
  const rpcUrl = presets.chainRpcUrls[chain];
  const tokenMint = presets.preferredTokens[chain];
  const programId =
    presets.solanaChannel && presets.supportedChains.includes(chain)
      ? presets.solanaChannel.programId
      : undefined;
  if (!rpcUrl && !tokenMint && !programId) return undefined;
  return {
    ...(rpcUrl ? { rpcUrl } : {}),
    ...(tokenMint ? { tokenMint } : {}),
    ...(programId ? { programId } : {}),
  };
}

/** Explicit per-chain maps from the shared client-config file. */
export interface ExplicitChainConfig {
  chainRpcUrls?: Record<string, string>;
  preferredTokens?: Record<string, string>;
  tokenNetworks?: Record<string, string>;
}

/**
 * Resolve one chain's settlement parameters: explicit config > announce >
 * devnet endpoint table (RPC only, devnet-zone peers) > core chain preset.
 * Fields stay undefined when no source covers them — callers decide whether
 * that is fatal (see {@link TokenNetworkUnderivableError} /
 * {@link SolanaChannelUnderivableError}).
 *
 * For `solana:*` chains the chain-keyed maps carry the SPL analogues: the
 * `preferredTokens` entry is the token mint, and the `tokenNetworks` entry is
 * the payment-channel PROGRAM id (the map is chain-keyed settlement-contract
 * addressing — TokenNetwork contract on EVM, channel program on Solana),
 * surfaced as {@link ChainSettlement.programId}.
 */
export function resolveChainSettlement(
  chain: string,
  explicit: ExplicitChainConfig,
  announce?: AnnouncedPeer
): ChainSettlement {
  const family = chain.split(':')[0] ?? chain;
  const evmPreset = family === 'evm' ? evmPresetForChain(chain) : undefined;
  const devnetRpc = isDevnetZonePeer(announce)
    ? devnetChainRpcUrl(chain)
    : undefined;
  // The devnet zone SELF-HOSTS this chain (its own validator): the
  // public-cluster preset addresses do not exist there (the devnet's Solana
  // program id is regenerated per redeploy), so presets must not fill gaps —
  // only the announce or explicit config can (else the caller fails fast
  // with an actionable error instead of an on-chain "program not found").
  // Detected via the announcing peer's zone OR the resolved RPC host, so an
  // explicit zone RPC is protected even when discovery was skipped/failed.
  const explicitOrZoneRpc = explicit.chainRpcUrls?.[chain] ?? devnetRpc;
  const rpcHost = hostOf(explicitOrZoneRpc);
  const zoneSelfHosted =
    (isDevnetZonePeer(announce) && devnetChainRpcUrl(chain) !== undefined) ||
    (rpcHost !== undefined &&
      (rpcHost === DEVNET_ZONE || rpcHost.endsWith(`.${DEVNET_ZONE}`)));
  const solPreset =
    family === 'solana' && !zoneSelfHosted
      ? solanaPresetForChain(chain)
      : undefined;

  const rpcUrl = explicitOrZoneRpc ?? evmPreset?.rpcUrl ?? solPreset?.rpcUrl;
  const tokenAddress =
    explicit.preferredTokens?.[chain] ??
    announce?.info.preferredTokens?.[chain] ??
    (evmPreset?.usdcAddress || undefined) ??
    solPreset?.tokenMint;
  const tokenNetwork =
    family === 'evm'
      ? (explicit.tokenNetworks?.[chain] ??
        announce?.info.tokenNetworks?.[chain] ??
        (evmPreset?.tokenNetworkAddress || undefined))
      : undefined;
  const programId =
    family === 'solana'
      ? (explicit.tokenNetworks?.[chain] ??
        announce?.info.tokenNetworks?.[chain] ??
        solPreset?.programId)
      : undefined;

  return {
    chain,
    family,
    ...(rpcUrl ? { rpcUrl } : {}),
    ...(tokenAddress ? { tokenAddress } : {}),
    ...(tokenNetwork ? { tokenNetwork } : {}),
    ...(programId ? { programId } : {}),
  };
}

/** An EVM chain was selected but its TokenNetwork cannot be derived. */
export class TokenNetworkUnderivableError extends Error {
  constructor(chain: string, announce: AnnouncedPeer | undefined, relayUrl: string) {
    const announceRef = announce
      ? `the kind:10032 announce from ${announce.pubkey.slice(0, 16)}… on ${relayUrl}`
      : `no kind:10032 announce was found on ${relayUrl}`;
    super(
      `cannot derive the TokenNetwork contract for settlement chain ` +
        `"${chain}": ${announceRef} carries no tokenNetworks["${chain}"], ` +
        `and no built-in chain preset matches its chain id — add ` +
        `tokenNetworks["${chain}"] to the client config (or pick another ` +
        `chain via TOON_CLIENT_CHAIN / the chain config field)`
    );
    this.name = 'TokenNetworkUnderivableError';
  }
}

/**
 * A Solana chain was selected but its channel parameters cannot be derived.
 * The missing pieces are named so the error is directly actionable: a
 * `solanaChannel` config object always works; the chain-keyed maps
 * (`tokenNetworks` = program id, `preferredTokens` = mint,
 * `chainRpcUrls` = RPC) work per-chain.
 */
export class SolanaChannelUnderivableError extends Error {
  constructor(
    chain: string,
    missing: string[],
    announce: AnnouncedPeer | undefined,
    relayUrl: string
  ) {
    const announceRef = announce
      ? `the kind:10032 announce from ${announce.pubkey.slice(0, 16)}… on ${relayUrl} does not carry them`
      : `no kind:10032 announce was found on ${relayUrl}`;
    super(
      `cannot derive the Solana channel parameters for settlement chain ` +
        `"${chain}" (missing: ${missing.join(', ')}): ${announceRef}, and ` +
        `no built-in preset covers this cluster — add a solanaChannel ` +
        `{ rpcUrl, programId, tokenMint } object to the client config (or ` +
        `set tokenNetworks["${chain}"] = <program id>, ` +
        `preferredTokens["${chain}"] = <mint>, chainRpcUrls["${chain}"]), ` +
        `or pick another chain via TOON_CLIENT_CHAIN / the chain config field`
    );
    this.name = 'SolanaChannelUnderivableError';
  }
}

// ---------------------------------------------------------------------------
// Settlement-chain selection (#260 root cause 4)
// ---------------------------------------------------------------------------

/** The slice of a #262 channel-map record chain selection consumes. */
export interface ChannelRecordLike {
  chain: string;
  lastUsedAt: string;
  /** True when the withdraw flow closed/settled the channel. */
  closed: boolean;
}

/** Async token-balance probe (injectable; default is a raw `eth_call`). */
export type EvmBalanceProbe = (args: {
  rpcUrl: string;
  tokenAddress: string;
  owner: string;
}) => Promise<bigint>;

/**
 * Async SPL token-balance probe (injectable; default is a raw
 * `getTokenAccountsByOwner`). `tokenAddress` is the SPL mint and `owner`
 * the identity's base58 Solana address — the same argument shape as
 * {@link EvmBalanceProbe} so both feed the one funded-chain loop.
 */
export type SolanaBalanceProbe = (args: {
  rpcUrl: string;
  tokenAddress: string;
  owner: string;
}) => Promise<bigint>;

export interface SelectChainOptions {
  /**
   * Explicit chain choice: full chain id (`evm:31337`), a family
   * (`evm` | `solana` | `mina`) matched against announced chains, or the
   * first entry of an explicit `supportedChains` config.
   */
  explicitChain?: string;
  /** Chains the payment peer announces (announce order preserved). */
  announcedChains: readonly string[];
  /** #262 channel-map records for this identity (any anchor). */
  records?: readonly ChannelRecordLike[];
  /** Identity's EVM address (funded-chain probe, `evm:*` candidates). */
  evmAddress?: string;
  /**
   * Identity's base58 Solana address (funded-chain probe, `solana:*`
   * candidates). Absent (e.g. the identity's Ed25519 key could not be
   * derived) means Solana chains are simply not probed.
   */
  solanaAddress?: string;
  /** Per-chain settlement resolver (for RPC/token of probe candidates). */
  resolveSettlement: (chain: string) => ChainSettlement;
  /** EVM balance probe; probe errors just skip the candidate. */
  probeBalance?: EvmBalanceProbe;
  /** Solana balance probe; probe errors just skip the candidate. */
  probeSolanaBalance?: SolanaBalanceProbe;
}

/**
 * Select the settlement chain per the documented rule: explicit >
 * persisted channel > funded chain (EVM + Solana, in announce order) >
 * first announced EVM chain.
 */
export async function selectSettlementChain(
  options: SelectChainOptions
): Promise<ChainSelection> {
  const { explicitChain, announcedChains } = options;

  // 1 — explicit config always wins (even when the peer does not announce
  // it: the user may know better than a stale announce).
  if (explicitChain) {
    if (explicitChain.includes(':')) {
      return {
        chain: explicitChain,
        reason: 'explicit',
        detail: `chain ${explicitChain} set by config`,
      };
    }
    const familyMatch = announcedChains.find(
      (c) => (c.split(':')[0] ?? c) === explicitChain
    );
    if (!familyMatch) {
      throw new Error(
        `configured chain family "${explicitChain}" is not announced by the ` +
          `payment peer (announced: ${announcedChains.join(', ') || 'none'}) — ` +
          'set a full chain id (e.g. "evm:31337") to force it'
      );
    }
    return {
      chain: familyMatch,
      reason: 'explicit',
      detail: `chain family "${explicitChain}" set by config → ${familyMatch}`,
    };
  }

  // 2 — a live persisted channel means collateral is already locked there.
  const live = (options.records ?? [])
    .filter((r) => !r.closed && announcedChains.includes(r.chain))
    .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
  const persisted = live[0];
  if (persisted) {
    return {
      chain: persisted.chain,
      reason: 'persisted-channel',
      detail: `existing payment channel on ${persisted.chain} (rig channel map)`,
    };
  }

  // 3 — first announced chain where the identity holds tokens, probing
  // EVM and Solana candidates in ANNOUNCE ORDER (the peer's stated
  // preference breaks a both-funded tie). Families without an address or
  // probe are skipped, as are candidates whose RPC/token are underivable.
  const evmChains = announcedChains.filter((c) => c.startsWith('evm:'));
  for (const chain of announcedChains) {
    const family = chain.split(':')[0];
    let probe: EvmBalanceProbe | SolanaBalanceProbe | undefined;
    let owner: string | undefined;
    if (family === 'evm') {
      probe = options.probeBalance;
      owner = options.evmAddress;
    } else if (family === 'solana') {
      probe = options.probeSolanaBalance;
      owner = options.solanaAddress;
    }
    if (!probe || !owner) continue;
    const settlement = options.resolveSettlement(chain);
    if (!settlement.rpcUrl || !settlement.tokenAddress) continue;
    try {
      const balance = await probe({
        rpcUrl: settlement.rpcUrl,
        tokenAddress: settlement.tokenAddress,
        owner,
      });
      if (balance > 0n) {
        return {
          chain,
          reason: 'funded',
          detail: `wallet holds ${balance} token base units on ${chain}`,
        };
      }
    } catch {
      // Unreachable RPC / bad token — not a candidate; fall through.
    }
  }

  // 4 — predictable default: the first EVM chain the peer announces.
  const fallback = evmChains[0] ?? announcedChains[0];
  if (!fallback) {
    throw new Error(
      'the payment peer announces no settlement chains — cannot select a ' +
        'chain for paid writes (set supportedChains/chain in the client config)'
    );
  }
  return {
    chain: fallback,
    reason: 'default',
    detail: evmChains[0]
      ? `first EVM chain announced by the payment peer`
      : `first chain announced by the payment peer (no EVM chain announced)`,
  };
}

// ---------------------------------------------------------------------------
// Default balance probes (raw JSON-RPC, no extra deps)
// ---------------------------------------------------------------------------

/** ERC-20 `balanceOf(address)` selector. */
const BALANCE_OF_SELECTOR = '0x70a08231';

/**
 * Read an ERC-20 balance with one raw `eth_call` (keeps the probe free of
 * viem — the embedded client is not started yet when selection runs).
 */
export async function evmTokenBalance(args: {
  rpcUrl: string;
  tokenAddress: string;
  owner: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<bigint> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const owner = args.owner.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs ?? 5000);
  try {
    const res = await fetchImpl(args.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [
          { to: args.tokenAddress, data: `${BALANCE_OF_SELECTOR}${owner}` },
          'latest',
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`eth_call failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (typeof body.result !== 'string') {
      throw new Error(`eth_call failed: ${body.error?.message ?? 'no result'}`);
    }
    return BigInt(body.result === '0x' ? '0x0' : body.result);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read an SPL token balance with one raw `getTokenAccountsByOwner` call
 * (keeps the probe free of @solana/web3.js — the embedded client is not
 * started yet when selection runs). `tokenAddress` is the mint; balances
 * are summed across all of the owner's token accounts for that mint (an
 * owner can hold the mint in more than one account).
 */
export async function solanaTokenBalance(args: {
  rpcUrl: string;
  tokenAddress: string;
  owner: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<bigint> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs ?? 5000);
  try {
    const res = await fetchImpl(args.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getTokenAccountsByOwner',
        params: [
          args.owner,
          { mint: args.tokenAddress },
          { encoding: 'jsonParsed' },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`getTokenAccountsByOwner failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as {
      result?: { value?: unknown };
      error?: { message?: string };
    };
    const accounts = body.result?.value;
    if (!Array.isArray(accounts)) {
      throw new Error(
        `getTokenAccountsByOwner failed: ${body.error?.message ?? 'no result'}`
      );
    }
    let total = 0n;
    for (const account of accounts) {
      const amount = (
        account as {
          account?: {
            data?: {
              parsed?: { info?: { tokenAmount?: { amount?: unknown } } };
            };
          };
        }
      )?.account?.data?.parsed?.info?.tokenAmount?.amount;
      if (typeof amount === 'string') total += BigInt(amount);
    }
    return total;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Genesis seed access (rig's own core 2.x — live devnet apex since 2.0.1)
// ---------------------------------------------------------------------------

/** The committed genesis peer seed (first entry), if any. */
export function loadGenesisSeed(): GenesisPeer | undefined {
  return GenesisPeerLoader.loadGenesisPeers()[0];
}

/** All committed genesis-seed pubkeys (announce-selection preference). */
export function genesisSeedPubkeys(): string[] {
  return GenesisPeerLoader.loadGenesisPeers().map((p) => p.pubkey);
}
