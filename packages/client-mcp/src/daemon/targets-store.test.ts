import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadTargets,
  removeApexTarget,
  removeRelayTarget,
  saveApexTarget,
  saveRelayTarget,
  type PersistedApexTarget,
} from './targets-store.js';

let dir: string;
let path: string;

const apex: PersistedApexTarget = {
  btpUrl: 'ws://apex2.test/btp',
  negotiation: {
    destination: 'g.other.town',
    peerId: 'town',
    chain: 'evm',
    chainKey: 'evm:base:84532',
    chainId: 84532,
    settlementAddress: '0xabc',
  },
  apexChildPeers: ['store'],
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'toon-targets-'));
  path = join(dir, 'targets.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('targets-store', () => {
  it('returns empty arrays when the file is absent', () => {
    expect(loadTargets(path)).toEqual({ relays: [], apexes: [] });
  });

  it('saves + loads a relay target (idempotent)', () => {
    saveRelayTarget('ws://r1.test', path);
    saveRelayTarget('ws://r1.test', path); // dup is a no-op
    saveRelayTarget('ws://r2.test', path);
    expect(loadTargets(path).relays).toEqual([
      { relayUrl: 'ws://r1.test' },
      { relayUrl: 'ws://r2.test' },
    ]);
  });

  it('removes a relay target and reports presence', () => {
    saveRelayTarget('ws://r1.test', path);
    expect(removeRelayTarget('ws://r1.test', path)).toBe(true);
    expect(removeRelayTarget('ws://r1.test', path)).toBe(false);
    expect(loadTargets(path).relays).toEqual([]);
  });

  it('saves an apex (last-write-wins) and removes it', () => {
    saveApexTarget(apex, path);
    saveApexTarget({ ...apex, feePerEvent: '5' }, path); // upsert
    const store = loadTargets(path);
    expect(store.apexes).toHaveLength(1);
    expect(store.apexes[0]!.feePerEvent).toBe('5');
    expect(removeApexTarget(apex.btpUrl, path)).toBe(true);
    expect(loadTargets(path).apexes).toEqual([]);
  });

  it('persists relays and apexes independently in one file', () => {
    saveRelayTarget('ws://r1.test', path);
    saveApexTarget(apex, path);
    const store = loadTargets(path);
    expect(store.relays).toHaveLength(1);
    expect(store.apexes).toHaveLength(1);
  });
});
