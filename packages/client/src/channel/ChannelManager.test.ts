import { describe, it, expect, beforeEach, vi } from 'vitest';
import { generatePrivateKey } from 'viem/accounts';
import { EvmSigner } from '../signing/evm-signer.js';
import { ChannelManager } from './ChannelManager.js';
import type { ChannelTerms } from './types.js';
import type { ChannelStore, ChannelStoreEntry } from './ChannelStore.js';


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

  describe('getChannelContext (toon-client#494)', () => {
    it('returns undefined for an untracked channel', () => {
      expect(manager.getChannelContext(CHANNEL_ID)).toBeUndefined();
    });

    it('returns the chain context a channel was tracked with', () => {
      manager.trackChannel(CHANNEL_ID, {
        chainType: 'evm',
        chainId: 421614,
        tokenNetworkAddress: '0x91d62b1F7C5d1129A64EE3915c480DBF288B1cBa',
        tokenAddress: '0xToken',
        recipient: '0xRecipient',
      });

      expect(manager.getChannelContext(CHANNEL_ID)).toEqual({
        chainType: 'evm',
        chainId: 421614,
        tokenNetworkAddress: '0x91d62b1F7C5d1129A64EE3915c480DBF288B1cBa',
        tokenAddress: '0xToken',
        recipient: '0xRecipient',
      });
    });

    it('omits tokenAddress/recipient when unset', () => {
      manager.trackChannel(CHANNEL_ID, {
        chainId: 421614,
        tokenNetworkAddress: '0x91d62b1F7C5d1129A64EE3915c480DBF288B1cBa',
      });

      const context = manager.getChannelContext(CHANNEL_ID);
      expect(context?.chainType).toBe('evm');
      expect('tokenAddress' in (context ?? {})).toBe(false);
      expect('recipient' in (context ?? {})).toBe(false);
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
      expect(() => manager.setDepositTotal('0x' + 'ff'.repeat(32), 1n)).toThrow(
        'not being tracked'
      );
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
      expect(manager.getChannelCloseState(CHANNEL_ID, 2000n)).toBe(
        'settleable'
      );
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
      m.trackChannel(CHANNEL_ID, {
        chainId: 31337,
        tokenNetworkAddress: '0x' + '11'.repeat(20),
      });
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

  // The collateral an open locks is ONE policy for every settlement chain
  // (connector#646): whatever `ensureChannel` puts in `initialDeposit` is what
  // the EVM `setTotalDeposit` and the Solana `deposit` instruction each lock.
  describe('ensureChannel initialDeposit', () => {
    const TERMS: ChannelTerms = {
      kind: 'solana',
      chain: 'solana',
      counterparty: 'ApexSolanaSettlement111111111111111111111',
      token: 'UsdcMint1111111111111111111111111111111',
      decimals: 6,
      programId: 'PaymentChannelProgram1111111111111111111',
    };

    function managerWithSpy(config?: { initialDeposit?: string }) {
      const openChannel = vi.fn(async () => ({
        channelId: 'chan-1',
        status: 'opening',
      }));
      const mgr = new ChannelManager(signer, undefined, config);
      mgr.setChannelClient({
        openChannel,
      } as unknown as Parameters<ChannelManager['setChannelClient']>[0]);
      return { mgr, openChannel };
    }

    it('defaults to 100000 base units', async () => {
      const { mgr, openChannel } = managerWithSpy();
      await mgr.ensureChannel('apex', TERMS);
      expect(openChannel).toHaveBeenCalledWith(
        expect.objectContaining({ initialDeposit: 100000n })
      );
    });

    it('honours a configured default', async () => {
      const { mgr, openChannel } = managerWithSpy({ initialDeposit: '250' });
      await mgr.ensureChannel('apex', TERMS);
      expect(openChannel).toHaveBeenCalledWith(
        expect.objectContaining({ initialDeposit: 250n })
      );
    });

    it('lets a per-call deposit win over the configured default', async () => {
      const { mgr, openChannel } = managerWithSpy({ initialDeposit: '250' });
      await mgr.ensureChannel('apex', TERMS, { initialDeposit: 999n });
      expect(openChannel).toHaveBeenCalledWith(
        expect.objectContaining({ initialDeposit: 999n })
      );
    });
  });

  // Signing advances (and persists) the watermark BEFORE the packet goes out, so
  // a refusal leaves the local cumulative ahead of what the connector banked.
  // `rollbackAmount` is the repayment; without it every later claim overpays by
  // the difference, spending the deposit down for nothing.
  describe('rollbackAmount', () => {
    const CHANNEL = '0x' + 'cc'.repeat(32);

    function tracked(store?: ChannelStore) {
      const mgr = new ChannelManager(signer, store);
      mgr.trackChannel(CHANNEL, {
        chainType: 'evm',
        chainId: 84532,
        tokenNetworkAddress: '0x' + '11'.repeat(20),
      });
      return mgr;
    }

    it('gives back an amount the connector never admitted', async () => {
      const mgr = tracked();
      await mgr.signBalanceProof(CHANNEL, 1000n);
      await mgr.signBalanceProof(CHANNEL, 1000n);
      expect(mgr.getCumulativeAmount(CHANNEL)).toBe(2000n);

      mgr.rollbackAmount(CHANNEL, 1000n);
      expect(mgr.getCumulativeAmount(CHANNEL)).toBe(1000n);
    });

    it('leaves the NONCE alone — a gap costs nothing, a reuse risks a double claim', async () => {
      const mgr = tracked();
      await mgr.signBalanceProof(CHANNEL, 1000n);
      mgr.rollbackAmount(CHANNEL, 1000n);
      expect(mgr.getNonce(CHANNEL)).toBe(1);

      // The next claim carries the SAME cumulative at a HIGHER nonce, which is
      // exactly the spec's remedy for an over-deposit refusal.
      const proof = await mgr.signBalanceProof(CHANNEL, 1000n);
      expect(proof.nonce).toBe(2);
      expect(proof.transferredAmount).toBe(1000n);
    });

    it('persists the rollback, so a restart does not resume the inflated figure', async () => {
      const saved: ChannelStoreEntry[] = [];
      const store: ChannelStore = {
        save: (_id, entry) => {
          saved.push(entry);
        },
        load: () => undefined,
        list: () => [],
        delete: () => undefined,
      };
      const mgr = tracked(store);
      await mgr.signBalanceProof(CHANNEL, 1000n);
      mgr.rollbackAmount(CHANNEL, 1000n);
      expect(saved.at(-1)).toEqual({ nonce: 1, cumulativeAmount: 0n });
    });

    it('clamps at zero rather than going negative on a double rollback', async () => {
      const mgr = tracked();
      await mgr.signBalanceProof(CHANNEL, 500n);
      mgr.rollbackAmount(CHANNEL, 500n);
      mgr.rollbackAmount(CHANNEL, 500n);
      expect(mgr.getCumulativeAmount(CHANNEL)).toBe(0n);
    });

    it('is a no-op for an untracked channel — an error path must not raise its own error', () => {
      const mgr = tracked();
      expect(() => mgr.rollbackAmount('0xnot-tracked', 10n)).not.toThrow();
    });

    it('ignores a non-positive amount', async () => {
      const mgr = tracked();
      await mgr.signBalanceProof(CHANNEL, 100n);
      mgr.rollbackAmount(CHANNEL, 0n);
      mgr.rollbackAmount(CHANNEL, -50n);
      expect(mgr.getCumulativeAmount(CHANNEL)).toBe(100n);
    });
  });
});
