import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import type { Hex, TransactionReceipt } from 'viem';
import {
  buildSvmRequestCloseInstruction,
  buildSvmSealInstruction,
  buildSvmWithdrawPayerInstruction,
  finalizeEvmBatchWithdraw,
  initiateEvmBatchWithdraw,
  requestSvmBatchClose,
  withdrawSvmBatchChannel,
  type EvmExitClients,
} from './exit.js';
import { PAYMENT_CHANNELS_PROGRAM_ID } from './svm.js';
import {
  deriveAssociatedTokenAccount,
  type Signer,
} from '../solana/payment-channel.js';
import { base58Encode } from '../../utils/base58.js';
import { ValidationError } from '../../client/errors.js';

const CHANNEL = `0x${'ab'.repeat(32)}` as Hex;
const CONFIG = {
  payer: '0x1111111111111111111111111111111111111111',
  payerAuthorizer: '0x1111111111111111111111111111111111111111',
  receiver: '0x3333333333333333333333333333333333333333',
  receiverAuthorizer: '0x3333333333333333333333333333333333333333',
  token: '0x5555555555555555555555555555555555555555',
  withdrawDelay: 86_400,
  salt: `0x${'66'.repeat(32)}` as Hex,
};

function evmChain(state: {
  balance: bigint;
  claimed: bigint;
  pending: bigint;
  initiatedAt: number;
}) {
  const writes: { functionName: string; args: unknown[] }[] = [];
  const clients: EvmExitClients = {
    publicClient: {
      readContract: async (p: never) => {
        const { functionName } = p as { functionName: string };
        return functionName === 'channels'
          ? [state.balance, state.claimed]
          : [state.pending, state.initiatedAt];
      },
      waitForTransactionReceipt: async ({ hash }) =>
        ({ status: 'success', transactionHash: hash }) as TransactionReceipt,
    },
    walletClient: {
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
    },
  };
  return { clients, writes };
}

describe('EVM exit', () => {
  it('withdraws everything unclaimed, finalizable after withdrawDelay', async () => {
    const { clients, writes } = evmChain({
      balance: 10_000n,
      claimed: 3_000n,
      pending: 0n,
      initiatedAt: 0,
    });
    const started = await initiateEvmBatchWithdraw(clients, {
      channelId: CHANNEL,
      config: CONFIG,
    });
    expect(started).toEqual({
      transaction: '0xfeed',
      amount: 7_000n,
      finalizeAfter: 1_790_000_000n + 86_400n,
    });
    expect(writes[0]!.functionName).toBe('initiateWithdraw');
    expect(writes[0]!.args[0]).toMatchObject({
      payer: CONFIG.payer,
      salt: CONFIG.salt,
      withdrawDelay: 86_400,
    });
  });

  it('refuses a second withdrawal, or one with nothing to take', async () => {
    await expect(
      initiateEvmBatchWithdraw(
        evmChain({ balance: 10n, claimed: 0n, pending: 5n, initiatedAt: 1 })
          .clients,
        { channelId: CHANNEL, config: CONFIG }
      )
    ).rejects.toThrow(/pending/);
    await expect(
      initiateEvmBatchWithdraw(
        evmChain({ balance: 10n, claimed: 10n, pending: 0n, initiatedAt: 0 })
          .clients,
        { channelId: CHANNEL, config: CONFIG }
      )
    ).rejects.toThrow(/nothing unclaimed/);
  });

  it('finalizes only once the delay has passed', async () => {
    const { clients, writes } = evmChain({
      balance: 10n,
      claimed: 0n,
      pending: 10n,
      initiatedAt: 1_000,
    });
    await expect(
      finalizeEvmBatchWithdraw(
        clients,
        { channelId: CHANNEL, config: CONFIG },
        1_000n + 86_399n
      )
    ).rejects.toThrow(ValidationError);
    await finalizeEvmBatchWithdraw(
      clients,
      { channelId: CHANNEL, config: CONFIG },
      1_000n + 86_400n
    );
    expect(writes.map((w) => w.functionName)).toEqual(['finalizeWithdraw']);
  });
});

function keypair(n: number): Signer {
  const privateKey = new Uint8Array(32).fill(n);
  return { privateKey, publicKey: ed25519.getPublicKey(privateKey) };
}

const PAYER = keypair(1);
const PAYER_ADDRESS = base58Encode(PAYER.publicKey);
const SVM_CHANNEL = 'WLNQ714q14a3SEXsbrXKDsWoxugYdGA6brPDGXpUWjX';
const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

