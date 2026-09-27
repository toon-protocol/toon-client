import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { ClientBatchSettlementFacade } from './batch-settlement-facade.js';
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

/** A Solana RPC holding one channel account in `status`; records methods called. */
function rpc(status: number) {
  const account = new Uint8Array(256);
  account[0] = 1;
  account[3] = status;
  new DataView(account.buffer).setUint32(52, 86_400, true);
  const methods: string[] = [];
  const fetchImpl = (async (_u: string, init?: RequestInit) => {
    const { method } = JSON.parse(init!.body as string) as { method: string };
    methods.push(method);
    const result =
      method === 'getAccountInfo'
        ? {
            value: {
              owner: PAYMENT_CHANNELS_PROGRAM_ID,
              data: [Buffer.from(account).toString('base64'), 'base64'],
            },
          }
        : method === 'getLatestBlockhash'
          ? {
              value: {
                blockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N',
              },
            }
          : method === 'sendTransaction'
            ? 'sig'
            : { value: [{ confirmationStatus: 'confirmed', err: null }] };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
  }) as typeof fetch;
  return { target: { url: 'http://rpc', fetchImpl }, methods };
}

function facade(status: number, now = 1_000n) {
  const manager = new BatchChannelManager();
  const chain = rpc(status);
  const f = new ClientBatchSettlementFacade({
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

describe('client.batchSettlement', () => {
  it('opens on request, and lists what it holds', async () => {
    const { f } = facade(0);
    expect(f.channels()).toEqual([]);
    const opened = await f.open();
    expect(opened).toMatchObject({
      channel: CHANNEL,
      depositTotal: 5_000n,
      signed: 0n,
    });
    expect(f.channels()).toHaveLength(1);
  });

  it('has nothing to close before a channel is open', async () => {
    await expect(facade(0).f.close()).rejects.toThrow(ChannelNotOpenError);
  });

  it('closes the live channel, and will not close it twice', async () => {
    const { f, manager } = facade(0);
    await f.open();
    const closed = await f.close();
    expect(closed.channelId).toBe(CHANNEL.channelId);
    expect(manager.isClosing(CHANNEL.channelId)).toBe(true);
    await expect(f.close()).rejects.toThrow(ChannelNotOpenError);
  });

  it('settles only a channel whose window has passed', async () => {
    const early = facade(1, 1_000n);
    await early.f.open();
    early.manager.markClosing(CHANNEL.channelId, 900n, 2_000n);
    expect(await early.f.settle()).toEqual([]);
    expect(early.chain.methods).not.toContain('sendTransaction');

    const due = facade(1, 3_000n);
    await due.f.open();
    due.manager.markClosing(CHANNEL.channelId, 900n, 2_000n);
    expect(await due.f.settle()).toEqual([
      { channelId: CHANNEL.channelId, transaction: 'sig' },
    ]);
    expect(due.f.channels()[0]!.settledAt).toBe(3_000n);
    expect(await due.f.settle()).toEqual([]);
  });
});
