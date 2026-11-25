import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  InMemoryChannelStore,
  JsonFileChannelStore,
  type ChannelStore,
  type ChannelStoreEntry,
  type BatchSettlementBinding,
} from './ChannelStore.js';
import {
  BatchChannelManager,
  type BatchChannel,
} from './batch-settlement/manager.js';
import { STORED_FORMS } from './batch-settlement/stored-forms.test-support.js';

const CONNECTOR = 'https://node.example';
const TOKEN = '0x5555555555555555555555555555555555555555';

const config: BatchSettlementBinding = {
  chain: 'evm',
  network: 'eip155:84532',
  config: {
    payer: '0x1111111111111111111111111111111111111111',
    payerAuthorizer: '0x2222222222222222222222222222222222222222',
    receiver: '0x3333333333333333333333333333333333333333',
    receiverAuthorizer: '0x3333333333333333333333333333333333333333',
    token: TOKEN,
    withdrawDelay: 86_400,
    salt: `0x${'66'.repeat(32)}`,
  },
};

function entry(
  channelId: string,
  over: Partial<ChannelStoreEntry> = {}
): ChannelStoreEntry {
  return {
    channelId,
    connector: CONNECTOR,
    batchSettlement: config,
    depositTotal: 1_000n,
    cumulativeAmount: 0n,
    ...over,
  };
}

const A = '0x' + 'aa'.repeat(32);
const B = '0x' + 'bb'.repeat(32);

function tmpPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'channel-store-')), 'channels.json');
}

const stores: [string, () => ChannelStore][] = [
  ['InMemoryChannelStore', () => new InMemoryChannelStore()],
  ['JsonFileChannelStore', () => new JsonFileChannelStore(tmpPath())],
];

describe.each(stores)('%s', (_name, make) => {
  it('round-trips a whole record, bigints included', () => {
    const store = make();
    const e = entry(A, {
      depositTotal: 2n ** 80n,
      pendingDeposit: 5n,
      cumulativeAmount: 12_345n,
      signedCeiling: 20_000n,
      provenFloor: 10_000n,
      watermarkUncertain: true,
      lastVoucher: '{"v":1}',
      lastVoucherAmount: 12_345n,
      closedAt: 1n,
      settleableAt: 2n,
      settledAt: 3n,
      openedAt: '2026-11-01T00:00:00.000Z',
    });
    store.save(e);
    expect(store.load(A)).toEqual(e);
  });

  it('loads nothing for an unknown channel, and deletes it without complaint', () => {
    const store = make();
    expect(store.load(A)).toBeUndefined();
    expect(() => store.delete(A)).not.toThrow();
  });

  it('finds the live channel by connector, network and asset', () => {
    const store = make();
    store.save(entry(A));
    expect(store.find(CONNECTOR, 'eip155:84532', TOKEN)?.channelId).toBe(A);
    // EVM addresses are case-insensitive.
    expect(
      store.find(
        CONNECTOR,
        'eip155:84532',
        TOKEN.toUpperCase().replace('0X', '0x')
      )?.channelId
    ).toBe(A);
    expect(store.find(CONNECTOR, 'eip155:8453', TOKEN)).toBeUndefined();
    expect(
      store.find('https://other.example', 'eip155:84532', TOKEN)
    ).toBeUndefined();
  });

  it('keeps a retired channel in the list but not in find', () => {
    const store = make();
    store.save(entry(A));
    store.save({ ...entry(A), supersededAt: '2026-11-02T00:00:00.000Z' });
    store.save(entry(B));
    expect(store.find(CONNECTOR, 'eip155:84532', TOKEN)?.channelId).toBe(B);
    expect(
      store
        .list()
        .map((e) => e.channelId)
        .sort()
    ).toEqual([A, B]);
  });

  it('deletes a record', () => {
    const store = make();
    store.save(entry(A));
    store.delete(A);
    expect(store.load(A)).toBeUndefined();
    expect(store.find(CONNECTOR, 'eip155:84532', TOKEN)).toBeUndefined();
  });
});

