/**
 * Topology-cache tests (#279): TTL freshness/expiry, keying (relay-set +
 * identity + explicit-config fingerprint), corrupt-file-is-a-miss, explicit
 * invalidation, disabled mode, and the env TTL override.
 */

import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_TOPOLOGY_TTL_MS,
  TOPOLOGY_TTL_ENV,
  TopologyCache,
  explicitConfigFingerprint,
  topologyCacheKey,
  topologyCacheTtlMs,
} from './topology-cache.js';

interface FakeTopology {
  destination: string;
  knownPeers: unknown[];
}

const TOPO: FakeTopology = {
  destination: 'g.proxy.relay.store',
  knownPeers: [],
};

const isFakeTopology = (v: unknown): v is FakeTopology =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as FakeTopology).destination === 'string' &&
  Array.isArray((v as FakeTopology).knownPeers);

describe('topologyCacheTtlMs', () => {
  it('defaults to 15 minutes and honors the env override (0 disables)', () => {
    expect(topologyCacheTtlMs({})).toBe(DEFAULT_TOPOLOGY_TTL_MS);
    expect(topologyCacheTtlMs({ [TOPOLOGY_TTL_ENV]: '60000' })).toBe(60000);
    expect(topologyCacheTtlMs({ [TOPOLOGY_TTL_ENV]: '0' })).toBe(0);
    expect(topologyCacheTtlMs({ [TOPOLOGY_TTL_ENV]: 'junk' })).toBe(
      DEFAULT_TOPOLOGY_TTL_MS
    );
    expect(topologyCacheTtlMs({ [TOPOLOGY_TTL_ENV]: '-5' })).toBe(
      DEFAULT_TOPOLOGY_TTL_MS
    );
  });
});

describe('topologyCacheKey / explicitConfigFingerprint', () => {
  const base = {
    relayUrl: 'wss://relay.example',
    identity: 'ab'.repeat(32),
    fingerprint: '{}',
  };

  it('changes with relay, identity, and fingerprint (and only those)', () => {
    const key = topologyCacheKey(base);
    expect(topologyCacheKey(base)).toBe(key);
    expect(
      topologyCacheKey({ ...base, relayUrl: 'wss://other.example' })
    ).not.toBe(key);
    expect(topologyCacheKey({ ...base, identity: 'cd'.repeat(32) })).not.toBe(
      key
    );
    expect(topologyCacheKey({ ...base, fingerprint: '{"a":1}' })).not.toBe(key);
  });

  it('fingerprints every explicit topology input (env + file), nothing else', () => {
    const empty = explicitConfigFingerprint({}, {});
    expect(explicitConfigFingerprint({ HOME: '/x', PATH: '/y' }, {})).toBe(
      empty
    );
    expect(
      explicitConfigFingerprint({ TOON_CLIENT_CHAIN: 'evm:31337' }, {})
    ).not.toBe(empty);
    expect(explicitConfigFingerprint({}, { proxyUrl: 'https://p' })).not.toBe(
      empty
    );
    expect(
      explicitConfigFingerprint({}, { tokenNetworks: { 'evm:31337': '0x1' } })
    ).not.toBe(empty);
    // Non-topology file fields (fee, keystore) do not churn the key.
    expect(
      explicitConfigFingerprint({}, { feePerEvent: '5', keystorePath: '/k' })
    ).toBe(empty);
  });
});

describe('TopologyCache', () => {
  let dir: string;
  let path: string;
  let now: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rig-topo-cache-'));
    path = join(dir, 'rig-topology-cache.json');
    now = Date.parse('2026-07-01T12:00:00Z');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeCache(ttlMs = 15 * 60 * 1000): TopologyCache<FakeTopology> {
    return new TopologyCache<FakeTopology>({
      path,
      ttlMs,
      validate: isFakeTopology,
      now: () => now,
    });
  }

  it('round-trips a fresh entry and reports its age', () => {
    const cache = makeCache();
    cache.write('k1', TOPO);
    now += 30_000;
    expect(cache.read('k1')).toEqual({ topology: TOPO, ageMs: 30_000 });
    expect(cache.read('other-key')).toBeUndefined();
  });

  it('expires entries past the TTL', () => {
    const cache = makeCache(60_000);
    cache.write('k1', TOPO);
    now += 60_001;
    expect(cache.read('k1')).toBeUndefined();
  });

  it('prunes expired entries on write (no unbounded growth)', () => {
    const cache = makeCache(60_000);
    cache.write('old', TOPO);
    now += 120_000;
    cache.write('new', TOPO);
    const file = JSON.parse(readFileSync(path, 'utf8')) as {
      entries: Record<string, unknown>;
    };
    expect(Object.keys(file.entries)).toEqual(['new']);
  });

  it('treats a corrupt cache file as a miss, never an error', () => {
    writeFileSync(path, 'not-json{');
    const cache = makeCache();
    expect(cache.read('k1')).toBeUndefined();
    // …and a subsequent write recovers the file.
    cache.write('k1', TOPO);
    expect(cache.read('k1')?.topology).toEqual(TOPO);
  });

  it('rejects structurally-invalid cached values (validator miss)', () => {
    const cache = makeCache();
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        entries: {
          k1: {
            cachedAt: new Date(now).toISOString(),
            topology: { nope: true },
          },
        },
      })
    );
    expect(cache.read('k1')).toBeUndefined();
  });

  it('invalidate() drops exactly one key (file removed when empty)', () => {
    const cache = makeCache();
    cache.write('k1', TOPO);
    cache.write('k2', { ...TOPO, destination: 'g.other' });
    cache.invalidate('k1');
    expect(cache.read('k1')).toBeUndefined();
    expect(cache.read('k2')?.topology.destination).toBe('g.other');
    cache.invalidate('k2');
    expect(existsSync(path)).toBe(false);
  });

  it('ttl 0 disables reads and writes entirely', () => {
    const cache = makeCache(0);
    expect(cache.disabled).toBe(true);
    cache.write('k1', TOPO);
    expect(existsSync(path)).toBe(false);
    expect(cache.read('k1')).toBeUndefined();
  });
});
