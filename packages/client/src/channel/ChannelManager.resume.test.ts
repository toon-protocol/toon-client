import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generatePrivateKey } from 'viem/accounts';
import { EvmSigner } from '../signing/evm-signer.js';
import { ChannelManager } from './ChannelManager.js';
import { InMemoryChannelStore, JsonFileChannelStore } from './ChannelStore.js';
import type { ChannelStore } from './ChannelStore.js';
import { ChannelResumeError } from '../errors.js';

/**
 * Channel RESUME across restarts (toon-client#489).
 *
 * The live measurement runs burned ~20 USDC of collateral PER RUN in abandoned
 * EVM channels (~560 USDC across 28 channels) because `ensureChannel` only knew
 * a peer's channel in memory: EVM's `TokenNetwork.openChannel` mints a fresh
 * `bytes32` per call, so every process start locked a new deposit. Solana never
 * showed the bug only because its channel id is a deterministic PDA — the
 * re-open re-derived the SAME id, and `trackChannel` then rehydrated the
 * watermark from the store.
 *
 * These tests drive both chains through the SAME contract: a second
 * ChannelManager over the same store must re-attach to the recorded channel,
 * carry its nonce/cumulative watermark forward, and never call `openChannel`.
 */

const EVM_NEGOTIATION = {
  chain: 'evm:84532',
  chainType: 'evm',
  chainId: 84532,
  settlementAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  tokenAddress: '0x49beE1Bca5d15Fb0963117923403F9498119a9Ce',
  tokenNetwork: '0x1E95493fEF46707E034b4a1945f25a8C76A1823D',
};

const SOLANA_NEGOTIATION = {
  chain: 'solana',
  chainType: 'solana',
  chainId: 'solana',
  settlementAddress: 'ApexSolanaSettlement111111111111111111111',
  tokenAddress: 'UsdcMint1111111111111111111111111111111',
  tokenNetwork: 'PaymentChannelProgram1111111111111111111',
};

const EVM_CHANNEL = '0x' + 'a1'.repeat(32);
const SECOND_EVM_CHANNEL = '0x' + 'b2'.repeat(32);

