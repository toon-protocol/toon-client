/**
 * The Solana settlement network's voucher scheme, through the settlement
 * network interface, against the connector's wire vectors: the voucher's claim
 * and the claim-state challenge, byte for byte.
 */
import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  SolanaSettlementNetwork,
  buildSvmRequestCloseInstruction,
  buildSvmSealInstruction,
  buildSvmWithdrawPayerInstruction,
  solanaStoredForm,
} from './solana-network.js';
import { PAYMENT_CHANNELS_PROGRAM_ID } from './svm.js';
import { deriveAssociatedTokenAccount } from '../solana/json-rpc.js';
import { base58Encode } from '../../utils/base58.js';
import type { BatchChannel } from './manager.js';
import type { BatchSettlementBinding } from '../ChannelStore.js';
import { hexToBytes, loadWireVectors } from '../../wire/vectors/load.js';
import { must } from '../../utils/must.test-support.js';

const vectors = loadWireVectors();

// The connector's fixture key for the Solana voucher: 32 bytes of 0x21.
const VOUCHER_KEY = new Uint8Array(32).fill(0x21);

const noFetch = (async () => {
  throw new Error('the voucher scheme reaches nothing');
}) as typeof fetch;

function network(privateKey: Uint8Array): SolanaSettlementNetwork {
  return new SolanaSettlementNetwork({
    signer: { privateKey, publicKey: ed25519.getPublicKey(privateKey) },
    rpc: { url: 'http://rpc.invalid', fetch: noFetch },
    fetch: noFetch,
    connector: 'https://node.example',
  });
}

/** A Solana channel at `channelId`; the voucher scheme reads only its id. */
function channelAt(channelId: string): BatchChannel {
  return {
    chain: 'solana',
    channelId,
    network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
    sponsor: channelId,
    config: {} as Extract<BatchChannel, { chain: 'solana' }>['config'],
  };
}

describe('the Solana settlement network', () => {
  it('pays on solana networks only, and replaces rather than tops up', () => {
    const n = network(VOUCHER_KEY);
    expect(n.serves('solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1')).toBe(true);
    expect(n.serves('eip155:84532')).toBe(false);
    expect(n.cover).toEqual({
      kind: 'replace',
      noTopUp:
        'a Solana batch-settlement channel is not topped up: the next payment it cannot cover opens a fresh sponsored one',
    });
  });

  it('voucher scheme: signs the published voucher into the published claim, byte for byte', async () => {
    const v = must(vectors.claim_voucher).solana;
    const claim = await network(VOUCHER_KEY).voucher(
      channelAt(v.channel_account_base58),
      BigInt(v.max_claimable_amount)
    );
    const published = JSON.parse(v.json) as Record<string, unknown>;
    expect(
      JSON.stringify({
        ...claim,
        messageId: published['messageId'],
        timestamp: published['timestamp'],
      })
    ).toBe(v.json);
  });

  it.each(
    must(vectors.voucher_claim_state_challenge).solana.map(
      (c) => [c.name, c] as const
    )
  )('claim-state challenge: %s', async (_name, c) => {
    const entry = await network(hexToBytes(c.signer_secret_hex)).challenge(
      channelAt(c.channel_account_base58),
      BigInt(c.expires)
    );
    expect(JSON.stringify(entry)).toBe(c.entry_json);
  });
});

