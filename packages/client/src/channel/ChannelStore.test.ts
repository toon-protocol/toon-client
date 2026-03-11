import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JsonFileChannelStore } from './ChannelStore.js';

describe('JsonFileChannelStore', () => {
  let filePath: string;
  let store: JsonFileChannelStore;

  beforeEach(() => {
    filePath = join(tmpdir(), `channel-store-test-${Date.now()}.json`);
    store = new JsonFileChannelStore(filePath);
  });

  afterEach(() => {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  });

  describe('save and load', () => {
    it('should save and load channel state', () => {
      const channelId = '0x' + 'aa'.repeat(32);
      store.save(channelId, { nonce: 5, cumulativeAmount: 12345n });

      const loaded = store.load(channelId);
      expect(loaded).toEqual({ nonce: 5, cumulativeAmount: 12345n });
    });

    it('should return undefined for unknown channel', () => {
      expect(store.load('0x' + 'ff'.repeat(32))).toBeUndefined();
    });

    it('should preserve bigint precision for large amounts', () => {
      const channelId = '0x' + 'bb'.repeat(32);
      const largeAmount = 9007199254740993n; // > Number.MAX_SAFE_INTEGER
      store.save(channelId, { nonce: 1, cumulativeAmount: largeAmount });

      const loaded = store.load(channelId);
      expect(loaded!.cumulativeAmount).toBe(largeAmount);
    });

    it('should overwrite existing state on save', () => {
      const channelId = '0x' + 'cc'.repeat(32);
      store.save(channelId, { nonce: 1, cumulativeAmount: 100n });
      store.save(channelId, { nonce: 3, cumulativeAmount: 500n });

      const loaded = store.load(channelId);
      expect(loaded).toEqual({ nonce: 3, cumulativeAmount: 500n });
    });
  });

  describe('list', () => {
    it('should return empty array when no channels stored', () => {
      expect(store.list()).toEqual([]);
    });

    it('should return all stored channel IDs', () => {
      const ch1 = '0x' + '11'.repeat(32);
      const ch2 = '0x' + '22'.repeat(32);
      store.save(ch1, { nonce: 1, cumulativeAmount: 100n });
      store.save(ch2, { nonce: 2, cumulativeAmount: 200n });

      expect(store.list()).toContain(ch1);
      expect(store.list()).toContain(ch2);
      expect(store.list()).toHaveLength(2);
    });
  });

  describe('delete', () => {
    it('should remove a channel entry', () => {
      const channelId = '0x' + 'dd'.repeat(32);
      store.save(channelId, { nonce: 1, cumulativeAmount: 100n });
      store.delete(channelId);

      expect(store.load(channelId)).toBeUndefined();
    });

    it('should not throw when deleting non-existent channel', () => {
      expect(() => store.delete('0x' + 'ee'.repeat(32))).not.toThrow();
    });
  });

  describe('persistence across instances', () => {
    it('should persist data across store instances', () => {
      const channelId = '0x' + 'ff'.repeat(32);
      store.save(channelId, { nonce: 10, cumulativeAmount: 99999n });

      // Create a new store instance pointing at the same file
      const store2 = new JsonFileChannelStore(filePath);
      const loaded = store2.load(channelId);
      expect(loaded).toEqual({ nonce: 10, cumulativeAmount: 99999n });
    });
  });
});
