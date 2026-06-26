import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { generatePrivateKey } from 'viem/accounts';
import { deriveFullIdentity } from '@toon-protocol/core';
import { EvmSigner } from '../signing/evm-signer.js';
import { MinaSigner } from '../signing/mina-signer.js';
import { ChannelManager } from './ChannelManager.js';
import type { ChannelStore, ChannelStoreEntry } from './ChannelStore.js';
import { loadMinaPaymentChannelBindings } from './mina-payment-channel.js';

// A deterministic 12-word test mnemonic (BIP-39) for Mina identity derivation.
const TEST_MNEMONIC =
  'test test test test test test test test test test test junk';
// A valid B62 Mina recipient (apex settlement pubkey, participantB) so the
// signer takes the on-chain participant-form channelHash path.
const MINA_RECIPIENT = 'B62qktYjkc9HQQEFwlsdyQECCnQjMKLDDxntn6ZBQXt7XPjZ9hRJ7q';

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
      manager.trackChannel(CHANNEL_ID, {
        chainId: 421614,
        tokenNetworkAddress: '0x91d62b1F7C5d1129A64EE3915c480DBF288B1cBa',
      });

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

  describe('getDepositTotal / setDepositTotal', () => {
    it('defaults to 0n and updates via the setter', () => {
      manager.trackChannel(CHANNEL_ID);
      expect(manager.getDepositTotal(CHANNEL_ID)).toBe(0n);
      manager.setDepositTotal(CHANNEL_ID, 150_000n);
      expect(manager.getDepositTotal(CHANNEL_ID)).toBe(150_000n);
    });

    it('throws for an untracked channel', () => {
      expect(() => manager.setDepositTotal('0x' + 'ff'.repeat(32), 1n)).toThrow('not being tracked');
    });
  });

  describe('withdraw close-state', () => {
    it('setChannelClosed sets closing → settleable by the clock; settle marks settled', () => {
      manager.trackChannel(CHANNEL_ID);
      expect(manager.getChannelCloseState(CHANNEL_ID, 0n)).toBe('open');
      manager.setChannelClosed(CHANNEL_ID, 1000n, 2000n);
      expect(manager.getSettleableAt(CHANNEL_ID)).toBe(2000n);
      // Before the grace elapses → closing; after → settleable.
      expect(manager.getChannelCloseState(CHANNEL_ID, 1500n)).toBe('closing');
      expect(manager.getChannelCloseState(CHANNEL_ID, 2000n)).toBe('settleable');
      manager.setChannelSettled(CHANNEL_ID, 2100n);
      expect(manager.getChannelCloseState(CHANNEL_ID, 3000n)).toBe('settled');
    });

    it('persists + resumes close timers across a store reload (restart safety)', () => {
      const store = new (class {
        data = new Map<string, ChannelStoreEntry>();
        save(id: string, e: ChannelStoreEntry): void {
          this.data.set(id, e);
        }
        load(id: string): ChannelStoreEntry | undefined {
          return this.data.get(id);
        }
        list(): string[] {
          return [...this.data.keys()];
        }
        delete(id: string): void {
          this.data.delete(id);
        }
      })();
      const m1 = new ChannelManager(signer, store);
      m1.trackChannel(CHANNEL_ID);
      m1.setChannelClosed(CHANNEL_ID, 1000n, 2000n);

      // Fresh manager (simulated restart) resumes the timer from the store.
      const m2 = new ChannelManager(signer, store);
      m2.trackChannel(CHANNEL_ID);
      expect(m2.getSettleableAt(CHANNEL_ID)).toBe(2000n);
      expect(m2.getChannelCloseState(CHANNEL_ID, 1500n)).toBe('closing');
    });

    it('signBalanceProof after close does NOT drop the close timers', async () => {
      const store = new (class {
        data = new Map<string, ChannelStoreEntry>();
        save(id: string, e: ChannelStoreEntry): void {
          this.data.set(id, e);
        }
        load(id: string): ChannelStoreEntry | undefined {
          return this.data.get(id);
        }
        list(): string[] {
          return [...this.data.keys()];
        }
        delete(id: string): void {
          this.data.delete(id);
        }
      })();
      const m = new ChannelManager(signer, store);
      m.trackChannel(CHANNEL_ID, { chainId: 31337, tokenNetworkAddress: '0x' + '11'.repeat(20) });
      m.setChannelClosed(CHANNEL_ID, 1000n, 2000n);
      await m.signBalanceProof(CHANNEL_ID, 100n);
      // The persisted entry must still carry the close timers.
      expect(store.data.get(CHANNEL_ID)?.settleableAt).toBe(2000n);
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

  describe('Mina depositTotal threading (connector#133, issue #219)', () => {
    let minaAvailable = false;
    let zkAppAddress: string; // valid B62 Pallas point used as the channel id

    beforeAll(async () => {
      try {
        // Derive a real, valid B62 address (Pallas point) to use as the Mina
        // channel id / zkAppAddress. mina-signer is optional — skip if absent.
        const id = await deriveFullIdentity(TEST_MNEMONIC);
        zkAppAddress = id.mina.publicKey;
        await loadMinaPaymentChannelBindings();
        minaAvailable = !!zkAppAddress;
      } catch {
        minaAvailable = false;
      }
    });

    it('binds balanceB = depositTotal − amount for a Mina channel tracked with on-chain depositTotal', async () => {
      if (!minaAvailable) return; // optional dep absent — skip, do not false-pass
      const id = await deriveFullIdentity(TEST_MNEMONIC);
      const minaSigner = new MinaSigner(id.mina.privateKey, id.mina.publicKey);

      const mgr = new ChannelManager(signer);
      mgr.registerChainSigner('mina', minaSigner);

      // Mimic ensureChannel/trackChannel after an on-chain Mina open: the opener
      // read depositTotal=D from the zkApp appState (index 4) and threaded it in.
      const depositTotal = 10_000_000n;
      const amount = 1000n;
      mgr.trackChannel(zkAppAddress, {
        chainType: 'mina',
        chainId: 0,
        tokenNetworkAddress: zkAppAddress,
        recipient: MINA_RECIPIENT,
        depositTotal,
      });

      const proof = await mgr.signBalanceProof(zkAppAddress, amount);

      expect(proof.mina).toBeDefined();
      // The signed commitment must bind balanceB = depositTotal − amount — the
      // SAME conserved value the connector reconstructs from the on-chain
      // depositTotal (connector#133), so the on-chain claimFromChannel
      // signatureA check passes. Reuse the mina-signer.test.ts:242 assertion:
      // recompute Poseidon([amount, depositTotal − amount, salt]) and match.
      const { Poseidon } = await loadMinaPaymentChannelBindings();
      const conserved = Poseidon.hash([
        amount,
        depositTotal - amount,
        BigInt(proof.mina!.salt),
      ]);
      expect(proof.mina!.balanceCommitment).toBe(conserved.toString());

      // …and it must NOT be the legacy balanceB=0 commitment (#133 rejects that
      // on-chain as non-conserving — the bug this fix addresses).
      const legacy = Poseidon.hash([amount, 0n, BigInt(proof.mina!.salt)]);
      expect(proof.mina!.balanceCommitment).not.toBe(legacy.toString());
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