describe('the Solana stored form', () => {
  // A channel exactly as the previous release wrote it to the channel record:
  // the u64 salt and open slot as decimal strings.
  const STORED: BatchSettlementBinding = {
    chain: 'solana',
    network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
    sponsor: '9hSR6S7WPtxmTojgo6GG3k4yDPecgJY292j7xrsUGWBu',
    config: {
      payer: 'AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9',
      payerAuthorizer: 'GyGKxMyg1p9SsHfm15MkNUu1u9TN2JtTspcdmrtGUdse',
      receiver: 'EdmxWPmx2WH6WgFfTdu9xfkYf3k1g5wD1zccTVySEEh1',
      token: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
      withdrawDelay: 86_400,
      salt: '9223372036854775850',
      openSlot: '400000000',
    },
  };
  const ID = 'WLNQ714q14a3SEXsbrXKDsWoxugYdGA6brPDGXpUWjX';

  it('reads a stored channel back, and writes it out exactly as it was stored', () => {
    const n = network(VOUCHER_KEY);
    const channel = n.fromStored(ID, STORED);
    expect(channel).toEqual({
      chain: 'solana',
      channelId: ID,
      network: STORED.network,
      sponsor: '9hSR6S7WPtxmTojgo6GG3k4yDPecgJY292j7xrsUGWBu',
      config: {
        ...STORED.config,
        salt: 2n ** 63n + 42n,
        openSlot: 400_000_000n,
      },
    });
    expect(n.toStored(channel)).toEqual(STORED);
  });

  it('is the same without a key, for reading channels this client no longer pays from', () => {
    expect(solanaStoredForm.serves(STORED.network)).toBe(true);
    expect(
      solanaStoredForm.toStored(solanaStoredForm.fromStored(ID, STORED))
    ).toEqual(STORED);
  });
});

const PAYER_KEY = new Uint8Array(32).fill(1);
const PAYER_ADDRESS = base58Encode(ed25519.getPublicKey(PAYER_KEY));
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

const STATUS = { open: 0, sealed: 1, closing: 2, gone: null } as const;

/**
 * The network over a fake Solana RPC holding one channel account (`gone` for
 * none); records the transactions sent.
 */
