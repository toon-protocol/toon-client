/**
 * Standalone network-topology cache (#279): persist the #264 bootstrap
 * result — the announce-derived uplink, ILP routes, settlement chain and its
 * TokenNetwork/token/RPC parameters (or the genesis-seed fallback) — so
 * back-to-back CLI invocations skip the kind:10032 relay query, the
 * payment-peer pick, and the funded-chain `eth_call` probes.
 *
 * SAFETY MODEL — the cache holds only DISCOVERY results, never money state:
 *
 *   - The claim watermark (nonce/cumulative) lives in the client's
 *     `channels.json` and the #262 channel map, untouched by this cache;
 *     every paid write still resumes from the persisted cumulative.
 *   - Entries are keyed by relay-origin + identity pubkey + a fingerprint of
 *     every explicit env/config field that feeds topology resolution, so a
 *     changed relay, identity, or override can never hit a stale entry.
 *   - Entries expire after a TTL (default 15 min;
 *     `RIG_TOPOLOGY_TTL_MS` overrides, `0` disables the cache entirely).
 *   - A cached topology that fails to bootstrap is EXPLICITLY invalidated
 *     and re-resolved live (see `cli/standalone-mode.ts`), so a rotated peer
 *     endpoint costs one failed attempt, not a broken 15 minutes.
 *   - A corrupt/unreadable cache file is a MISS (discovery re-runs), never
 *     an error: unlike the #262 channel map, nothing here guards money.
 *
 * Dependency-light on purpose (node:crypto + node:fs): the cached value is a
 * generic JSON document; `cli/standalone-mode.ts` instantiates the class
 * with its `NetworkTopology` shape and a structural validator.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

/** Cache filename under the shared client state dir (`TOON_CLIENT_HOME`). */
export const TOPOLOGY_CACHE_FILENAME = 'rig-topology-cache.json';

/** Default entry TTL: 15 minutes. */
export const DEFAULT_TOPOLOGY_TTL_MS = 15 * 60 * 1000;

/** TTL env override (milliseconds; `0` disables caching entirely). */
export const TOPOLOGY_TTL_ENV = 'RIG_TOPOLOGY_TTL_MS';

/** Resolve the entry TTL: `RIG_TOPOLOGY_TTL_MS` env (>= 0), else 15 min. */
export function topologyCacheTtlMs(env: NodeJS.ProcessEnv): number {
  const raw = env[TOPOLOGY_TTL_ENV];
  if (raw === undefined || raw === '') return DEFAULT_TOPOLOGY_TTL_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_TOPOLOGY_TTL_MS;
}

/**
 * Stable cache key: relay-origin + identity pubkey + the explicit-config
 * fingerprint. Hashed so the key is filename/JSON-safe and the mnemonic-side
 * inputs never appear in the cache file verbatim.
 */
export function topologyCacheKey(args: {
  relayUrl: string;
  identity: string;
  fingerprint: string;
}): string {
  return createHash('sha256')
    .update(`${args.relayUrl}\n${args.identity}\n${args.fingerprint}`)
    .digest('hex');
}

/**
 * Canonical fingerprint of the explicit inputs that steer topology
 * resolution (see `resolveNetworkTopology`'s precedence order): the
 * TOON_CLIENT_* env overrides plus the shared-config fields. Any change
 * produces a different cache key — explicit config can never be shadowed by
 * a cached resolution made under different settings.
 */
export function explicitConfigFingerprint(
  env: NodeJS.ProcessEnv,
  file: Record<string, unknown>
): string {
  const envKeys = [
    'TOON_CLIENT_PROXY_URL',
    'TOON_CLIENT_BTP_URL',
    'TOON_CLIENT_DESTINATION',
    'TOON_CLIENT_PUBLISH_DESTINATION',
    'TOON_CLIENT_STORE_DESTINATION',
    'TOON_CLIENT_CHAIN',
    'TOON_CLIENT_NETWORK',
  ] as const;
  const fileKeys = [
    'network',
    'btpUrl',
    'proxyUrl',
    'destination',
    'publishDestination',
    'storeDestination',
    'chain',
    'supportedChains',
    'settlementAddresses',
    'preferredTokens',
    'tokenNetworks',
    'chainRpcUrls',
  ] as const;
  const picked: Record<string, unknown> = {};
  for (const key of envKeys) {
    if (env[key] !== undefined) picked[`env:${key}`] = env[key];
  }
  for (const key of fileKeys) {
    if (file[key] !== undefined) picked[`file:${key}`] = file[key];
  }
  // Keys are inserted in fixed order above → deterministic serialization.
  return JSON.stringify(picked);
}

