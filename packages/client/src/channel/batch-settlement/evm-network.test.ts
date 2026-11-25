/**
 * The EVM settlement network's voucher scheme, through the settlement network
 * interface, against the connector's wire vectors: the voucher's claim and the
 * claim-state challenge, byte for byte.
 */
import { describe, it, expect } from 'vitest';
import { getAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { EvmSettlementNetwork, evmStoredForm } from './evm-network.js';
import type { EvmWalletAccess } from './deposit-gas.js';
import { ValidationError } from '../../client/errors.js';
import type { BatchChannel } from './manager.js';
import type { BatchSettlementBinding } from '../ChannelStore.js';
import { loadWireVectors } from '../../wire/vectors/load.js';
import { must } from '../../utils/must.test-support.js';

const vectors = loadWireVectors();
const prefix0x = (hex: string): Hex => `0x${hex}`;

// The connector's fixture keys: anvil account 1, and `seq_bytes(0xe1)`.
const ANVIL_ACCOUNT_1_KEY =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const ABOVE_U64_MAX_KEY = `0x${Array.from({ length: 32 }, (_, i) =>
  ((0xe1 + i) & 0xff).toString(16).padStart(2, '0')
).join('')}` as Hex;

const noFetch = (async () => {
  throw new Error('the voucher scheme reaches nothing');
}) as typeof fetch;

function network(key: Hex): EvmSettlementNetwork {
  return new EvmSettlementNetwork({
    account: privateKeyToAccount(key),
    fetch: noFetch,
  });
}

/** The claim as the network wrote it, with the published envelope's id and time. */
function withEnvelope(claim: Record<string, unknown>, json: string): string {
  const published = JSON.parse(json) as Record<string, unknown>;
  return JSON.stringify({
    ...claim,
    messageId: published['messageId'],
    timestamp: published['timestamp'],
  });
}

describe('the EVM settlement network', () => {
  it('pays on eip155 networks only', () => {
    const n = network(ANVIL_ACCOUNT_1_KEY);
    expect(n.serves('eip155:84532')).toBe(true);
    expect(n.serves('solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1')).toBe(false);
    expect(n.cover.kind).toBe('top-up');
  });

  describe.each([
    ['evm', must(vectors.claim_voucher).evm, ANVIL_ACCOUNT_1_KEY],
    [
      'evm_above_u64_max',
      must(vectors.claim_voucher).evm_above_u64_max,
      ABOVE_U64_MAX_KEY,
    ],
  ] as const)('voucher scheme: %s', (_label, v, key) => {
    const channel: BatchChannel = {
      chain: 'evm',
      channelId: prefix0x(v.channel_id_hex),
      network: `eip155:${v.chain_id}`,
      config: {
        payer: getAddress(prefix0x(v.channel_config.payer_hex)),
        payerAuthorizer: getAddress(
          prefix0x(v.channel_config.payer_authorizer_hex)
        ),
        receiver: getAddress(prefix0x(v.channel_config.receiver_hex)),
        receiverAuthorizer: getAddress(
          prefix0x(v.channel_config.receiver_authorizer_hex)
        ),
        token: getAddress(prefix0x(v.channel_config.token_hex)),
        withdrawDelay: v.channel_config.withdraw_delay,
        salt: prefix0x(v.channel_config.salt_hex),
      },
    };

    it('signs the published voucher into the published claim, byte for byte', async () => {
      const claim = await network(key).voucher(
        channel,
        BigInt(v.max_claimable_amount)
      );
      expect(claim['signature']).toBe(prefix0x(v.signature_hex));
      expect(withEnvelope(claim, v.json)).toBe(v.json);
    });
  });

  it.each(
    must(vectors.voucher_claim_state_challenge).evm.map(
      (c) => [c.name, c] as const
    )
  )('claim-state challenge: %s', async (_name, c) => {
    const cc = (
      JSON.parse(c.entry_json) as {
        channelConfig: Record<string, string | number>;
      }
    ).channelConfig;
    const channel: BatchChannel = {
      chain: 'evm',
      channelId: prefix0x(c.channel_id_hex),
      network: `eip155:${c.chain_id}`,
      config: {
        payer: String(cc['payer']),
        payerAuthorizer: String(cc['payerAuthorizer']),
        receiver: String(cc['receiver']),
        receiverAuthorizer: String(cc['receiverAuthorizer']),
        token: String(cc['token']),
        withdrawDelay: Number(cc['withdrawDelay']),
        salt: String(cc['salt']) as Hex,
      },
    };
    const entry = await network(prefix0x(c.signer_secret_hex)).challenge(
      channel,
      BigInt(c.expires)
    );
    expect(JSON.stringify(entry)).toBe(c.entry_json);
  });
});

describe('the EVM stored form', () => {
  // A channel exactly as the previous release wrote it to the channel record.
  const STORED: BatchSettlementBinding = {
    chain: 'evm',
    network: 'eip155:84532',
    config: {
      payer: '0x1111111111111111111111111111111111111111',
      payerAuthorizer: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      receiver: '0x3333333333333333333333333333333333333333',
      receiverAuthorizer: '0x3333333333333333333333333333333333333333',
      token: '0x5555555555555555555555555555555555555555',
      withdrawDelay: 86_400,
      salt: `0x${'66'.repeat(32)}`,
    },
  };
  const ID =
    '0x88d37e9be679d5e46c7c1d073e6f41b5ec07cc5099319a49b80ba460f0d8055d';

  it('reads a stored channel back, and writes it out exactly as it was stored', () => {
    const n = network(ANVIL_ACCOUNT_1_KEY);
    const channel = n.fromStored(ID, STORED);
    expect(channel).toEqual({
      chain: 'evm',
      channelId: ID,
      network: 'eip155:84532',
      config: STORED.config,
    });
    expect(n.toStored(channel)).toEqual(STORED);
  });

  it('is the same without a key, for reading channels this client no longer pays from', () => {
    expect(evmStoredForm.serves('eip155:84532')).toBe(true);
    expect(
      evmStoredForm.toStored(evmStoredForm.fromStored(ID, STORED))
    ).toEqual(STORED);
  });
});

describe('leaving an EVM channel', () => {
  const CHANNEL: BatchChannel = {
    chain: 'evm',
    channelId: `0x${'ab'.repeat(32)}`,
    network: 'eip155:84532',
    config: {
      payer: '0x1111111111111111111111111111111111111111',
      payerAuthorizer: '0x1111111111111111111111111111111111111111',
      receiver: '0x3333333333333333333333333333333333333333',
      receiverAuthorizer: '0x3333333333333333333333333333333333333333',
      token: '0x5555555555555555555555555555555555555555',
      withdrawDelay: 86_400,
      salt: `0x${'66'.repeat(32)}`,
    },
  };

  /**
   * The network over a fake contract holding one channel; records the calls
   * written and every read.
   */
  function onChain(
    state: {
      balance: bigint;
      claimed: bigint;
      pending: bigint;
      initiatedAt: number;
    },
    eth = 10n ** 18n
  ) {
    const writes: { functionName: string; args: unknown[] }[] = [];
    let reads = 0;
    const wallet = {
      getBalance: async () => eth,
      writeContract: async (p: never) => {
        const w = p as {
          functionName: string;
          args: unknown[];
          address: string;
        };
        expect(w.address).toBe('0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003');
        writes.push({ functionName: w.functionName, args: w.args });
        if (w.functionName === 'initiateWithdraw') {
          state.pending = w.args[1] as bigint;
          state.initiatedAt = 1_790_000_000;
        }
        return '0xfeed' as Hex;
      },
      waitForTransactionReceipt: async () => ({ status: 'success' }),
    } as unknown as EvmWalletAccess;
    const n = new EvmSettlementNetwork({
      account: privateKeyToAccount(ANVIL_ACCOUNT_1_KEY),
      fetch: noFetch,
      wallet,
      reader: {
        readContract: async (p: never) => {
          reads++;
          const { functionName } = p as { functionName: string };
          return functionName === 'channels'
            ? [state.balance, state.claimed]
            : [state.pending, state.initiatedAt];
        },
      },
    });
    return { n, writes, reads: () => reads };
  }

  it('close: withdraws everything unclaimed, settleable after withdrawDelay', async () => {
    const { n, writes } = onChain({
      balance: 10_000n,
      claimed: 3_000n,
      pending: 0n,
      initiatedAt: 0,
    });
    expect(await n.close(CHANNEL, 1_000n)).toEqual({
      kind: 'closing',
      transaction: '0xfeed',
      settleableAt: 1_790_000_000n + 86_400n,
    });
    expect(writes.map((w) => w.functionName)).toEqual(['initiateWithdraw']);
    expect(must(writes[0]).args[0]).toMatchObject({
      payer: CHANNEL.config.payer,
      salt: CHANNEL.config.salt,
      withdrawDelay: 86_400,
    });
    expect(must(writes[0]).args[1]).toBe(7_000n);
  });

  it('close: a channel whose deposit was all claimed is done, with no transaction', async () => {
    const { n, writes } = onChain({
      balance: 10n,
      claimed: 10n,
      pending: 0n,
      initiatedAt: 0,
    });
    expect(await n.close(CHANNEL, 1_000n)).toEqual({ kind: 'done' });
    expect(writes).toEqual([]);
  });

  it('close: refuses a second withdrawal', async () => {
    const { n } = onChain({
      balance: 10n,
      claimed: 0n,
      pending: 5n,
      initiatedAt: 1,
    });
    await expect(n.close(CHANNEL, 1_000n)).rejects.toThrow(/pending/);
  });

  it('close: says leaving needs ETH, and sends nothing, when the wallet holds none', async () => {
    const { n, writes } = onChain(
      { balance: 10n, claimed: 0n, pending: 0n, initiatedAt: 0 },
      0n
    );
    await expect(n.close(CHANNEL, 1_000n)).rejects.toThrow(
      /leaving a channel needs ETH for the fee/
    );
    expect(writes).toEqual([]);
  });

  it('settle: a channel not yet due is not settleable, and the chain is not asked', async () => {
    const { n, reads } = onChain({
      balance: 10n,
      claimed: 0n,
      pending: 10n,
      initiatedAt: 1_000,
    });
    expect(await n.settle(CHANNEL, { due: false, now: 1_000n })).toEqual({
      kind: 'not-yet',
    });
    expect(reads()).toBe(0);
  });

  it('settle: finalizes only once the delay has passed', async () => {
    const { n, writes } = onChain({
      balance: 10n,
      claimed: 0n,
      pending: 10n,
      initiatedAt: 1_000,
    });
    await expect(
      n.settle(CHANNEL, { due: true, now: 1_000n + 86_399n })
    ).rejects.toThrow(ValidationError);
    expect(
      await n.settle(CHANNEL, { due: true, now: 1_000n + 86_400n })
    ).toEqual({ kind: 'settled', transaction: '0xfeed' });
    expect(writes.map((w) => w.functionName)).toEqual(['finalizeWithdraw']);
  });

  it('settle: a channel with nothing pending and nothing left is settled, with no transaction', async () => {
    const { n, writes } = onChain({
      balance: 10n,
      claimed: 10n,
      pending: 0n,
      initiatedAt: 0,
    });
    expect(await n.settle(CHANNEL, { due: true, now: 1_000n })).toEqual({
      kind: 'settled',
    });
    expect(writes).toEqual([]);
  });
});
