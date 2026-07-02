/**
 * ChannelMapStore tests (#262): key-composition round-trips, corruption is a
 * HARD error (an empty fallback would silently re-open + re-fund a channel),
 * watermark seeding never clobbers real claim state, and close-status
 * derivation mirrors ChannelManager.getChannelCloseState.
 */

import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ChannelMapCorruptError,
  ChannelMapStore,
  channelStatus,
  recordKey,
  resolveChannelPaths,
  type ChannelMapRecord,
} from './channel-map.js';

const IDENTITY = 'a'.repeat(64);
const RECORD: Omit<ChannelMapRecord, 'openedAt' | 'lastUsedAt'> = {
  channelId: '0x' + '11'.repeat(32),
  peerId: 'nostr-2813187e',
  identity: IDENTITY,
  destination: 'g.proxy.relay.store',
  chain: 'evm:31337',
  tokenNetwork: '0x' + '22'.repeat(20),
  context: {
    chainType: 'evm',
    chainId: 31337,
    tokenNetworkAddress: '0x' + '22'.repeat(20),
    tokenAddress: '0x' + '33'.repeat(20),
    recipient: '0x' + '44'.repeat(20),
  },
  depositTotal: '100000',
};

describe('ChannelMapStore', () => {
  let dir: string;
  let store: ChannelMapStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rig-channel-map-'));
    store = new ChannelMapStore({
      mapPath: join(dir, 'rig-channels.json'),
      watermarkPath: join(dir, 'channels.json'),
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('a missing map file is an empty store (first run), not an error', () => {
    expect(store.list()).toEqual([]);
    expect(store.listFor(IDENTITY, 'g.proxy.relay.store')).toEqual([]);
  });

  it('record → listFor round-trips with timestamps', () => {
    store.record(RECORD);
    const [loaded] = store.listFor(IDENTITY, 'g.proxy.relay.store');
    expect(loaded).toMatchObject(RECORD);
    expect(loaded?.openedAt).toBeTruthy();
    expect(loaded?.lastUsedAt).toBeTruthy();
  });

  it('keys by identity + destination + chain + tokenNetwork', () => {
    store.record(RECORD);
    store.record({ ...RECORD, identity: 'b'.repeat(64), channelId: '0xother' });
    store.record({ ...RECORD, chain: 'solana:devnet', channelId: '0xsol' });
    store.record({
      ...RECORD,
      destination: 'g.other',
      channelId: '0xelsewhere',
    });

    expect(store.list()).toHaveLength(4);
    const forIdentity = store.listFor(IDENTITY, 'g.proxy.relay.store');
    expect(forIdentity.map((r) => r.channelId).sort()).toEqual(
      [RECORD.channelId, '0xsol'].sort()
    );
  });

  it('re-recording the same key overwrites (fresh channel replaces stale)', () => {
    store.record(RECORD);
    store.record({ ...RECORD, channelId: '0xreplacement' });
    const records = store.listFor(IDENTITY, 'g.proxy.relay.store');
    expect(records).toHaveLength(1);
    expect(records[0]?.channelId).toBe('0xreplacement');
  });

  it('touch bumps lastUsedAt (and optionally deposit) but keeps openedAt', () => {
    store.record({ ...RECORD, openedAt: '2026-01-01T00:00:00.000Z' });
    const [before] = store.list();
    if (!before) throw new Error('record missing');
    store.touch(recordKey(before), { depositTotal: '250000' });
    const [after] = store.list();
    if (!after) throw new Error('record missing');
    expect(after.openedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(after.depositTotal).toBe('250000');
    expect(after.lastUsedAt >= before.lastUsedAt).toBe(true);
    // Unknown key: no-op, no throw.
    store.touch({ ...recordKey(before), chain: 'nope' });
  });

  describe('corruption is a hard error (never a silent duplicate open)', () => {
    it.each([
      ['invalid JSON', 'not-json{'],
      ['wrong shape', JSON.stringify({ hello: 'world' })],
      ['unsupported version', JSON.stringify({ version: 2, channels: {} })],
      [
        'malformed entry',
        JSON.stringify({ version: 1, channels: { k: { channelId: 42 } } }),
      ],
    ])('%s → ChannelMapCorruptError on read AND write', (_label, contents) => {
      writeFileSync(join(dir, 'rig-channels.json'), contents);
      expect(() => store.list()).toThrow(ChannelMapCorruptError);
      expect(() => store.record(RECORD)).toThrow(ChannelMapCorruptError);
      expect(() => store.list()).toThrow(/refusing to continue/);
    });

    it('a corrupt watermark file is also a hard error', () => {
      writeFileSync(join(dir, 'channels.json'), '{{{');
      expect(() => store.readWatermark('0xabc')).toThrow(
        ChannelMapCorruptError
      );
    });
  });

  describe('watermark access', () => {
    it('reads entries from the client channels.json format', () => {
      writeFileSync(
        join(dir, 'channels.json'),
        JSON.stringify({
          '0xabc': { nonce: 15, cumulativeAmount: '16120' },
        })
      );
      expect(store.readWatermark('0xabc')).toEqual({
        nonce: 15,
        cumulativeAmount: '16120',
      });
      expect(store.readWatermark('0xmissing')).toBeUndefined();
    });

    it('seedWatermark creates 0/0 entries and NEVER overwrites claim state', () => {
      store.seedWatermark('0xfresh');
      expect(store.readWatermark('0xfresh')).toEqual({
        nonce: 0,
        cumulativeAmount: '0',
      });

      writeFileSync(
        join(dir, 'channels.json'),
        JSON.stringify({ '0xused': { nonce: 7, cumulativeAmount: '4711' } })
      );
      store.seedWatermark('0xused');
      expect(store.readWatermark('0xused')).toEqual({
        nonce: 7,
        cumulativeAmount: '4711',
      });
    });
  });

  it('writes the map file with owner-only permissions (0600)', () => {
    if (process.platform === 'win32') return; // POSIX modes only
    store.record(RECORD);
    const mode = statSync(join(dir, 'rig-channels.json')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('map file is human-readable versioned JSON', () => {
    store.record(RECORD);
    const parsed = JSON.parse(
      readFileSync(join(dir, 'rig-channels.json'), 'utf8')
    ) as { version: number; channels: Record<string, unknown> };
    expect(parsed.version).toBe(1);
    expect(Object.keys(parsed.channels)).toEqual([
      `${IDENTITY}|g.proxy.relay.store|evm:31337|${RECORD.tokenNetwork}`,
    ]);
  });
});

describe('channelStatus', () => {
  it('derives the withdraw-journey status like getChannelCloseState', () => {
    expect(channelStatus(undefined)).toBe('open');
    expect(channelStatus({ nonce: 1, cumulativeAmount: '5' })).toBe('open');
    expect(
      channelStatus(
        { nonce: 1, cumulativeAmount: '5', closedAt: '100', settleableAt: '200' },
        150
      )
    ).toBe('closing');
    expect(
      channelStatus(
        { nonce: 1, cumulativeAmount: '5', closedAt: '100', settleableAt: '200' },
        200
      )
    ).toBe('settleable');
    expect(
      channelStatus(
        {
          nonce: 1,
          cumulativeAmount: '5',
          closedAt: '100',
          settleableAt: '200',
          settledAt: '300',
        },
        400
      )
    ).toBe('settled');
  });
});

describe('resolveChannelPaths', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rig-channel-paths-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('defaults both files under TOON_CLIENT_HOME', () => {
    expect(resolveChannelPaths({ TOON_CLIENT_HOME: dir })).toEqual({
      mapPath: join(dir, 'rig-channels.json'),
      watermarkPath: join(dir, 'channels.json'),
    });
  });

  it('honours config.json channelStorePath for the watermark file', () => {
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ channelStorePath: '/elsewhere/channels.json' })
    );
    expect(resolveChannelPaths({ TOON_CLIENT_HOME: dir }).watermarkPath).toBe(
      '/elsewhere/channels.json'
    );
  });

  it('throws on an unreadable config.json (matches standalone-mode)', () => {
    writeFileSync(join(dir, 'config.json'), '{broken');
    expect(() => resolveChannelPaths({ TOON_CLIENT_HOME: dir })).toThrow(
      /failed to read client config/
    );
  });
});