function onChain(
  status: keyof typeof STATUS,
  options: {
    closureStartedAt?: bigint;
    gracePeriod?: number;
    payerWithdrawnAt?: bigint;
    lamports?: number;
  } = {}
) {
  const account = new Uint8Array(256);
  account[0] = 1;
  account[3] = STATUS[status] ?? 0;
  const view = new DataView(account.buffer);
  view.setBigInt64(36, options.closureStartedAt ?? 0n, true);
  view.setBigInt64(44, options.payerWithdrawnAt ?? 0n, true);
  view.setUint32(52, options.gracePeriod ?? 86_400, true);
  const sent: string[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const { method, params } = JSON.parse(must(init).body as string) as {
      method: string;
      params: unknown[];
    };
    const result = (() => {
      switch (method) {
        case 'getAccountInfo':
          return STATUS[status] === null
            ? { value: null }
            : {
                value: {
                  owner: PAYMENT_CHANNELS_PROGRAM_ID,
                  data: [Buffer.from(account).toString('base64'), 'base64'],
                },
              };
        case 'getBalance':
          return { value: options.lamports ?? 1_000_000_000 };
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
  const n = new SolanaSettlementNetwork({
    signer: {
      privateKey: PAYER_KEY,
      publicKey: ed25519.getPublicKey(PAYER_KEY),
    },
    rpc: { url: 'http://rpc', fetch: fetchImpl },
    fetch: noFetch,
    connector: 'https://node.example',
  });
  return { n, sent };
}

/** The instruction discriminators in a sent legacy transaction, in order. */
function discriminators(wire: string): number[] {
  const bytes = Buffer.from(wire, 'base64');
  let o = 1 + must(bytes[0]) * 64; // signature count (<128) and slots
  o += 3;
  const keys = must(bytes[o]);
  o += 1 + keys * 32 + 32;
  const count = must(bytes[o++]);
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    o += 1;
    const accounts = must(bytes[o++]);
    o += accounts;
    const len = must(bytes[o++]);
    out.push(must(bytes[o]));
    o += len;
  }
  return out;
}

const EXIT_CHANNEL: BatchChannel = {
  chain: 'solana',
  channelId: SVM_CHANNEL,
  network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  sponsor: '9hSR6S7WPtxmTojgo6GG3k4yDPecgJY292j7xrsUGWBu',
  config: {
    payer: PAYER_ADDRESS,
    payerAuthorizer: PAYER_ADDRESS,
    receiver: 'EdmxWPmx2WH6WgFfTdu9xfkYf3k1g5wD1zccTVySEEh1',
    token: MINT,
    withdrawDelay: 86_400,
    salt: 1n,
    openSlot: 2n,
  },
};

describe('leaving a Solana channel', () => {
  it('close: requests the close of an Open channel, settleable after the grace period', async () => {
    const { n, sent } = onChain('open');
    expect(await n.close(EXIT_CHANNEL, 1_000n)).toEqual({
      kind: 'closing',
      transaction: 'sig1',
      settleableAt: 1_000n + 86_400n,
    });
    expect(discriminators(must(sent[0]))).toEqual([5]);
  });

  it('close: a channel already closing is settleable when its grace period ends, with no transaction', async () => {
    const { n, sent } = onChain('closing', { closureStartedAt: 500n });
    expect(await n.close(EXIT_CHANNEL, 1_000n)).toEqual({
      kind: 'closing',
      settleableAt: 500n + 86_400n,
    });
    expect(sent).toEqual([]);
  });

  it('close: a channel the connector sealed is settleable now', async () => {
    const { n, sent } = onChain('sealed');
    expect(await n.close(EXIT_CHANNEL, 1_000n)).toEqual({
      kind: 'closing',
      settleableAt: 1_000n,
    });
    expect(sent).toEqual([]);
  });

  it('close: a channel gone or already refunded is done', async () => {
    expect(await onChain('gone').n.close(EXIT_CHANNEL, 1_000n)).toEqual({
      kind: 'done',
    });
    expect(
      await onChain('sealed', { payerWithdrawnAt: 900n }).n.close(
        EXIT_CHANNEL,
        1_000n
      )
    ).toEqual({ kind: 'done' });
  });

  it('close: says leaving needs SOL, and sends nothing, when the wallet holds none', async () => {
    const { n, sent } = onChain('open', { lamports: 0 });
    await expect(n.close(EXIT_CHANNEL, 1_000n)).rejects.toThrow(
      /leaving a channel needs SOL for the fee.*holds none/
    );
    expect(sent).toEqual([]);
  });

  it('settle: leaves a closing channel inside its window alone', async () => {
    const { n, sent } = onChain('closing', { closureStartedAt: 1_000n });
    expect(await n.settle(EXIT_CHANNEL, { due: false, now: 1_000n })).toEqual({
      kind: 'not-yet',
    });
    expect(sent).toEqual([]);
  });

  it('settle: seals and withdraws in one transaction once the grace period has passed', async () => {
    const early = onChain('closing', { closureStartedAt: 1_000n });
    await expect(
      early.n.settle(EXIT_CHANNEL, { due: true, now: 1_000n + 86_399n })
    ).rejects.toThrow(/not yet/);
    const { n, sent } = onChain('closing', { closureStartedAt: 1_000n });
    expect(
      await n.settle(EXIT_CHANNEL, { due: true, now: 1_000n + 86_400n })
    ).toEqual({ kind: 'settled', transaction: 'sig1' });
    expect(discriminators(must(sent[0]))).toEqual([6, 8]);
  });

  it('settle: takes back a channel the connector sealed first, with no close of ours', async () => {
    const { n, sent } = onChain('sealed');
    expect(await n.settle(EXIT_CHANNEL, { due: false, now: 1_000n })).toEqual({
      kind: 'settled',
      transaction: 'sig1',
    });
    expect(discriminators(must(sent[0]))).toEqual([8]);
  });

  it('settle: counts a channel gone or already refunded as settled, with no transaction', async () => {
    const { n, sent } = onChain('gone');
    expect(await n.settle(EXIT_CHANNEL, { due: false, now: 1_000n })).toEqual({
      kind: 'settled',
    });
    expect(sent).toEqual([]);
  });
});