describe('ChannelManager channel resume (#489)', () => {
  let signer: EvmSigner;

  beforeEach(() => {
    signer = new EvmSigner(generatePrivateKey());
  });

  /**
   * A ChannelManager wired to a channel client that reports `channelId` for
   * every open — the on-chain opener stands in for `OnChainChannelClient`.
   */
  function managerWith(
    store: ChannelStore | undefined,
    channelId: string,
    extra: { depositTotal?: bigint; adoptChannel?: boolean } = {}
  ) {
    const openChannel = vi.fn(async () => ({
      channelId,
      status: 'opening',
      ...(extra.depositTotal !== undefined
        ? { depositTotal: extra.depositTotal }
        : {}),
    }));
    const adoptChannel = vi.fn();
    const mgr = new ChannelManager(signer, store);
    mgr.setChannelClient({
      openChannel,
      ...(extra.adoptChannel ? { adoptChannel } : {}),
    } as unknown as Parameters<ChannelManager['setChannelClient']>[0]);
    return { mgr, openChannel, adoptChannel };
  }

  describe('EVM', () => {
    it('resumes the peer channel after a restart instead of opening a second one', async () => {
      const store = new InMemoryChannelStore();

      // Run 1: open, then spend three claims against the channel.
      const first = managerWith(store, EVM_CHANNEL);
      const opened = await first.mgr.ensureChannel('apex', EVM_NEGOTIATION);
      expect(opened).toBe(EVM_CHANNEL);
      await first.mgr.signBalanceProof(EVM_CHANNEL, 1000n);
      await first.mgr.signBalanceProof(EVM_CHANNEL, 1000n);
      await first.mgr.signBalanceProof(EVM_CHANNEL, 500n);
      expect(first.mgr.getNonce(EVM_CHANNEL)).toBe(3);

      // Run 2: a brand-new manager over the same store. Its channel client
      // WOULD mint a different channel — the resume must make that unreachable.
      const second = managerWith(store, SECOND_EVM_CHANNEL);
      const resumed = await second.mgr.ensureChannel('apex', EVM_NEGOTIATION);

      expect(resumed).toBe(EVM_CHANNEL);
      expect(second.openChannel).not.toHaveBeenCalled();
      // …and the claim watermark came back with it, so the next claim is nonce
      // 4 over 2500 — not a nonce-0 restart the connector would reject (F01).
      expect(second.mgr.getNonce(EVM_CHANNEL)).toBe(3);
      expect(second.mgr.getCumulativeAmount(EVM_CHANNEL)).toBe(2500n);
      const proof = await second.mgr.signBalanceProof(EVM_CHANNEL, 100n);
      expect(proof.nonce).toBe(4);
      expect(proof.transferredAmount).toBe(2600n);
    });

    it('carries the resumed channel across a real file-backed store (daemon restart)', async () => {
      const path = join(tmpdir(), `resume-${Date.now()}-${Math.random()}.json`);
      try {
        const first = managerWith(new JsonFileChannelStore(path), EVM_CHANNEL, {
          depositTotal: 20_000_000n,
        });
        await first.mgr.ensureChannel('apex', EVM_NEGOTIATION);
        await first.mgr.signBalanceProof(EVM_CHANNEL, 7n);

        // Fresh store object = fresh process reading the same files.
        const second = managerWith(
          new JsonFileChannelStore(path),
          SECOND_EVM_CHANNEL
        );
        const resumed = await second.mgr.ensureChannel('apex', EVM_NEGOTIATION);

        expect(resumed).toBe(EVM_CHANNEL);
        expect(second.openChannel).not.toHaveBeenCalled();
        expect(second.mgr.getNonce(EVM_CHANNEL)).toBe(1);
        expect(second.mgr.getCumulativeAmount(EVM_CHANNEL)).toBe(7n);
        // The collateral recorded at open time comes back too, so a resumed
        // channel reports its spendable balance instead of 0.
        expect(second.mgr.getDepositTotal(EVM_CHANNEL)).toBe(20_000_000n);
      } finally {
        rmSync(path, { force: true });
        rmSync(path.replace(/\.json$/, '') + '.peers.json', { force: true });
      }
    });

    it('hands the on-chain client back the resumed channel context', async () => {
      const store = new InMemoryChannelStore();
      const first = managerWith(store, EVM_CHANNEL);
      await first.mgr.ensureChannel('apex', EVM_NEGOTIATION);

      const second = managerWith(store, SECOND_EVM_CHANNEL, {
        adoptChannel: true,
      });
      await second.mgr.ensureChannel('apex', EVM_NEGOTIATION);

      // Without this the restarted client could pay on the resumed channel but
      // not deposit into or close it (context is opener-only, in memory).
      expect(second.adoptChannel).toHaveBeenCalledWith(EVM_CHANNEL, {
        chain: EVM_NEGOTIATION.chain,
        tokenNetworkAddress: EVM_NEGOTIATION.tokenNetwork,
        tokenAddress: EVM_NEGOTIATION.tokenAddress,
      });
    });

    it('seeds a nonce-0 watermark at open so "never claimed" is distinguishable', async () => {
      const store = new InMemoryChannelStore();
      const { mgr } = managerWith(store, EVM_CHANNEL);
      await mgr.ensureChannel('apex', EVM_NEGOTIATION);

      expect(store.load(EVM_CHANNEL)).toEqual({
        nonce: 0,
        cumulativeAmount: 0n,
      });
    });

    it('refuses loudly when the watermark is gone rather than resetting the nonce (F01)', async () => {
      const store = new InMemoryChannelStore();
      const first = managerWith(store, EVM_CHANNEL);
      await first.mgr.ensureChannel('apex', EVM_NEGOTIATION);
      await first.mgr.signBalanceProof(EVM_CHANNEL, 42n);

      // Someone deleted the channel store for a LIVE channel.
      store.delete(EVM_CHANNEL);

      const second = managerWith(store, SECOND_EVM_CHANNEL);
      await expect(
        second.mgr.ensureChannel('apex', EVM_NEGOTIATION)
      ).rejects.toBeInstanceOf(ChannelResumeError);
      // Neither silently re-tracked at nonce 0, nor quietly re-opened (which
      // would strand the collateral locked in the bound channel).
      expect(second.openChannel).not.toHaveBeenCalled();
      await expect(
        second.mgr.ensureChannel('apex', EVM_NEGOTIATION)
      ).rejects.toThrow(/watermark is missing/i);
    });

    it('opens a fresh channel once the bound one entered the withdraw flow', async () => {
      const store = new InMemoryChannelStore();
      const first = managerWith(store, EVM_CHANNEL);
      await first.mgr.ensureChannel('apex', EVM_NEGOTIATION);
      first.mgr.setChannelClosed(EVM_CHANNEL, 1000n, 1100n);

      const second = managerWith(store, SECOND_EVM_CHANNEL);
      const next = await second.mgr.ensureChannel('apex', EVM_NEGOTIATION);

      expect(next).toBe(SECOND_EVM_CHANNEL);
      expect(second.openChannel).toHaveBeenCalledTimes(1);
      // The new channel is what a THIRD run resumes.
      const third = managerWith(store, '0x' + 'c3'.repeat(32));
      expect(await third.mgr.ensureChannel('apex', EVM_NEGOTIATION)).toBe(
        SECOND_EVM_CHANNEL
      );
      expect(third.openChannel).not.toHaveBeenCalled();
    });

    it('binds per (peer, chain, token network) — a second chain is its own channel', async () => {
      const store = new InMemoryChannelStore();
      const evm = managerWith(store, EVM_CHANNEL);
      await evm.mgr.ensureChannel('apex', EVM_NEGOTIATION);

      const sol = managerWith(
        store,
        'SolChannelPDA111111111111111111111111111'
      );
      const solChannel = await sol.mgr.ensureChannel(
        'apex',
        SOLANA_NEGOTIATION
      );

      expect(solChannel).toBe('SolChannelPDA111111111111111111111111111');
      expect(sol.openChannel).toHaveBeenCalledTimes(1);

      // …and each chain resumes its own.
      const restart = managerWith(store, 'never-used');
      expect(await restart.mgr.ensureChannel('apex', EVM_NEGOTIATION)).toBe(
        EVM_CHANNEL
      );
      expect(await restart.mgr.ensureChannel('apex', SOLANA_NEGOTIATION)).toBe(
        'SolChannelPDA111111111111111111111111111'
      );
      expect(restart.openChannel).not.toHaveBeenCalled();
    });

    it('still opens on every run when no channel store is configured', async () => {
      const first = managerWith(undefined, EVM_CHANNEL);
      await first.mgr.ensureChannel('apex', EVM_NEGOTIATION);
      const second = managerWith(undefined, SECOND_EVM_CHANNEL);

      // Historical behaviour, unchanged: with nothing persisted there is
      // nothing to resume from.
      expect(await second.mgr.ensureChannel('apex', EVM_NEGOTIATION)).toBe(
        SECOND_EVM_CHANNEL
      );
      expect(second.openChannel).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * Locked collateral is an ON-CHAIN fact, so it must survive every path a
   * channel re-enters this process by (issue #565). Live symptom: `toon_channels`
   * reported `depositTotal: "0"` / `availableBalance: "0"` for channels the
   * TokenNetwork's `participants(channelId, me)` said held 100000 base units.
   */
  describe('deposit tracking (issue #565)', () => {
    it('adoptChannel carries the collateral the binding already recorded', async () => {
      const store = new InMemoryChannelStore();
      const first = managerWith(store, EVM_CHANNEL, {
        depositTotal: 100_000n,
      });
      await first.mgr.ensureChannel('apex', EVM_NEGOTIATION);

      // A restart where the HOST persisted the channel id itself (the MCP
      // daemon's apex-channel store, rig's channel map) and adopts it.
      const second = managerWith(store, SECOND_EVM_CHANNEL);
      second.mgr.adoptChannel('apex', EVM_NEGOTIATION, EVM_CHANNEL);

      expect(second.mgr.getDepositTotal(EVM_CHANNEL)).toBe(100_000n);
    });

    it('adoptChannel does not borrow a deposit from a DIFFERENT bound channel', async () => {
      const store = new InMemoryChannelStore();
      const first = managerWith(store, EVM_CHANNEL, {
        depositTotal: 100_000n,
      });
      await first.mgr.ensureChannel('apex', EVM_NEGOTIATION);

      const second = managerWith(store, SECOND_EVM_CHANNEL);
      second.mgr.adoptChannel('apex', EVM_NEGOTIATION, SECOND_EVM_CHANNEL);

      expect(second.mgr.getDepositTotal(SECOND_EVM_CHANNEL)).toBe(0n);
    });

    it('setDepositTotal writes through to the binding so a restart resumes the new total', async () => {
      const store = new InMemoryChannelStore();
      const first = managerWith(store, EVM_CHANNEL, {
        depositTotal: 100_000n,
      });
      await first.mgr.ensureChannel('apex', EVM_NEGOTIATION);
      // A top-up deposit (or an on-chain re-read) after the open.
      first.mgr.setDepositTotal(EVM_CHANNEL, 250_000n);

      const second = managerWith(store, SECOND_EVM_CHANNEL);
      await second.mgr.ensureChannel('apex', EVM_NEGOTIATION);

      expect(second.mgr.getDepositTotal(EVM_CHANNEL)).toBe(250_000n);
    });
  });

  describe('Solana (the already-correct contract, now shared)', () => {
    it('resumes the same PDA with its watermark and skips the on-chain open', async () => {
      const PDA = 'SolChannelPDA111111111111111111111111111';
      const store = new InMemoryChannelStore();
      const first = managerWith(store, PDA);
      await first.mgr.ensureChannel('apex', SOLANA_NEGOTIATION);
      // Solana claims need the counterparty address folded into the proof; the
      // binding carries it, so the resumed channel can still sign.
      await first.mgr.signBalanceProof(PDA, 900n).catch(() => undefined);

      const second = managerWith(store, PDA);
      expect(await second.mgr.ensureChannel('apex', SOLANA_NEGOTIATION)).toBe(
        PDA
      );
      expect(second.openChannel).not.toHaveBeenCalled();
      expect(second.mgr.getCumulativeAmount(PDA)).toBe(
        first.mgr.getCumulativeAmount(PDA)
      );
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });
});

describe('JsonFileChannelStore bindings (#489)', () => {
  let path: string;

  beforeEach(() => {
    path = join(tmpdir(), `bindings-${Date.now()}-${Math.random()}.json`);
  });

  afterEach(() => {
    rmSync(path, { force: true });
    rmSync(path.replace(/\.json$/, '') + '.peers.json', { force: true });
  });

  const BINDING = {
    channelId: EVM_CHANNEL,
    context: {
      chainType: 'evm',
      chainId: 84532,
      tokenNetworkAddress: EVM_NEGOTIATION.tokenNetwork,
      tokenAddress: EVM_NEGOTIATION.tokenAddress,
      recipient: EVM_NEGOTIATION.settlementAddress,
    },
    depositTotal: 20_000_000n,
  };

  it('round-trips a binding, preserving bigint deposits', () => {
    const store = new JsonFileChannelStore(path);
    store.saveBinding('apex|evm:84532|tn', BINDING);

    const loaded = new JsonFileChannelStore(path).loadBinding(
      'apex|evm:84532|tn'
    );
    expect(loaded?.channelId).toBe(EVM_CHANNEL);
    expect(loaded?.depositTotal).toBe(20_000_000n);
    expect(loaded?.context).toEqual(BINDING.context);
    expect(loaded?.openedAt).toBeTypeOf('string');
  });

  it('keeps bindings OUT of the watermark file (rig + the daemon parse it directly)', () => {
    const store = new JsonFileChannelStore(path);
    store.save(EVM_CHANNEL, { nonce: 2, cumulativeAmount: 5n });
    store.saveBinding('apex|evm:84532|tn', BINDING);

    // The watermark file keeps its historical `{ [channelId]: entry }` schema…
    expect(store.list()).toEqual([EVM_CHANNEL]);
    // …and the bindings live in the sibling file.
    expect(existsSync(path.replace(/\.json$/, '') + '.peers.json')).toBe(true);
  });

  it('lists and deletes bindings without touching the watermark', () => {
    const store = new JsonFileChannelStore(path);
    store.save(EVM_CHANNEL, { nonce: 9, cumulativeAmount: 90n });
    store.saveBinding('a', BINDING);
    store.saveBinding('b', { ...BINDING, channelId: SECOND_EVM_CHANNEL });
    expect(
      store
        .listBindings()
        .map((b) => b.key)
        .sort()
    ).toEqual(['a', 'b']);

    store.deleteBinding('a');
    expect(store.loadBinding('a')).toBeUndefined();
    // Deleting a binding must never drop the claim watermark — that is the
    // unrecoverable half.
    expect(store.load(EVM_CHANNEL)).toEqual({
      nonce: 9,
      cumulativeAmount: 90n,
    });
  });

  it('honours an explicit bindings path', () => {
    const bindingsPath = path.replace(/\.json$/, '') + '-custom.json';
    try {
      const store = new JsonFileChannelStore(path, { bindingsPath });
      store.saveBinding('a', BINDING);
      expect(existsSync(bindingsPath)).toBe(true);
      expect(
        new JsonFileChannelStore(path, { bindingsPath }).loadBinding('a')
          ?.channelId
      ).toBe(EVM_CHANNEL);
    } finally {
      rmSync(bindingsPath, { force: true });
    }
  });
});