interface CacheEntry {
  /** ISO timestamp the entry was written. */
  cachedAt: string;
  /** The cached (JSON-safe) topology document. */
  topology: unknown;
}

interface CacheFile {
  version: 1;
  entries: Record<string, CacheEntry>;
}

export interface TopologyCacheOptions<T> {
  /** Cache file path (under `TOON_CLIENT_HOME`). */
  path: string;
  /** Entry TTL in ms; `0` (or negative) disables reads AND writes. */
  ttlMs: number;
  /** Structural validator for cached values (a failed check is a miss). */
  validate: (value: unknown) => value is T;
  /** Clock override (tests). */
  now?: () => number;
}

/**
 * File-backed, TTL'd topology cache. All operations are best-effort and
 * synchronous; failures degrade to cache misses / no-ops (discovery is the
 * always-correct fallback).
 */
export class TopologyCache<T> {
  readonly path: string;
  readonly ttlMs: number;
  private readonly validate: (value: unknown) => value is T;
  private readonly now: () => number;

  constructor(options: TopologyCacheOptions<T>) {
    this.path = options.path;
    this.ttlMs = options.ttlMs;
    this.validate = options.validate;
    this.now = options.now ?? Date.now;
  }

  /** True when the cache is disabled (`RIG_TOPOLOGY_TTL_MS=0`). */
  get disabled(): boolean {
    return this.ttlMs <= 0;
  }

  /**
   * A fresh, structurally-valid entry for `key` — or undefined (expired,
   * missing, invalid, corrupt file, or disabled). Also reports the entry age
   * for the "topology from cache" stderr line.
   */
  read(key: string): { topology: T; ageMs: number } | undefined {
    if (this.disabled) return undefined;
    const entry = this.readFile().entries[key];
    if (!entry) return undefined;
    const cachedAt = Date.parse(entry.cachedAt);
    if (!Number.isFinite(cachedAt)) return undefined;
    const ageMs = this.now() - cachedAt;
    if (ageMs < 0 || ageMs > this.ttlMs) return undefined;
    if (!this.validate(entry.topology)) return undefined;
    return { topology: entry.topology, ageMs };
  }

  /** Persist `topology` under `key` (prunes expired entries; best-effort). */
  write(key: string, topology: T): void {
    if (this.disabled) return;
    try {
      const file = this.readFile();
      const nowMs = this.now();
      const fresh = Object.fromEntries(
        Object.entries(file.entries).filter(([, entry]) => {
          const at = Date.parse(entry.cachedAt);
          return Number.isFinite(at) && nowMs - at <= this.ttlMs;
        })
      );
      fresh[key] = {
        cachedAt: new Date(nowMs).toISOString(),
        topology,
      };
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(
        this.path,
        JSON.stringify(
          { version: 1, entries: fresh } satisfies CacheFile,
          null,
          2
        ),
        { mode: 0o600 }
      );
    } catch {
      // Best-effort — a failed write just means the next run discovers live.
    }
  }

  /** Drop `key` (a cached topology failed to bootstrap). Best-effort. */
  invalidate(key: string): void {
    try {
      const file = this.readFile();
      if (!(key in file.entries)) return;
      const remaining = Object.fromEntries(
        Object.entries(file.entries).filter(([k]) => k !== key)
      );
      if (Object.keys(remaining).length === 0) {
        unlinkSync(this.path);
        return;
      }
      writeFileSync(
        this.path,
        JSON.stringify(
          { version: 1, entries: remaining } satisfies CacheFile,
          null,
          2
        ),
        { mode: 0o600 }
      );
    } catch {
      // Best-effort — worst case the entry expires by TTL.
    }
  }

  private readFile(): CacheFile {
    const empty: CacheFile = { version: 1, entries: {} };
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch {
      return empty;
    }
    try {
      const parsed = JSON.parse(raw) as CacheFile;
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        parsed.version !== 1 ||
        typeof parsed.entries !== 'object' ||
        parsed.entries === null
      ) {
        return empty;
      }
      return parsed;
    } catch {
      return empty; // corrupt cache = miss, never an error (see module doc)
    }
  }
}
