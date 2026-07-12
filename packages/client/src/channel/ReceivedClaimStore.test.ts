import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JsonFileReceivedClaimStore,
  InMemoryReceivedClaimStore,
  type ReceivedClaimEntry,
} from './ReceivedClaimStore.js';

const PAIR = {
  from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:base:84532' },
  to: { assetCode: 'USDC', assetScale: 6, chain: 'evm:anvil:31337' },
  rate: '1.0',
};

function entry(over: Partial<ReceivedClaimEntry> = {}): ReceivedClaimEntry {
  return {
    chain: 'evm:anvil:31337',
    channelId: '0x' + '11'.repeat(32),
    nonce: 3n,
    cumulativeAmount: 123456789012345678901234567890n, // > 2^64: bigint precision matters
    recipient: '0x' + 'aa'.repeat(20),
    swapSignerAddress: '0x' + 'bb'.repeat(20),
    claimBytes: new Uint8Array([1, 2, 3, 255]),
    claimId: 'claim-3',
    pair: PAIR,
    receivedAt: 1111,
    updatedAt: 2222,
    ...over,
  };
}

describe('JsonFileReceivedClaimStore', () => {
  let dir: string;
  let path: string;
  let store: JsonFileReceivedClaimStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'received-claims-'));
    path = join(dir, 'nested', 'received-claims.json');
    store = new JsonFileReceivedClaimStore(path);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('round-trips an entry losslessly (bigints, bytes, optionals)', () => {
    const e = entry({
      settledAt: 3333,
      settledNonce: 2n,
      settleTxHash: '0xdead',
    });
    store.save(e);
    const loaded = store.load(e.chain, e.channelId);
    expect(loaded).toEqual(e);
    expect(loaded!.nonce).toBe(3n);
    expect(loaded!.cumulativeAmount).toBe(123456789012345678901234567890n);
    expect(loaded!.claimBytes).toEqual(new Uint8Array([1, 2, 3, 255]));
    expect(loaded!.settledNonce).toBe(2n);
  });

  it('creates the parent directory on first save', () => {
    expect(existsSync(path)).toBe(false);
    store.save(entry());
    expect(existsSync(path)).toBe(true);
  });

  it('keys by (chain, channelId): same channel id on two chains coexists', () => {
    store.save(entry({ chain: 'evm:anvil:31337', nonce: 1n }));
    store.save(entry({ chain: 'solana:devnet', nonce: 9n }));
    expect(store.load('evm:anvil:31337', entry().channelId)!.nonce).toBe(1n);
    expect(store.load('solana:devnet', entry().channelId)!.nonce).toBe(9n);
    expect(store.list()).toHaveLength(2);
  });

  it('save overwrites the previous watermark for the same key', () => {
    store.save(entry({ nonce: 1n, cumulativeAmount: 100n }));
    store.save(entry({ nonce: 2n, cumulativeAmount: 200n }));
    expect(store.list()).toHaveLength(1);
    expect(store.load(entry().chain, entry().channelId)!.cumulativeAmount).toBe(200n);
  });

  it('survives a restart: a FRESH instance reads what the first wrote', () => {
    store.save(entry());
    const second = new JsonFileReceivedClaimStore(path);
    expect(second.load(entry().chain, entry().channelId)).toEqual(entry());
  });

  it('delete removes exactly one key; load on missing returns undefined', () => {
    store.save(entry());
    store.delete(entry().chain, entry().channelId);
    expect(store.load(entry().chain, entry().channelId)).toBeUndefined();
    expect(store.list()).toHaveLength(0);
  });
});

describe('InMemoryReceivedClaimStore', () => {
  it('round-trips and isolates callers from internal state (copies)', () => {
    const store = new InMemoryReceivedClaimStore();
    const e = entry();
    store.save(e);
    const loaded = store.load(e.chain, e.channelId)!;
    expect(loaded).toEqual(e);
    loaded.nonce = 999n; // mutating the copy must not corrupt the store
    expect(store.load(e.chain, e.channelId)!.nonce).toBe(3n);
    store.delete(e.chain, e.channelId);
    expect(store.list()).toHaveLength(0);
  });
});
