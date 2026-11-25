/**
 * The payer's chain-blind lifecycle, against a fake settlement network that
 * records what it was asked: no chain, no facilitator, no sponsor.
 */
import { describe, it, expect } from 'vitest';
import { BatchSettlementPayer } from './payer.js';
import { BatchChannelManager } from './manager.js';
import type { BatchChannel } from './manager.js';
import type { BatchSettlementTerms } from './offers.js';
import type { SettlementNetwork } from './settlement-network.js';
import { parseSelfDescription } from '../../connector/self-description.js';
import { ConfigError, FacilitatorError } from '../../client/errors.js';
import { must } from '../../utils/must.test-support.js';
import { STORED_FORMS } from './stored-forms.test-support.js';

const NETWORK = 'eip155:84532';
const TOKEN = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const CONNECTOR = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';

const DESCRIPTION = parseSelfDescription({
  ilpAddresses: ['g.toon.node'],
  batchSettlements: [
    {
      network: NETWORK,
      asset: TOKEN,
      payTo: CONNECTOR,
      receiverAuthorizer: CONNECTOR,
      withdrawDelay: 86_400,
    },
  ],
});

/**
 * A settlement network whose chain is a map, and whose deposits land unless a
 * test scripts them to fail. `cover` decides whether a short channel is topped
 * up or replaced.
 */
function fakeNetwork(cover: 'top-up' | 'replace') {
  const chain = new Map<string, { escrow: bigint; landed: bigint }>();
  const failures: (() => Error)[] = [];
  const asked = {
    opens: [] as { deposit: bigint; charge: bigint }[],
    topUps: [] as {
      channelId: string;
      amount: bigint;
      voucherAmount: bigint;
    }[],
    reads: [] as string[],
    vouchers: [] as { channelId: string; cumulative: bigint }[],
    challenges: [] as string[],
  };
  let opened = 0;
  const land = async (apply: () => void) => {
    // A deposit takes a moment, so concurrent callers overlap it.
    await new Promise((r) => setTimeout(r, 5));
    const failure = failures.shift();
    if (failure) throw failure();
    apply();
  };
  const network: SettlementNetwork = {
    chain: 'evm',
    serves: (n) => n === NETWORK,
    async open(_terms: BatchSettlementTerms, amounts) {
      asked.opens.push(amounts);
      const deposit =
        amounts.deposit > amounts.charge ? amounts.deposit : amounts.charge;
      const channelId = `0x${(++opened).toString(16).padStart(64, '0')}`;
      const channel: BatchChannel = {
        chain: 'evm',
        channelId,
        network: NETWORK,
        config: {
          payer: CONNECTOR,
          payerAuthorizer: CONNECTOR,
          receiver: CONNECTOR,
          receiverAuthorizer: CONNECTOR,
          token: TOKEN,
          withdrawDelay: 86_400,
          salt: channelId as `0x${string}`,
        },
      };
      return {
        channel,
        deposit,
        land: () =>
          land(() => chain.set(channelId, { escrow: deposit, landed: 0n })),
      };
    },
    cover:
      cover === 'top-up'
        ? {
            kind: 'top-up',
            async deposit(channel, _terms, amounts) {
              asked.topUps.push({
                channelId: channel.channelId,
                amount: amounts.amount,
                voucherAmount: amounts.voucherAmount,
              });
              await land(() => {
                const state = must(chain.get(channel.channelId));
                state.escrow += amounts.amount;
              });
            },
          }
        : { kind: 'replace', noTopUp: 'this fake replaces channels' },
    async read(channel) {
      asked.reads.push(channel.channelId);
      const state = chain.get(channel.channelId);
      return { escrow: state?.escrow, landed: state?.landed ?? 0n };
    },
    async voucher(channel, cumulative) {
      asked.vouchers.push({ channelId: channel.channelId, cumulative });
      return { channelId: channel.channelId, amount: cumulative.toString() };
    },
    async challenge(channel) {
      asked.challenges.push(channel.channelId);
      return { channelId: channel.channelId };
    },
  };
  return { network, chain, failures, asked };
}

function payerOver(
  network: SettlementNetwork,
  connectorWatermark?: (
    entry: Record<string, unknown>
  ) => Promise<bigint | undefined>
) {
  const manager = new BatchChannelManager(STORED_FORMS);
  const p = new BatchSettlementPayer({
    connector: 'https://node.example',
    manager,
    deposit: 10_000n,
    networks: [network],
    ...(connectorWatermark ? { connectorWatermark } : {}),
  });
  return { p, manager };
}

