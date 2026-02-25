import { describe, it, expect, beforeEach } from 'vitest';
import { generatePrivateKey } from 'viem/accounts';
import { EvmSigner } from '../signing/evm-signer.js';
import { ChannelManager } from './ChannelManager.js';

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
      manager.trackChannel(CHANNEL_ID, 5, 10000n);

      expect(manager.getNonce(CHANNEL_ID)).toBe(5);
      expect(manager.getCumulativeAmount(CHANNEL_ID)).toBe(10000n);
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
      expect(() => manager.getNonce('0x' + 'ff'.repeat(32))).toThrow('not being tracked');
    });

    it('should throw for untracked channel on getCumulativeAmount', () => {
      expect(() => manager.getCumulativeAmount('0x' + 'ff'.repeat(32))).toThrow('not being tracked');
    });
  });

  describe('session resume with initial values', () => {
    it('should continue from initial nonce and amount', async () => {
      manager.trackChannel(CHANNEL_ID, 10, 50000n);

      const proof = await manager.signBalanceProof(CHANNEL_ID, 1000n);

      expect(proof.nonce).toBe(11);
      expect(proof.transferredAmount).toBe(51000n);
    });
  });
});