describe('JsonFileChannelStore', () => {
  it('persists across instances, with cumulativeAmount under the channel id for rig', () => {
    const path = tmpPath();
    new JsonFileChannelStore(path).save(
      entry(A, { cumulativeAmount: 99_999n })
    );
    expect(new JsonFileChannelStore(path).load(A)?.cumulativeAmount).toBe(
      99_999n
    );
    const file = JSON.parse(readFileSync(path, 'utf-8')) as Record<
      string,
      { cumulativeAmount: string }
    >;
    expect(file[A]?.cumulativeAmount).toBe('99999');
  });

  describe('a store written by the current release', () => {
    const CHANNEL: BatchChannel = {
      chain: 'evm',
      channelId: A,
      network: 'eip155:84532',
      config: {
        ...(config.config as Omit<
          (typeof config & { chain: 'evm' })['config'],
          'salt'
        >),
        salt: `0x${'66'.repeat(32)}`,
      },
    };

    /** The two files as that release wrote them, `nonce` and binding context included. */
    function legacyFixture(): string {
      const path = tmpPath();
      writeFileSync(
        path,
        JSON.stringify({
          [A]: {
            nonce: 0,
            cumulativeAmount: '3000',
            signedCeiling: '3000',
            provenFloor: '1000',
          },
          [B]: { nonce: 7, cumulativeAmount: '50' },
        })
      );
      writeFileSync(
        path.replace('.json', '.peers.json'),
        JSON.stringify({
          [`batch|${CONNECTOR}|eip155:84532|${TOKEN}`]: {
            channelId: A,
            context: {
              chainType: 'evm',
              chainId: 84532,
              tokenNetworkAddress: '0x0000000000000000000000000000000000000000',
              tokenAddress: TOKEN,
              recipient: config.config.receiver,
            },
            depositTotal: '10000',
            openedAt: '2026-10-01T00:00:00.000Z',
            batchSettlement: config,
            lastVoucher: '{"v":3000}',
            lastVoucherAmount: '3000',
          },
          [`batch|${CONNECTOR}|eip155:84532|${TOKEN}|superseded:0xold`]: {
            channelId: '0xold',
            context: {
              chainType: 'evm',
              chainId: 84532,
              tokenNetworkAddress: '0x0',
            },
            depositTotal: '5',
            supersededAt: '2026-09-01T00:00:00.000Z',
            batchSettlement: config,
          },
        })
      );
      return path;
    }

    it('loads, pays and exits', () => {
      const path = legacyFixture();
      const m = new BatchChannelManager(
        STORED_FORMS,
        new JsonFileChannelStore(path)
      );
      expect(m.resolve(CONNECTOR, 'eip155:84532', TOKEN)).toEqual(CHANNEL);
      expect(m.depositTotal(A)).toBe(10_000n);
      expect(m.lastVoucher(A)).toBe('{"v":3000}');
      expect(m.hasWatermark(A)).toBe(true);
      // pays
      expect(m.reserve(A, 1_000n)).toBe(4_000n);
      // exits
      m.markClosing(A, 100n, 200n);
      expect(m.isClosing(A)).toBe(true);
      // The retired channel still holds a deposit, so it is still one to leave.
      expect(m.openChannels(CONNECTOR).map((c) => c.channelId)).toEqual([
        '0xold',
      ]);
      m.markSettled(A, 300n);
      expect(
        m
          .channels(CONNECTOR)
          .map((c) => c.channel.channelId)
          .sort()
      ).toEqual(['0xold', A].sort());
    });

    it('migrates to one file, drops legacy fields, and keeps cumulativeAmount under the channel id', () => {
      const path = legacyFixture();
      const peers = path.replace('.json', '.peers.json');
      const store = new JsonFileChannelStore(path);
      store.save({ ...store.load(A)!, cumulativeAmount: 4_000n });
      expect(existsSync(peers)).toBe(false);
      expect(existsSync(`${peers}.migrated`)).toBe(true);
      const file = JSON.parse(readFileSync(path, 'utf-8')) as Record<
        string,
        Record<string, unknown>
      >;
      expect(file[A]?.cumulativeAmount).toBe('4000');
      expect(file[A]).not.toHaveProperty('nonce');
      expect(file[A]).not.toHaveProperty('context');
      expect(JSON.stringify(file)).not.toContain('nonce');
      // The retired channel stays findable, and is not live.
      expect(store.load('0xold')?.supersededAt).toBeDefined();
      expect(store.find(CONNECTOR, 'eip155:84532', TOKEN)?.channelId).toBe(A);
    });

    it('marks a binding with no watermark entry as lost', () => {
      const path = tmpPath();
      writeFileSync(
        path.replace('.json', '.peers.json'),
        JSON.stringify({
          [`batch|${CONNECTOR}|eip155:84532|${TOKEN}`]: {
            channelId: A,
            context: {
              chainType: 'evm',
              chainId: 84532,
              tokenNetworkAddress: '0x0',
            },
            depositTotal: '10000',
            batchSettlement: config,
          },
        })
      );
      const m = new BatchChannelManager(
        STORED_FORMS,
        new JsonFileChannelStore(path)
      );
      expect(m.hasWatermark(A)).toBe(false);
      m.restoreWatermark(A, 4_000n);
      expect(m.hasWatermark(A)).toBe(true);
      expect(m.reserve(A, 1n)).toBe(4_001n);
    });
  });
});
