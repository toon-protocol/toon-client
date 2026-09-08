/**
 * Picking a chain, and reporting a channel — the two things the facade decides
 * that nothing else can re-derive.
 *
 * The on-chain client is a double here on purpose: opening a channel is
 * `TokenNetworkClient`'s subject and is proved against viem there. What is under
 * test is which settlement gets chosen, what the facade refuses to do on its
 * own, and that every `ChannelState` carries the domain a caller needs to render
 * an amount.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generatePrivateKey } from 'viem/accounts';
import { ClientChannelFacade, settlementToTerms } from './channel-facade.js';
import { ChannelManager } from '../channel/ChannelManager.js';
import { InMemoryChannelStore } from '../channel/ChannelStore.js';
import { EvmSigner } from '../signing/evm-signer.js';
import { parseSelfDescription } from '../connector/self-description.js';
import { ChainUnavailableError, ChannelNotOpenError } from './errors.js';
import { resolveConfig, type ResolvedConfig } from './config.js';
import type { OnChainChannelClient } from '../channel/OnChainChannelClient.js';
import type { OpenChannelParams, OpenChannelResult } from '../channel/types.js';

const MNEMONIC = 'test test test test test test test test test test test junk';
const CONNECTOR = 'http://connector.test';
const CHANNEL = `0x${'ab'.repeat(32)}`;

const EVM_SETTLEMENT = {
  chain: 'evm:84532',
  settlementAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  tokenNetworkRegistry: '0x8263BdD4eB4862395Cb4ef5dA5d637F4b047Eea1',
  tokenNetwork: '0xa79C3b1dbcEA00a6d84735a134395D8eF6D6a478',
  tokenAddress: '0x49beE1Bca5d15Fb0963117923403F9498119a9Ce',
  decimals: 6,
};
const SOLANA_SETTLEMENT = {
  chain: 'solana',
  settlementAddress: 'So11111111111111111111111111111111111111112',
  programId: '2aEVJ8koKD8LTZrLRSGtAtU7LBt4e7QjjCgf1kzQ7Rip',
  tokenAddress: 'xyc5J8MgKFiEN13PnfftdXxUzYH34FEvw1LCrFwN7in',
  decimals: 9,
};

function description(settlements: Record<string, unknown>[]) {
  return parseSelfDescription(
    {
      ilpAddresses: ['g.fake'],
      peerCarriages: [],
      settlements,
      routes: [],
      supportedVersions: [1],
      defaultVersion: 1,
    },
    CONNECTOR
  );
}

interface Harness {
  facade: ClientChannelFacade;
  channels: ChannelManager;
  config: ResolvedConfig;
  opens: OpenChannelParams[];
  onChain: OnChainChannelClient;
}

function harness(
  settlements: Record<string, unknown>[] = [EVM_SETTLEMENT],
  overrides: Record<string, unknown> = {}
): Harness {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const config = resolveConfig({
    connector: CONNECTOR,
    mnemonic: MNEMONIC,
    channelStore: new InMemoryChannelStore(),
    ...overrides,
  });
  const channels = new ChannelManager(
    new EvmSigner(generatePrivateKey()),
    config.channelStore
  );
  const opens: OpenChannelParams[] = [];
  // A stand-in for the whole on-chain surface: opening is proved against viem
  // in `channel/evm/TokenNetworkClient.test.ts`, and what matters here is which
  // call the facade makes, with what, and when.
  const onChain = {
    openChannel: (params: OpenChannelParams): Promise<OpenChannelResult> => {
      opens.push(params);
      return Promise.resolve({
        channelId: CHANNEL,
        status: 'open' as const,
        depositTotal: params.initialDeposit ?? 0n,
      });
    },
    adoptChannel: () => undefined,
    depositToChannel: () => Promise.reject(new Error('not stubbed')),
    closeChannel: () => Promise.reject(new Error('not stubbed')),
    settleChannel: () => Promise.reject(new Error('not stubbed')),
    getChannelState: () => Promise.reject(new Error('not stubbed')),
  } as unknown as OnChainChannelClient;
  channels.setChannelClient(onChain);

  const facade = new ClientChannelFacade({
    config,
    channels,
    describe: () => Promise.resolve(description(settlements)),
    onChainClient: () => onChain,
  });
  return { facade, channels, config, opens, onChain };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('picking a settlement', () => {
  it('takes the first published chain this client holds a key for', async () => {
    const h = harness([SOLANA_SETTLEMENT, EVM_SETTLEMENT]);
    await h.facade.ensure();
    expect(h.facade.terms?.kind).toBe('solana');
    expect(h.facade.terms?.programId).toBe(SOLANA_SETTLEMENT.programId);
  });

  it('honours an explicit chain over the node\'s order', async () => {
    const h = harness([SOLANA_SETTLEMENT, EVM_SETTLEMENT], { chain: 'evm' });
    await h.facade.ensure();
    expect(h.facade.terms?.kind).toBe('evm');
  });

  it('refuses, naming what the node DOES offer, when it settles on no chain we can pay on', async () => {
    const h = harness([SOLANA_SETTLEMENT], {
      // An EVM-only client against a Solana-only node.
      mnemonic: undefined,
      evmPrivateKey: `0x${'11'.repeat(32)}`,
    });
    const error = await h.facade.ensure().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChainUnavailableError);
    expect((error as ChainUnavailableError).offered).toEqual(['solana']);
  });

  it('refuses a node that publishes no settlements at all', async () => {
    const h = harness([]);
    await expect(h.facade.ensure()).rejects.toBeInstanceOf(ChainUnavailableError);
  });
});

describe('ensure — opening is never a side effect', () => {
  it('opens with the configured collateral and challenge period', async () => {
    const h = harness([EVM_SETTLEMENT], { deposit: 250_000n, settlementTimeout: 7200 });
    await expect(h.facade.ensure()).resolves.toBe(CHANNEL);
    expect(h.opens).toHaveLength(1);
    expect(h.opens[0]?.initialDeposit).toBe(250_000n);
    expect(h.opens[0]?.settlementTimeout).toBe(7200);
    expect(h.opens[0]?.terms).toEqual(settlementToTerms({ kind: 'evm', ...EVM_SETTLEMENT }));
  });

  it('resolves the same channel a second time without opening again', async () => {
    const h = harness();
    await h.facade.ensure();
    await h.facade.ensure();
    expect(h.opens).toHaveLength(1);
  });

  it('with autoOpenChannel off it opens NOTHING and says so', async () => {
    const h = harness([EVM_SETTLEMENT], { autoOpenChannel: false });
    const error = await h.facade.ensure().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChannelNotOpenError);
    expect(h.opens).toHaveLength(0);
  });

  it('…but still resolves a channel that already exists', async () => {
    const h = harness([EVM_SETTLEMENT], { autoOpenChannel: false });
    // A channel opened in a previous process, resumed from the store.
    const terms = settlementToTerms({ kind: 'evm', ...EVM_SETTLEMENT });
    h.channels.adoptChannel(CONNECTOR, terms, CHANNEL);
    await expect(h.facade.ensure()).resolves.toBe(CHANNEL);
    expect(h.opens).toHaveLength(0);
  });
});

describe('state — every reading carries its domain', () => {
  it('reports the local watermark, the collateral, and what is left', async () => {
    const h = harness();
    await h.facade.open({ deposit: 100_000n });
    await h.channels.signBalanceProof(CHANNEL, 1000n);

    const state = await h.facade.state();
    expect(state).toMatchObject({
      chain: 'evm',
      channelId: CHANNEL,
      counterparty: EVM_SETTLEMENT.settlementAddress,
      status: 'open',
      depositTotal: 100_000n,
      spent: 1000n,
      nonce: 1,
      available: 99_000n,
    });
    // The domain is what a caller formats an amount FROM, so it is never absent.
    expect(state.domain.token).toBe(EVM_SETTLEMENT.tokenAddress);
    expect(state.domain.decimals).toBe(6);
    expect(state.domain.tokenNetwork).toBe(EVM_SETTLEMENT.tokenNetwork);
    expect(state.onChain).toBeUndefined();
  });

  it('carries the Solana domain just as completely', async () => {
    const h = harness([SOLANA_SETTLEMENT]);
    await h.facade.open();
    const state = await h.facade.state();
    expect(state.domain).toMatchObject({
      kind: 'solana',
      chain: 'solana',
      decimals: 9,
      programId: SOLANA_SETTLEMENT.programId,
    });
  });

  it('reads the chain only when asked, and prefers its answer', async () => {
    const h = harness();
    await h.facade.open({ deposit: 10n });
    const getChannelState = vi
      .spyOn(h.onChain, 'getChannelState')
      .mockResolvedValue({
        channelId: CHANNEL,
        status: 'closed',
        deposit: 500n,
        closedAt: 100n,
        settleableAt: 3700n,
      });

    const state = await h.facade.state({ onChain: true });
    expect(getChannelState).toHaveBeenCalledWith(CHANNEL);
    expect(state.status).toBe('closed');
    expect(state.depositTotal).toBe(500n);
    expect(state.onChain).toEqual({ deposit: 500n, closedAt: 100n, settleableAt: 3700n });
  });

  it('never reports negative headroom, even if a claim outran the recorded deposit', async () => {
    const h = harness();
    await h.facade.open({ deposit: 10n });
    await h.channels.signBalanceProof(CHANNEL, 1000n);
    expect((await h.facade.state()).available).toBe(0n);
  });
});

describe('settle — the time guard runs before the gas', () => {
  it('refuses a channel that was never closed', async () => {
    const h = harness();
    await h.facade.open();
    await expect(h.facade.settle()).rejects.toThrow(/not been closed/);
  });

  it('refuses while the challenge period is still running, without spending gas', async () => {
    const h = harness();
    await h.facade.open();
    const future = BigInt(Math.floor(Date.now() / 1000) + 3600);
    h.channels.setChannelClosed(CHANNEL, future - 3600n, future);
    const settleChannel = vi.spyOn(h.onChain, 'settleChannel');

    await expect(h.facade.settle()).rejects.toThrow(/not settleable yet/);
    expect(settleChannel).not.toHaveBeenCalled();
  });

  it('settles once the period has elapsed', async () => {
    const h = harness();
    await h.facade.open();
    const past = BigInt(Math.floor(Date.now() / 1000) - 10);
    h.channels.setChannelClosed(CHANNEL, past - 3600n, past);
    vi.spyOn(h.onChain, 'settleChannel').mockResolvedValue({ txHash: '0xsettled' });

    await expect(h.facade.settle()).resolves.toEqual({ txHash: '0xsettled' });
    expect(h.channels.getChannelCloseState(CHANNEL)).toBe('settled');
  });
});

describe('deposit', () => {
  it('adds the delta and records the new total', async () => {
    const h = harness();
    await h.facade.open({ deposit: 100n });
    vi.spyOn(h.onChain, 'depositToChannel').mockResolvedValue({
      txHash: '0xdeposit',
      depositTotal: 600n,
    });

    const state = await h.facade.deposit(500n);
    expect(h.onChain.depositToChannel).toHaveBeenCalledWith(CHANNEL, 500n, {
      currentDeposit: 100n,
    });
    expect(state.depositTotal).toBe(600n);
    expect(h.channels.getDepositTotal(CHANNEL)).toBe(600n);
  });

  it('refuses a non-positive amount', async () => {
    const h = harness();
    await h.facade.open();
    await expect(h.facade.deposit(0n)).rejects.toBeInstanceOf(RangeError);
  });
});

describe('settlementToTerms', () => {
  it('parses the EVM chain id out of the chain key — the EIP-712 domain needs it', () => {
    expect(settlementToTerms({ kind: 'evm', ...EVM_SETTLEMENT })).toEqual({
      kind: 'evm',
      chain: 'evm:84532',
      chainId: 84532,
      counterparty: EVM_SETTLEMENT.settlementAddress,
      token: EVM_SETTLEMENT.tokenAddress,
      decimals: 6,
      tokenNetwork: EVM_SETTLEMENT.tokenNetwork,
      tokenNetworkRegistry: EVM_SETTLEMENT.tokenNetworkRegistry,
    });
  });

  it('carries the Solana program, which ADR 0053 binds into every signed claim', () => {
    expect(settlementToTerms({ kind: 'solana', ...SOLANA_SETTLEMENT })).toEqual({
      kind: 'solana',
      chain: 'solana',
      counterparty: SOLANA_SETTLEMENT.settlementAddress,
      token: SOLANA_SETTLEMENT.tokenAddress,
      decimals: 9,
      programId: SOLANA_SETTLEMENT.programId,
    });
  });
});

// ─── Regressions found by running against a real connector image ────────────
//
// Both of these are wiring faults that every unit test above was structurally
// unable to see, because `harness()` hands the manager its chain client up
// front. `ToonClient` does not: the chain client is built lazily, by the very
// getter these tests assert is called, so that `create()` and every free read
// stay chain-free. Stubbing the wiring is what hid the missing wiring.
describe('the chain client is wired before the chain is reached', () => {
  /** A harness that does NOT pre-wire the manager — exactly as `ToonClient` does not. */
  function unwired(): {
    facade: ClientChannelFacade;
    channels: ChannelManager;
    adopted: { channelId: string; chain: string }[];
    getterCalls: () => number;
  } {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const config = resolveConfig({
      connector: CONNECTOR,
      mnemonic: MNEMONIC,
      channelStore: new InMemoryChannelStore(),
    });
    const channels = new ChannelManager(
      new EvmSigner(generatePrivateKey()),
      config.channelStore
    );
    const adopted: { channelId: string; chain: string }[] = [];
    let getterCalls = 0;
    const onChain = {
      openChannel: (params: OpenChannelParams): Promise<OpenChannelResult> =>
        Promise.resolve({
          channelId: CHANNEL,
          status: 'open' as const,
          depositTotal: params.initialDeposit ?? 0n,
        }),
      adoptChannel: (channelId: string, ctx: { chain: string }) => {
        adopted.push({ channelId, chain: ctx.chain });
      },
      depositToChannel: () =>
        Promise.resolve({ txHash: '0xdep', depositTotal: 100_000n }),
      closeChannel: () => Promise.reject(new Error('not stubbed')),
      settleChannel: () => Promise.reject(new Error('not stubbed')),
      getChannelState: () =>
        Promise.resolve({ channelId: CHANNEL, status: 'open' as const }),
    } as unknown as OnChainChannelClient;

    const facade = new ClientChannelFacade({
      config,
      channels,
      describe: () => Promise.resolve(description([EVM_SETTLEMENT])),
      onChainClient: () => {
        getterCalls += 1;
        // The real getter's whole job, and the step whose absence made
        // `open()` fail with "No channel client configured".
        channels.setChannelClient(onChain);
        return onChain;
      },
    });
    return { facade, channels, adopted, getterCalls: () => getterCalls };
  }

  it('open() reaches for the chain client, so the manager has one to open with', async () => {
    const { facade, getterCalls } = unwired();
    await expect(facade.open({ deposit: 100_000n })).resolves.toMatchObject({
      channelId: CHANNEL,
    });
    expect(getterCalls()).toBeGreaterThan(0);
  });

  it('ensure() does too, since it opens on the send path', async () => {
    const { facade } = unwired();
    await expect(facade.ensure()).resolves.toBe(CHANNEL);
  });

  it('adopts a channel resolved from the store, which this process never opened', async () => {
    // The store outlives the process; the chain client's map of which chain a
    // channel is on does not. Paying needs none of it, so the gap only appears
    // the first time a resumed channel is deposited into, closed or settled —
    // and appeared there as "neither opened nor adopted".
    const { facade, channels, adopted } = unwired();
    await facade.open({ deposit: 100_000n });

    // A second facade over the SAME store is a restart in miniature.
    const resumed = new ClientChannelFacade({
      config: resolveConfig({
        connector: CONNECTOR,
        mnemonic: MNEMONIC,
        channelStore: channels.store ?? new InMemoryChannelStore(),
      }),
      channels,
      describe: () => Promise.resolve(description([EVM_SETTLEMENT])),
      onChainClient: () => ({
        adoptChannel: (channelId: string, ctx: { chain: string }) => {
          adopted.push({ channelId, chain: ctx.chain });
        },
        depositToChannel: () =>
          Promise.resolve({ txHash: '0xdep', depositTotal: 100_000n }),
        getChannelState: () =>
          Promise.resolve({ channelId: CHANNEL, status: 'open' as const }),
      }) as unknown as OnChainChannelClient,
    });

    await resumed.deposit(1_000n);
    expect(adopted.map((a) => a.channelId)).toContain(CHANNEL);
  });

  it('ensure() adopts a resumed channel too — deposit() after it must not find a stranger', async () => {
    // The send path calls `ensure()` first, and `ensure()` sets `current`.
    // `requireChannel` (which `deposit`/`close`/`settle` go through) adopts
    // only when it has to RESOLVE the channel itself; with `current` already
    // set it returns at once. So a process that resumed via `ensure()` and
    // then deposited used to fail with "neither opened nor adopted" — the
    // exact sequence a host runs when it tops up the channel it just paid on.
    const { facade, channels, adopted } = unwired();
    await facade.open({ deposit: 100_000n });

    const later: { channelId: string; chain: string }[] = [];
    const resumed = new ClientChannelFacade({
      config: resolveConfig({
        connector: CONNECTOR,
        mnemonic: MNEMONIC,
        channelStore: channels.store ?? new InMemoryChannelStore(),
      }),
      channels,
      describe: () => Promise.resolve(description([EVM_SETTLEMENT])),
      onChainClient: () => ({
        adoptChannel: (channelId: string, ctx: { chain: string }) => {
          later.push({ channelId, chain: ctx.chain });
        },
        depositToChannel: () =>
          Promise.resolve({ txHash: '0xdep', depositTotal: 100_000n }),
        getChannelState: () =>
          Promise.resolve({ channelId: CHANNEL, status: 'open' as const }),
      }) as unknown as OnChainChannelClient,
    });

    await expect(resumed.ensure()).resolves.toBe(CHANNEL);
    // Adopted by ensure() itself, before any deposit asks for it.
    expect(later.map((a) => a.channelId)).toContain(CHANNEL);
    expect(adopted.map((a) => a.channelId)).toContain(CHANNEL);
    await expect(resumed.deposit(1_000n)).resolves.toMatchObject({
      channelId: CHANNEL,
    });
  });
});
