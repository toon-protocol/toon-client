import { describe, it, expect, beforeEach, vi } from 'vitest';
import { generatePrivateKey } from 'viem/accounts';
import { EvmSigner } from '../signing/evm-signer.js';
import { ChannelManager } from './ChannelManager.js';
import type { ChannelStore } from './ChannelStore.js';

describe('ChannelManager', () => {
  let signer: EvmSigner;
  let manager: ChannelManager;
  const CHANNEL_ID = '0x' + 'aa'.repeat(32);

  beforeEach(() => {
    signer = new EvmSigner(generatePrivateKey());
    manager = new ChannelManager(signer);
  });

  describe('trackChannel', () => {
    it('should initialize channel state with defaults', () => {
      manager.trackChannel(CHANNEL_ID);

      expect(manager.isTracking(CHANNEL_ID)).toBe(true);
      expect(manager.getNonce(CHANNEL_ID)).toBe(0);
      expect(manager.getCumulativeAmount(CHANNEL_ID)).toBe(0n);
    });

    it('should initialize with custom nonce and amount', () => {
      manager.trackChannel(CHANNEL_ID, undefined, 5, 10000n);

      expect(manager.getNonce(CHANNEL_ID)).toBe(5);
      expect(manager.getCumulativeAmount(CHANNEL_ID)).toBe(10000n);
    });

    it('should accept chain context', () => {
      manager.trackChannel(CHANNEL_ID, { chainId: 421614, tokenNetworkAddress: '0x91d62b1F7C5d1129A64EE3915c480DBF288B1cBa' });

      expect(manager.isTracking(CHANNEL_ID)).toBe(true);
    });
  });

  describe('signBalanceProof', () => {
    it('should increment nonce monotonically', async () => {
      manager.trackChannel(CHANNEL_ID);

      await manager.signBalanceProof(CHANNEL_ID, 100n);
      expect(manager.getNonce(CHANNEL_ID)).toBe(1);

      await manager.signBalanceProof(CHANNEL_ID, 100n);
      expect(manager.getNonce(CHANNEL_ID)).toBe(2);

      await manager.signBalanceProof(CHANNEL_ID, 100n);
      expect(manager.getNonce(CHANNEL_ID)).toBe(3);
    });

    it('should accumulate amount correctly', async () => {
      manager.trackChannel(CHANNEL_ID);

      await manager.signBalanceProof(CHANNEL_ID, 100n);
      expect(manager.getCumulativeAmount(CHANNEL_ID)).toBe(100n);

      await manager.signBalanceProof(CHANNEL_ID, 250n);
      expect(manager.getCumulativeAmount(CHANNEL_ID)).toBe(350n);

      await manager.signBalanceProof(CHANNEL_ID, 50n);
      expect(manager.getCumulativeAmount(CHANNEL_ID)).toBe(400n);
    });

    it('should return a valid signed balance proof', async () => {
      manager.trackChannel(CHANNEL_ID);

      const proof = await manager.signBalanceProof(CHANNEL_ID, 1000n);

      expect(proof.channelId).toBe(CHANNEL_ID);
      expect(proof.nonce).toBe(1);
      expect(proof.transferredAmount).toBe(1000n);
      expect(proof.lockedAmount).toBe(0n);
      expect(proof.signature).toMatch(/^0x[0-9a-fA-F]+$/);
      expect(proof.signerAddress).toBe(signer.address);
    });

    it('should throw for untracked channel', async () => {
      await expect(
        manager.signBalanceProof('0x' + 'ff'.repeat(32), 100n)
      ).rejects.toThrow('not being tracked');
    });
  });

  describe('getTrackedChannels', () => {
    it('should return empty array when no channels tracked', () => {
      expect(manager.getTrackedChannels()).toEqual([]);
    });

    it('should return all tracked channel IDs', () => {
      const ch1 = '0x' + '11'.repeat(32);
      const ch2 = '0x' + '22'.repeat(32);
      manager.trackChannel(ch1);
      manager.trackChannel(ch2);

      expect(manager.getTrackedChannels()).toContain(ch1);
      expect(manager.getTrackedChannels()).toContain(ch2);
      expect(manager.getTrackedChannels()).toHaveLength(2);
    });
  });

  describe('isTracking', () => {
    it('should return false for untracked channel', () => {
      expect(manager.isTracking('0x' + 'ff'.repeat(32))).toBe(false);
    });

    it('should return true for tracked channel', () => {
      manager.trackChannel(CHANNEL_ID);
      expect(manager.isTracking(CHANNEL_ID)).toBe(true);
    });
  });

  describe('getNonce / getCumulativeAmount errors', () => {
    it('should throw for untracked channel on getNonce', () => {
      expect(() => manager.getNonce('0x' + 'ff'.repeat(32))).toThrow(
        'not being tracked'
      );
    });

    it('should throw for untracked channel on getCumulativeAmount', () => {
      expect(() => manager.getCumulativeAmount('0x' + 'ff'.repeat(32))).toThrow(
        'not being tracked'
      );
    });
  });

  describe('session resume with initial values', () => {
    it('should continue from initial nonce and amount', async () => {
      manager.trackChannel(CHANNEL_ID, undefined, 10, 50000n);

      const proof = await manager.signBalanceProof(CHANNEL_ID, 1000n);

      expect(proof.nonce).toBe(11);
      expect(proof.transferredAmount).toBe(51000n);
    });
  });

  describe('persistence via ChannelStore', () => {
    let store: ChannelStore;

    beforeEach(() => {
      store = {
        save: vi.fn(),
        load: vi.fn().mockReturnValue(undefined),
        list: vi.fn().mockReturnValue([]),
        delete: vi.fn(),
      };
    });

    it('should save state after signBalanceProof', async () => {
      const mgr = new ChannelManager(signer, store);
      mgr.trackChannel(CHANNEL_ID);

      await mgr.signBalanceProof(CHANNEL_ID, 100n);

      expect(store.save).toHaveBeenCalledWith(CHANNEL_ID, {
        nonce: 1,
        cumulativeAmount: 100n,
      });
    });

    it('should load persisted state on trackChannel', () => {
      (store.load as ReturnType<typeof vi.fn>).mockReturnValue({
        nonce: 5,
        cumulativeAmount: 5000n,
      });

      const mgr = new ChannelManager(signer, store);
      mgr.trackChannel(CHANNEL_ID);

      expect(mgr.getNonce(CHANNEL_ID)).toBe(5);
      expect(mgr.getCumulativeAmount(CHANNEL_ID)).toBe(5000n);
    });

    it('should resume nonce sequence from persisted state', async () => {
      (store.load as ReturnType<typeof vi.fn>).mockReturnValue({
        nonce: 10,
        cumulativeAmount: 50000n,
      });

      const mgr = new ChannelManager(signer, store);
      mgr.trackChannel(CHANNEL_ID);

      const proof = await mgr.signBalanceProof(CHANNEL_ID, 1000n);
      expect(proof.nonce).toBe(11);
      expect(proof.transferredAmount).toBe(51000n);
    });

    it('should use provided defaults when store has no persisted state', () => {
      const mgr = new ChannelManager(signer, store);
      mgr.trackChannel(CHANNEL_ID, undefined, 3, 300n);

      expect(mgr.getNonce(CHANNEL_ID)).toBe(3);
      expect(mgr.getCumulativeAmount(CHANNEL_ID)).toBe(300n);
    });
  });
});