describe('Solana exit instructions', () => {
  it('request_close is discriminator 5 over [payer, channel]', () => {
    const ix = buildSvmRequestCloseInstruction(SVM_CHANNEL, PAYER_ADDRESS);
    expect(ix.programId).toBe(PAYMENT_CHANNELS_PROGRAM_ID);
    expect([...ix.data]).toEqual([5]);
    expect(ix.keys).toEqual([
      { pubkey: PAYER_ADDRESS, isSigner: true, isWritable: false },
      { pubkey: SVM_CHANNEL, isSigner: false, isWritable: true },
    ]);
  });

  it('seal is discriminator 6 over [channel]', () => {
    const ix = buildSvmSealInstruction(SVM_CHANNEL);
    expect([...ix.data]).toEqual([6]);
    expect(ix.keys).toEqual([
      { pubkey: SVM_CHANNEL, isSigner: false, isWritable: true },
    ]);
  });

  it('withdraw_payer is discriminator 8 over the six accounts the program reads', () => {
    const ix = buildSvmWithdrawPayerInstruction(SVM_CHANNEL, {
      payer: PAYER_ADDRESS,
      token: MINT,
    });
    expect([...ix.data]).toEqual([8]);
    expect(ix.keys.map((k) => k.pubkey)).toEqual([
      PAYER_ADDRESS,
      SVM_CHANNEL,
      deriveAssociatedTokenAccount(SVM_CHANNEL, MINT),
      deriveAssociatedTokenAccount(PAYER_ADDRESS, MINT),
      MINT,
      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    ]);
  });
});

/** A fake Solana RPC over one channel account; records the transactions sent. */
function solanaChain(
  status: number,
  closureStartedAt: bigint,
  gracePeriod = 86_400
) {
  const account = new Uint8Array(256);
  account[0] = 1;
  account[3] = status;
  const view = new DataView(account.buffer);
  view.setBigInt64(36, closureStartedAt, true);
  view.setUint32(52, gracePeriod, true);
  const sent: string[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const { method, params } = JSON.parse(init!.body as string) as {
      method: string;
      params: unknown[];
    };
    const result = (() => {
      switch (method) {
        case 'getAccountInfo':
          return {
            value: {
              owner: PAYMENT_CHANNELS_PROGRAM_ID,
              data: [Buffer.from(account).toString('base64'), 'base64'],
            },
          };
        case 'getLatestBlockhash':
          return {
            value: {
              blockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N',
            },
          };
        case 'sendTransaction':
          sent.push(params[0] as string);
          return `sig${sent.length}`;
        case 'getSignatureStatuses':
          return { value: [{ confirmationStatus: 'confirmed', err: null }] };
        default:
          throw new Error(`unexpected ${method}`);
      }
    })();
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
  }) as typeof fetch;
  return { rpc: { url: 'http://rpc', fetchImpl }, sent };
}

/** The instruction discriminators in a sent legacy transaction, in order. */
function discriminators(wire: string): number[] {
  const bytes = Buffer.from(wire, 'base64');
  let o = 1 + bytes[0]! * 64; // signature count (<128) and slots
  o += 3;
  const keys = bytes[o]!;
  o += 1 + keys * 32 + 32;
  const count = bytes[o++]!;
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    o += 1;
    const accounts = bytes[o++]!;
    o += accounts;
    const len = bytes[o++]!;
    out.push(bytes[o]!);
    o += len;
  }
  return out;
}

describe('Solana exit', () => {
  it('requests the close of an Open channel', async () => {
    const { rpc, sent } = solanaChain(0, 0n);
    const result = await requestSvmBatchClose(rpc, PAYER, SVM_CHANNEL);
    expect(result.transaction).toBe('sig1');
    expect(discriminators(sent[0]!)).toEqual([5]);
  });

  it('refuses to close a channel that is not Open', async () => {
    const { rpc } = solanaChain(2, 1_000n);
    await expect(requestSvmBatchClose(rpc, PAYER, SVM_CHANNEL)).rejects.toThrow(
      /closing, not open/
    );
  });

  it('seals and withdraws in one transaction once the grace period has passed', async () => {
    const { rpc, sent } = solanaChain(2, 1_000n);
    await expect(
      withdrawSvmBatchChannel(
        rpc,
        PAYER,
        SVM_CHANNEL,
        { payer: PAYER_ADDRESS, token: MINT },
        1_000n + 86_399n
      )
    ).rejects.toThrow(/not yet/);
    await withdrawSvmBatchChannel(
      rpc,
      PAYER,
      SVM_CHANNEL,
      { payer: PAYER_ADDRESS, token: MINT },
      1_000n + 86_400n
    );
    expect(discriminators(sent[0]!)).toEqual([6, 8]);
  });

  it('only withdraws from a channel the connector already sealed', async () => {
    const { rpc, sent } = solanaChain(1, 0n);
    await withdrawSvmBatchChannel(rpc, PAYER, SVM_CHANNEL, {
      payer: PAYER_ADDRESS,
      token: MINT,
    });
    expect(discriminators(sent[0]!)).toEqual([8]);
  });
});
