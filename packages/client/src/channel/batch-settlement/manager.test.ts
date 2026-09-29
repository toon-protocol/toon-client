import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BatchChannelManager, type BatchChannel } from './manager.js';
import { InMemoryChannelStore, JsonFileChannelStore } from '../ChannelStore.js';

const CONNECTOR = 'https://node.example';

const EVM: BatchChannel = {
  chain: 'evm',
  channelId:
    '0x88d37e9be679d5e46c7c1d073e6f41b5ec07cc5099319a49b80ba460f0d8055d',
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

const SOLANA: BatchChannel = {
  chain: 'solana',
  channelId: 'WLNQ714q14a3SEXsbrXKDsWoxugYdGA6brPDGXpUWjX',
  network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  sponsor: '9hSR6S7WPtxmTojgo6GG3k4yDPecgJY292j7xrsUGWBu',
  config: {
    payer: 'AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9',
    payerAuthorizer: 'GyGKxMyg1p9SsHfm15MkNUu1u9TN2JtTspcdmrtGUdse',
    receiver: 'EdmxWPmx2WH6WgFfTdu9xfkYf3k1g5wD1zccTVySEEh1',
    token: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    withdrawDelay: 86_400,
    salt: 2n ** 63n + 42n,
    openSlot: 400_000_000n,
  },
};

describe('BatchChannelManager', () => {
  it('resolves an adopted channel by connector, network and asset, and nothing else', () => {
    const m = new BatchChannelManager();
    m.adopt(CONNECTOR, EVM, 1_000_000n);
    expect(m.resolve(CONNECTOR, EVM.network, EVM.config.token)).toEqual(EVM);
    expect(
      m.resolve(CONNECTOR, 'eip155:8453', EVM.config.token)
    ).toBeUndefined();
    expect(
      m.resolve('https://other.example', EVM.network, EVM.config.token)
    ).toBeUndefined();
    expect(m.depositTotal(EVM.channelId)).toBe(1_000_000n);
  });

  it('signs exactly the running total plus the charge, and nothing on a free route', () => {
    const m = new BatchChannelManager();
    m.adopt(CONNECTOR, EVM, 1_000_000n);
    expect(m.reserve(EVM.channelId, 1_000n)).toBe(1_000n);
    expect(m.reserve(EVM.channelId, 0n)).toBeUndefined();
    expect(m.reserve(EVM.channelId, 500n)).toBe(1_500n);
    expect(m.signedSoFar(EVM.channelId)).toBe(1_500n);
  });

  it('gives back a charge the connector refused without banking', () => {
    const m = new BatchChannelManager();
    m.adopt(CONNECTOR, EVM, 1_000_000n);
    m.reserve(EVM.channelId, 1_000n);
    m.reserve(EVM.channelId, 500n);
    m.refused(EVM.channelId, 1_500n, 500n, { notAdvancing: false });
    expect(m.reserve(EVM.channelId, 500n)).toBe(1_500n);
  });

  it('does not give a charge back when a later voucher already superseded the refused one', () => {
    // Two sends in flight: A reserves 1000, B reserves 2000. B is banked, then
    // A is refused. Subtracting A's charge would drop below what the connector
    // holds and refuse every voucher after.
    const m = new BatchChannelManager();
    m.adopt(CONNECTOR, EVM, 1_000_000n);
    m.reserve(EVM.channelId, 1_000n);
    m.reserve(EVM.channelId, 1_000n);
    m.refused(EVM.channelId, 1_000n, 1_000n, { notAdvancing: false });
    expect(m.reserve(EVM.channelId, 500n)).toBe(2_500n);
  });

  it('adopts the watermark an underpayment names, so the next voucher is not refused the same way', () => {
    // The connector holds 15; this client counts 12. A charge of 7 signs 19,
    // which advances by 4 < 7: "advances value by 4". Watermark = 19 - 4.
    const m = new BatchChannelManager();
    m.adopt(CONNECTOR, EVM, 1_000_000n);
    m.reserve(EVM.channelId, 20n); // ceiling 20: the client signed that much
    m.refused(EVM.channelId, 20n, 8n, { notAdvancing: false }); // count falls back to 12
    expect(m.signedSoFar(EVM.channelId)).toBe(12n);
    expect(m.reserve(EVM.channelId, 7n)).toBe(19n);
    m.refused(EVM.channelId, 19n, 7n, {
      notAdvancing: false,
      connectorWatermark: 15n,
    });
    expect(m.reserve(EVM.channelId, 7n)).toBe(22n);
  });

  it('never adopts a named watermark above what this client ever signed', () => {
    const m = new BatchChannelManager();
    m.adopt(CONNECTOR, EVM, 1_000_000n);
    m.reserve(EVM.channelId, 100n);
    m.refused(EVM.channelId, 100n, 100n, {
      notAdvancing: false,
      connectorWatermark: 10_000n,
    });
    expect(m.signedSoFar(EVM.channelId)).toBe(100n);
  });

  it('keeps a voucher whose fate is unknown counted, so the next one clears it', () => {
    // No nonce, and no claim-state read for a voucher channel. A voucher that
    // went unanswered may or may not have been banked, so it is never given
    // back: the next voucher then exceeds it either way, at the cost of at most
    // one charge if it never arrived. Only a definite refusal gives a charge back.
    const m = new BatchChannelManager();
    m.adopt(CONNECTOR, EVM, 1_000_000n);
    m.reserve(EVM.channelId, 1_000n);
    m.reserve(EVM.channelId, 500n);
    m.refused(EVM.channelId, 1_500n, 500n, { notAdvancing: false });
    expect(m.reserve(EVM.channelId, 300n)).toBe(1_300n); // sent, never answered
    expect(m.reserve(EVM.channelId, 200n)).toBe(1_500n);
  });

  it('reads amount_not_advancing as: the connector holds up to everything ever signed', () => {
    const m = new BatchChannelManager();
    m.adopt(CONNECTOR, EVM, 1_000_000n);
    m.reserve(EVM.channelId, 1_000n);
    m.reserve(EVM.channelId, 1_000n);
    m.refused(EVM.channelId, 2_000n, 1_000n, { notAdvancing: false }); // count 1000, ceiling 2000
    m.reserve(EVM.channelId, 500n); // 1500, "goes backwards": the connector holds more
    m.refused(EVM.channelId, 1_500n, 500n, { notAdvancing: true });
    expect(m.reserve(EVM.channelId, 500n)).toBe(2_500n);
  });

  it('recovers a lost watermark from what the chain has landed, as a lower bound', () => {
    const m = new BatchChannelManager();
    m.adopt(CONNECTOR, SOLANA, 1_000_000n);
    m.recoverFromChain(SOLANA.channelId, 7_000n);
    expect(m.reserve(SOLANA.channelId, 1_000n)).toBe(8_000n);
    // A chain figure below what was signed moves nothing.
    m.recoverFromChain(SOLANA.channelId, 10n);
    expect(m.reserve(SOLANA.channelId, 1_000n)).toBe(9_000n);
  });

  it('keeps the highest voucher for a probe to resend, whatever order the answers came in', () => {
    const m = new BatchChannelManager();
    m.adopt(CONNECTOR, EVM, 1_000_000n);
    m.recordVoucher(EVM.channelId, '{"v":20}', 20n);
    m.recordVoucher(EVM.channelId, '{"v":10}', 10n);
    expect(m.lastVoucher(EVM.channelId)).toBe('{"v":20}');
    m.recordVoucher(EVM.channelId, '{"v":30}', 30n);
    expect(m.lastVoucher(EVM.channelId)).toBe('{"v":30}');
  });

  it('never adopts a connector figure below what the chain has landed', () => {
    const store = new InMemoryChannelStore();
    const m = new BatchChannelManager(store);
    m.adopt(CONNECTOR, EVM, 1_000_000n);
    store.delete(EVM.channelId); // the watermark file is lost; the binding survives
    m.restoreWatermark(EVM.channelId, 4_000n);
    // A store that was lost is the recovering case, and still has a floor.
    m.adoptConnectorWatermark(EVM.channelId, 1_000n, { recovering: true });
    expect(m.reserve(EVM.channelId, 1_000n)).toBe(5_000n);
  });

  it('never adopts a connector figure below a voucher it banked or refused as not advancing', () => {
    const m = new BatchChannelManager();
    m.adopt(CONNECTOR, EVM, 1_000_000n);
    m.reserve(EVM.channelId, 1_000n);
    m.banked(EVM.channelId, 1_000n);
    m.adoptConnectorWatermark(EVM.channelId, 0n);
    expect(m.reserve(EVM.channelId, 1_000n)).toBe(2_000n);
    m.refused(EVM.channelId, 2_000n, 1_000n, { notAdvancing: true });
    m.adoptConnectorWatermark(EVM.channelId, 500n);
    expect(m.reserve(EVM.channelId, 1_000n)).toBe(3_000n);
  });

  it('keeps the floor across a restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'batch-floor-'));
    const path = join(dir, 'channels.json');
    const first = new BatchChannelManager(new JsonFileChannelStore(path));
    first.adopt(CONNECTOR, EVM, 1_000_000n);
    first.reserve(EVM.channelId, 3_000n);
    first.banked(EVM.channelId, 3_000n);
    const second = new BatchChannelManager(new JsonFileChannelStore(path));
    second.adoptConnectorWatermark(EVM.channelId, 0n);
    expect(second.reserve(EVM.channelId, 1n)).toBe(3_001n);
  });

  it('refuses a voucher its deposit cannot cover', () => {
    const m = new BatchChannelManager();
    m.adopt(CONNECTOR, EVM, 1_000n);
    expect(() => m.reserve(EVM.channelId, 1_001n)).toThrow(/deposit/);
    expect(m.signedSoFar(EVM.channelId)).toBe(0n);
    m.addDeposit(EVM.channelId, 1n);
    expect(m.reserve(EVM.channelId, 1_001n)).toBe(1_001n);
  });

  it('survives a restart: config, deposit and watermark, on both chains', () => {
    const dir = mkdtempSync(join(tmpdir(), 'batch-store-'));
    const path = join(dir, 'channels.json');
    const first = new BatchChannelManager(new JsonFileChannelStore(path));
    first.adopt(CONNECTOR, EVM, 1_000_000n);
    first.adopt(CONNECTOR, SOLANA, 2_000_000n);
    first.reserve(EVM.channelId, 1_000n);
    first.reserve(SOLANA.channelId, 3_000n);

    const second = new BatchChannelManager(new JsonFileChannelStore(path));
    expect(second.resolve(CONNECTOR, EVM.network, EVM.config.token)).toEqual(
      EVM
    );
    expect(
      second.resolve(CONNECTOR, SOLANA.network, SOLANA.config.token)
    ).toEqual(SOLANA);
    expect(second.depositTotal(SOLANA.channelId)).toBe(2_000_000n);
    expect(second.reserve(EVM.channelId, 1n)).toBe(1_001n);
    expect(second.reserve(SOLANA.channelId, 1n)).toBe(3_001n);
  });

  it('keeps more than one channel to one connector apart', () => {
    const store = new InMemoryChannelStore();
    const m = new BatchChannelManager(store);
    const second: BatchChannel = { ...EVM, channelId: `0x${'ab'.repeat(32)}` };
    m.adopt(CONNECTOR, EVM, 10n);
    m.adopt(CONNECTOR, second, 10n);
    m.reserve(EVM.channelId, 5n);
    expect(m.signedSoFar(second.channelId)).toBe(0n);
    // The newest adoption is the one a send resolves to.
    expect(m.resolve(CONNECTOR, EVM.network, EVM.config.token)?.channelId).toBe(
      second.channelId
    );
  });

  it('never resolves a toon-channel binding, nor lets one resolve a voucher channel', () => {
    const store = new InMemoryChannelStore();
    store.saveBinding(
      `batch|${CONNECTOR}|${EVM.network}|${EVM.config.token.toLowerCase()}`,
      {
        channelId: '0xdead',
        context: {
          chainType: 'evm',
          chainId: 84532,
          tokenNetworkAddress: '0x0',
        },
      }
    );
    expect(
      new BatchChannelManager(store).resolve(
        CONNECTOR,
        EVM.network,
        EVM.config.token
      )
    ).toBeUndefined();
  });
});

