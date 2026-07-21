/**
 * Mina zkApp store tests: round-trip, keying (`identity|chain`), 0600 mode,
 * read-merge-write, ENOENT → empty, corrupt file → actionable error.
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MinaZkAppStore, type RigMinaZkAppRecord } from './mina-zkapp-store.js';

const RECORD: RigMinaZkAppRecord = {
  identity: 'a'.repeat(64),
  chain: 'mina:devnet',
  zkAppAddress: 'B62qFRESH',
  zkAppPrivateKey: 'EKFRESH',
  feePayer: 'B62qPAYER',
  deployTxHash: '5Ju…tx',
  vkHash: '2148…vk',
  deployedAt: '2026-07-21T00:00:00.000Z',
  source: 'test',
};

describe('MinaZkAppStore', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'rig-zkapp-store-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('round-trips a record keyed by identity|chain, file mode 0600', () => {
    const store = MinaZkAppStore.forHome(home);
    expect(store.lookup(RECORD.identity, RECORD.chain)).toBeUndefined();
    store.save(RECORD);
    expect(store.lookup(RECORD.identity, RECORD.chain)).toEqual(RECORD);
    // Wrong identity or chain → no hit.
    expect(store.lookup('b'.repeat(64), RECORD.chain)).toBeUndefined();
    expect(store.lookup(RECORD.identity, 'mina:mainnet')).toBeUndefined();
    // The file holds a private key → owner-only.
    const mode = statSync(store.filePath).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(store.filePath).toBe(join(home, 'keys', 'rig-mina-zkapps.json'));
  });

  it('read-merge-write preserves other identities/chains', () => {
    const store = MinaZkAppStore.forHome(home);
    store.save(RECORD);
    const other = { ...RECORD, chain: 'mina:mainnet', zkAppAddress: 'B62qOTHER' };
    store.save(other);
    expect(store.lookup(RECORD.identity, 'mina:devnet')?.zkAppAddress).toBe('B62qFRESH');
    expect(store.lookup(RECORD.identity, 'mina:mainnet')?.zkAppAddress).toBe('B62qOTHER');
    // Same key overwrites (one live deployment per identity/chain).
    store.save({ ...RECORD, zkAppAddress: 'B62qREPLACED' });
    const all = JSON.parse(readFileSync(store.filePath, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(all)).toHaveLength(2);
    expect(store.lookup(RECORD.identity, 'mina:devnet')?.zkAppAddress).toBe('B62qREPLACED');
  });

  it('a corrupt store file surfaces an actionable error (never silent loss)', () => {
    const store = MinaZkAppStore.forHome(home);
    mkdirSync(join(home, 'keys'), { recursive: true });
    writeFileSync(store.filePath, 'not-json');
    expect(() => store.lookup(RECORD.identity, RECORD.chain)).toThrow(
      /failed to read the Mina zkApp store/
    );
    expect(() => store.save(RECORD)).toThrow(/failed to read/);
  });
});
