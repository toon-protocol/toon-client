import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { ClientChannelFacade } from './channel-facade.js';
import {
  BatchChannelManager,
  type BatchChannel,
} from '../channel/batch-settlement/manager.js';
import type { BatchSettlementPayer } from '../channel/batch-settlement/payer.js';
import { PAYMENT_CHANNELS_PROGRAM_ID } from '../channel/batch-settlement/svm.js';
import { parseSelfDescription } from '../connector/self-description.js';
import { base58Encode } from '../utils/base58.js';
import { ChannelNotOpenError } from './errors.js';

const CONNECTOR = 'https://node.example';
const privateKey = new Uint8Array(32).fill(1);
const SIGNER = { privateKey, publicKey: ed25519.getPublicKey(privateKey) };
const PAYER = base58Encode(SIGNER.publicKey);
const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const NETWORK = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';

const CHANNEL: BatchChannel = {
  chain: 'solana',
  channelId: 'WLNQ714q14a3SEXsbrXKDsWoxugYdGA6brPDGXpUWjX',
  network: NETWORK,
  sponsor: '9hSR6S7WPtxmTojgo6GG3k4yDPecgJY292j7xrsUGWBu',
  config: {
    payer: PAYER,
    payerAuthorizer: PAYER,
    receiver: 'EdmxWPmx2WH6WgFfTdu9xfkYf3k1g5wD1zccTVySEEh1',
    token: MINT,
    withdrawDelay: 86_400,
    salt: 1n,
    openSlot: 2n,
  },
};

const DESCRIPTION = parseSelfDescription({
  batchSettlements: [
    {
      network: NETWORK,
      asset: MINT,
      payTo: CHANNEL.config.receiver,
      feePayer: CHANNEL.sponsor,
      withdrawDelay: 86_400,
      tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      minDeposit: '1',
      sponsorEndpoint: '/ilp/batch-settlement/solana/open',
    },
  ],
});

/**
 * A Solana RPC over channel accounts: `status` per PDA, or `null` for an
 * account that is gone. Records the methods called.
 */