describe('reading a channel back off the chain', () => {
  it('EVM: channels(id) and pendingWithdrawals(id)', async () => {
    const { readEvmBatchChannel } = await import('./evm.js');
    const calls: string[] = [];
    const client = {
      readContract: async (p: never) => {
        const { functionName, args, address } = p as {
          functionName: string;
          args: string[];
          address: string;
        };
        calls.push(`${address}:${functionName}:${args[0]}`);
        return functionName === 'channels'
          ? [5_000n, 1_200n]
          : [300n, 1_790_000_000];
      },
    };
    expect(
      await readEvmBatchChannel(client, EVM.channelId as `0x${string}`)
    ).toEqual({
      balance: 5_000n,
      totalClaimed: 1_200n,
      pendingWithdrawal: 300n,
      withdrawalInitiatedAt: 1_790_000_000,
    });
    expect(calls.sort()).toEqual([
      `0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003:channels:${EVM.channelId}`,
      `0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003:pendingWithdrawals:${EVM.channelId}`,
    ]);
  });

  it('Solana: the channel account, or null when there is none', async () => {
    const { getSvmBatchChannel, PAYMENT_CHANNELS_PROGRAM_ID } =
      await import('./svm.js');
    const account = new Uint8Array(256);
    account[0] = 1;
    new DataView(account.buffer).setBigUint64(20, 4_321n, true); // settled
    const rpc = (value: unknown) => ({
      url: 'http://rpc',
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 1, result: { value } })
        )) as typeof fetch,
    });
    const data = [Buffer.from(account).toString('base64'), 'base64'];
    const state = await getSvmBatchChannel(
      rpc({ data, owner: PAYMENT_CHANNELS_PROGRAM_ID }),
      SOLANA.channelId
    );
    expect(state?.settled).toBe(4_321n);
    expect(await getSvmBatchChannel(rpc(null), SOLANA.channelId)).toBeNull();
    await expect(
      getSvmBatchChannel(
        rpc({ data, owner: '11111111111111111111111111111111' }),
        SOLANA.channelId
      )
    ).rejects.toThrow(/not payment-channels/);
  });
});

describe('BatchChannelManager — leaving a channel', () => {
  it('records the exit, and lists every channel with its state', () => {
    const m = new BatchChannelManager();
    m.adopt(CONNECTOR, EVM, 1_000n);
    m.reserve(EVM.channelId, 400n);
    expect(m.isClosing(EVM.channelId)).toBe(false);
    m.markClosing(EVM.channelId, 10n, 20n);
    expect(m.isClosing(EVM.channelId)).toBe(true);
    m.markSettled(EVM.channelId, 30n);
    expect(m.channels(CONNECTOR)).toEqual([
      {
        channel: EVM,
        depositTotal: 1_000n,
        signed: 400n,
        closedAt: 10n,
        settleableAt: 20n,
        settledAt: 30n,
      },
    ]);
    expect(m.channels('https://other.example')).toEqual([]);
  });
});