describe('the payer, through a settlement network', () => {
  it('opens one channel for concurrent first sends, and signs each voucher through the network', async () => {
    const f = fakeNetwork('top-up');
    const { p } = payerOver(f.network);
    const [a, b] = await Promise.all([
      p.claimFor(DESCRIPTION, 'evm', 1_000n),
      p.claimFor(DESCRIPTION, 'evm', 1_000n),
    ]);
    expect(f.asked.opens).toEqual([{ deposit: 10_000n, charge: 1_000n }]);
    expect(must(a).channelId).toBe(must(b).channelId);
    expect(new Set([must(a).cumulative, must(b).cumulative])).toEqual(
      new Set([1_000n, 2_000n])
    );
    expect(f.asked.vouchers.map((v) => v.cumulative).sort()).toEqual([
      1_000n,
      2_000n,
    ]);
    expect(must(a).claim).toEqual({
      channelId: must(a).channelId,
      amount: must(a).cumulative.toString(),
    });
  });

  it('tops a channel up when the network covers by topping up', async () => {
    const f = fakeNetwork('top-up');
    const { p, manager } = payerOver(f.network);
    const first = must(await p.claimFor(DESCRIPTION, 'evm', 9_000n));
    const second = must(await p.claimFor(DESCRIPTION, 'evm', 2_000n));
    expect(second.channelId).toBe(first.channelId);
    expect(f.asked.topUps).toEqual([
      { channelId: first.channelId, amount: 10_000n, voucherAmount: 11_000n },
    ]);
    expect(manager.depositTotal(first.channelId)).toBe(20_000n);
    expect(second.cumulative).toBe(11_000n);
  });

  it('replaces a channel when the network covers by replacing, and refuses a top-up', async () => {
    const f = fakeNetwork('replace');
    const { p } = payerOver(f.network);
    const first = must(await p.claimFor(DESCRIPTION, 'evm', 9_000n));
    const second = must(await p.claimFor(DESCRIPTION, 'evm', 2_000n));
    expect(second.channelId).not.toBe(first.channelId);
    expect(f.asked.opens).toHaveLength(2);
    expect(f.asked.topUps).toEqual([]);
    expect(second.cumulative).toBe(2_000n);
    await expect(p.topUp(DESCRIPTION, 'evm', 5_000n)).rejects.toThrow(
      new ConfigError('this fake replaces channels')
    );
  });

  it('reconciles a pending deposit against the network before the next voucher', async () => {
    const f = fakeNetwork('top-up');
    const { p, manager } = payerOver(f.network);
    // The deposit lands, but its answer is lost.
    f.failures.push(() => new TypeError('socket hang up'));
    f.network.open = ((open) => async (terms, amounts) => {
      const planned = await open(terms, amounts);
      return {
        ...planned,
        land: async () => {
          f.chain.set(planned.channel.channelId, {
            escrow: planned.deposit,
            landed: 0n,
          });
          await planned.land();
        },
      };
    })(f.network.open.bind(f.network));
    await expect(p.claimFor(DESCRIPTION, 'evm', 1_000n)).rejects.toThrow(
      'socket hang up'
    );
    const channelId = must(manager.channels('https://node.example')[0]).channel
      .channelId;
    expect(manager.pendingDeposit(channelId)).toBe(10_000n);

    const next = must(await p.claimFor(DESCRIPTION, 'evm', 1_000n));
    expect(next.channelId).toBe(channelId);
    expect(f.asked.reads).toEqual([channelId]);
    expect(f.asked.opens).toHaveLength(1);
    expect(manager.pendingDeposit(channelId)).toBeUndefined();
    expect(manager.depositTotal(channelId)).toBe(10_000n);
  });

  it('forgets a channel whose open was definitely refused', async () => {
    const f = fakeNetwork('top-up');
    const { p, manager } = payerOver(f.network);
    f.failures.push(() => new FacilitatorError('refused', 'invalid_scheme'));
    await expect(p.claimFor(DESCRIPTION, 'evm', 1_000n)).rejects.toThrow(
      FacilitatorError
    );
    expect(manager.channels('https://node.example')).toEqual([]);
  });

  it('resyncs with the connector, through the network’s challenge, when a refusal leaves doubt', async () => {
    const f = fakeNetwork('top-up');
    const asked: Record<string, unknown>[] = [];
    const { p } = payerOver(f.network, async (entry) => {
      asked.push(entry);
      return 1_000n;
    });
    must(await p.claimFor(DESCRIPTION, 'evm', 1_000n)).settle({
      kind: 'banked',
    });
    must(await p.claimFor(DESCRIPTION, 'evm', 1_000n)).settle({
      kind: 'refused',
      message: 'claim rejected: cumulative amount goes backwards',
    });
    const next = must(await p.claimFor(DESCRIPTION, 'evm', 1_000n));
    expect(asked).toEqual([{ channelId: next.channelId }]);
    expect(f.asked.challenges).toEqual([next.channelId]);
    // Never below the refused voucher, which the connector holds at least.
    expect(next.cumulative).toBe(3_000n);
  });

  it('refuses a network it holds no adapter for', async () => {
    const { p } = payerOver(fakeNetwork('top-up').network);
    const solanaOnly = parseSelfDescription({
      ilpAddresses: ['g.toon.node'],
      batchSettlements: [
        {
          network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
          asset: 'So11111111111111111111111111111111111111112',
          payTo: CONNECTOR,
          feePayer: CONNECTOR,
          tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
          sponsorEndpoint: 'https://node.example/sponsor',
          minDeposit: '0',
          withdrawDelay: 86_400,
        },
      ],
    });
    await expect(p.claimFor(solanaOnly, 'solana', 1_000n)).rejects.toThrow(
      new ConfigError(
        'this client holds no Solana key to pay a batch-settlement channel with'
      )
    );
  });
});