function rpc(statuses: Record<string, number | null>) {
  const methods: string[] = [];
  const fetchImpl = (async (_u: string, init?: RequestInit) => {
    const { method, params } = JSON.parse(init!.body as string) as {
      method: string;
      params: unknown[];
    };
    methods.push(method);
    let result: unknown;
    if (method === 'getAccountInfo') {
      const status = statuses[params[0] as string];
      if (status === null || status === undefined) {
        result = { value: null };
      } else {
        const account = new Uint8Array(256);
        account[0] = 1;
        account[3] = status;
        new DataView(account.buffer).setUint32(52, 86_400, true);
        result = {
          value: {
            owner: PAYMENT_CHANNELS_PROGRAM_ID,
            data: [Buffer.from(account).toString('base64'), 'base64'],
          },
        };
      }
    } else if (method === 'getLatestBlockhash') {
      result = {
        value: { blockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N' },
      };
    } else if (method === 'sendTransaction') {
      result = 'sig';
    } else {
      result = { value: [{ confirmationStatus: 'confirmed', err: null }] };
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
  }) as typeof fetch;
  return { target: { url: 'http://rpc', fetchImpl }, methods };
}

const OTHER: BatchChannel = {
  ...CHANNEL,
  channelId: 'EdmxWPmx2WH6WgFfTdu9xfkYf3k1g5wD1zccTVySEEh1',
};

function facade(statuses: Record<string, number | null>, now = 1_000n) {
  const manager = new BatchChannelManager();
  const chain = rpc(statuses);
  const f = new ClientChannelFacade({
    connector: CONNECTOR,
    chain: 'solana',
    manager,
    payer: {
      open: async () => {
        manager.adopt(CONNECTOR, CHANNEL, 5_000n);
        return CHANNEL;
      },
    } as unknown as BatchSettlementPayer,
    describe: async () => DESCRIPTION,
    solana: { signer: SIGNER, rpc: chain.target },
    now: () => now,
  });
  return { f, manager, chain };
}

describe('client.channel', () => {
  it('opens on request, and lists what it holds', async () => {
    const { f } = facade({});
    expect(f.channels()).toEqual([]);
    const opened = await f.open();
    expect(opened).toMatchObject({
      channel: CHANNEL,
      depositTotal: 5_000n,
      signed: 0n,
    });
    expect(f.channels()).toHaveLength(1);
  });

  it('reports the channel a send would draw on, and none once it is being left', async () => {
    const { f, manager } = facade({});
    expect(await f.current()).toBeUndefined();
    await f.open();
    expect((await f.current())?.channel).toEqual(CHANNEL);
    manager.markClosing(CHANNEL.channelId, 1_000n, 2_000n);
    expect(await f.current()).toBeUndefined();
  });

  it('refuses to open on a chain the node offers no channel on', async () => {
    const manager = new BatchChannelManager();
    const f = new ClientChannelFacade({
      connector: CONNECTOR,
      chain: 'evm',
      manager,
      payer: { open: async () => undefined } as unknown as BatchSettlementPayer,
      describe: async () => DESCRIPTION,
    });
    await expect(f.open()).rejects.toThrow(/offers no x402 channel on evm/);
  });

  it('deposits through the payer, and reports the new total', async () => {
    const { f, manager } = facade({});
    const topUps: bigint[] = [];
    const g = new ClientChannelFacade({
      connector: CONNECTOR,
      chain: 'solana',
      manager,
      payer: {
        topUp: async (_d: unknown, _c: unknown, amount: bigint) => {
          topUps.push(amount);
          manager.adopt(CONNECTOR, CHANNEL, 5_000n + amount);
          return CHANNEL;
        },
      } as unknown as BatchSettlementPayer,
      describe: async () => DESCRIPTION,
    });
    expect(f.channels()).toEqual([]);
    const after = await g.deposit(2_000n);
    expect(topUps).toEqual([2_000n]);
    expect(after.depositTotal).toBe(7_000n);
  });

  it('has nothing to close before a channel is open', async () => {
    await expect(facade({}).f.close()).rejects.toThrow(ChannelNotOpenError);
  });

  it('closes every open channel, archived ones included, and none twice', async () => {
    const { f, manager, chain } = facade({
      [CHANNEL.channelId]: 0,
      [OTHER.channelId]: 0,
    });
    manager.adopt(CONNECTOR, OTHER, 1_000n);
    manager.adopt(CONNECTOR, CHANNEL, 5_000n); // archives OTHER
    const closed = await f.close();
    expect(closed.map((r) => r.channelId).sort()).toEqual(
      [CHANNEL.channelId, OTHER.channelId].sort()
    );
    expect(closed.every((r) => r.transaction === 'sig')).toBe(true);
    expect(chain.methods.filter((m) => m === 'sendTransaction')).toHaveLength(
      2
    );
    await expect(f.close()).rejects.toThrow(ChannelNotOpenError);
  });

  it('settles only a channel whose window has passed', async () => {
    const early = facade({ [CHANNEL.channelId]: 2 }, 1_000n);
    await early.f.open();
    early.manager.markClosing(CHANNEL.channelId, 900n, 2_000n);
    expect(await early.f.settle()).toEqual([]);
    expect(early.chain.methods).not.toContain('sendTransaction');

    const due = facade({ [CHANNEL.channelId]: 1 }, 3_000n);
    await due.f.open();
    due.manager.markClosing(CHANNEL.channelId, 900n, 2_000n);
    expect(await due.f.settle()).toEqual([
      { channelId: CHANNEL.channelId, transaction: 'sig' },
    ]);
    expect(due.f.channels()[0]!.settledAt).toBe(3_000n);
    expect(await due.f.settle()).toEqual([]);
  });

  it('takes back a channel the connector sealed first, with no close of ours', async () => {
    const { f } = facade({ [CHANNEL.channelId]: 1 });
    await f.open();
    expect(await f.settle()).toEqual([
      { channelId: CHANNEL.channelId, transaction: 'sig' },
    ]);
  });

  it('counts a cleaned-up channel as settled, and does not let one channel block the rest', async () => {
    const { f, manager } = facade({
      [OTHER.channelId]: null,
      [CHANNEL.channelId]: 1,
    });
    manager.adopt(CONNECTOR, OTHER, 1_000n);
    manager.adopt(CONNECTOR, CHANNEL, 5_000n);
    manager.markClosing(OTHER.channelId, 1n, 2n);
    const results = await f.settle();
    expect(results).toEqual(
      expect.arrayContaining([
        { channelId: OTHER.channelId },
        { channelId: CHANNEL.channelId, transaction: 'sig' },
      ])
    );
  });
});
