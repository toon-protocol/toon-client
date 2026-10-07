import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { BatchSettlementPayer } from './payer.js';
import { BatchChannelManager } from './manager.js';
import { buildSvmVoucherMessage } from './svm.js';
import { parseSelfDescription } from '../../connector/self-description.js';
import { parseSolanaWireTransaction } from '../solana/wire-transaction.js';
import {
  deriveAssociatedTokenAccount,
  type Signer,
} from '../solana/payment-channel.js';
import { base58Decode, base58Encode } from '../../utils/base58.js';
import { fromBase64 } from '../../utils/binary.js';
import {
  ConfigError,
  InsufficientBalanceError,
  SponsorRefusedError,
  ValidationError,
} from '../../client/errors.js';
import { must } from '../../utils/must.test-support.js';

function keypair(n: number): Signer & { address: string } {
  const privateKey = new Uint8Array(32).fill(n);
  const publicKey = ed25519.getPublicKey(privateKey);
  return { privateKey, publicKey, address: base58Encode(publicKey) };
}

const PAYER = keypair(1);
const SPONSOR = keypair(2);
const RECEIVER = keypair(4);
const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const BLOCKHASH = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N';

const DESCRIPTION = parseSelfDescription({
  batchSettlements: [
    {
      network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
      asset: MINT,
      payTo: RECEIVER.address,
      feePayer: SPONSOR.address,
      withdrawDelay: 86_400,
      tokenProgram: TOKEN_PROGRAM,
      minDeposit: '1000000',
      sponsorEndpoint: '/ilp/batch-settlement/solana/open',
    },
  ],
});

interface World {
  /** Channel accounts on chain: PDA → deposit. */
  landed: Map<string, bigint>;
  /** Channels the sponsor was asked to open, in order. */
  channels: string[];
  mintOwner: string;
  ataBalance: bigint | null;
  sponsorAnswer?: (channelId: string) => { status: number; body: unknown };
  opens: string[];
}

/** One `fetch` for both the Solana RPC and the connector's sponsor endpoint. */
function fakeFetch(world: World): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(must(init).body as string) as {
      method?: string;
      params?: unknown[];
      transaction?: string;
    };
    if (url === 'https://node.example/ilp/batch-settlement/solana/open') {
      world.opens.push(must(body.transaction));
      const tx = parseSolanaWireTransaction(must(body.transaction));
      // Only the payer has signed, and its signature is good.
      expect(tx.signers).toEqual([SPONSOR.address, PAYER.address]);
      expect(tx.unsigned).toEqual([SPONSOR.address]);
      const bytes = fromBase64(must(body.transaction));
      expect(
        ed25519.verify(
          bytes.subarray(tx.signaturesOffset + 64, tx.signaturesOffset + 128),
          bytes.subarray(tx.messageOffset),
          PAYER.publicKey
        )
      ).toBe(true);
      // The channel is the account whose ATA the open also names.
      const channelId = tx.staticAccounts.find(
        (a) =>
          a !== PAYER.address &&
          tx.staticAccounts.includes(deriveAssociatedTokenAccount(a, MINT))
      )!;
      world.channels.push(channelId);
      const answer = world.sponsorAnswer?.(channelId) ?? {
        status: 200,
        body: {
          channelId,
          transaction: 'sig',
          payer: PAYER.address,
          deposit: '1000000',
        },
      };
      return new Response(JSON.stringify(answer.body), {
        status: answer.status,
      });
    }
    expect(url).toBe('http://rpc');
    const result = (() => {
      switch (body.method) {
        case 'getAccountInfo': {
          const address = must(body.params)[0] as string;
          if (address === MINT) {
            return {
              value: {
                owner: world.mintOwner,
                data: ['', 'base64'],
                lamports: 1,
              },
            };
          }
          // A channel account: present only once the test says it landed.
          const deposit = world.landed.get(address);
          if (deposit === undefined) return { value: null };
          const account = new Uint8Array(256);
          account[0] = 1;
          new DataView(account.buffer).setBigUint64(12, deposit, true);
          return {
            value: {
              owner: 'CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX',
              data: [Buffer.from(account).toString('base64'), 'base64'],
              lamports: 1,
            },
          };
        }
        case 'getTokenAccountBalance':
          expect(must(body.params)[0]).toBe(
            deriveAssociatedTokenAccount(PAYER.address, MINT)
          );
          if (world.ataBalance === null) return { value: null };
          return { value: { amount: world.ataBalance.toString() } };
        case 'getSlot':
          return 400_000_000;
        case 'getLatestBlockhash':
          return { value: { blockhash: BLOCKHASH } };
        default:
          throw new Error(`unexpected RPC ${body.method}`);
      }
    })();
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
  }) as typeof fetch;
}

function setup(overrides: Partial<World> = {}, deposit = 1_000_000n) {
  const world: World = {
    landed: new Map(),
    channels: [],
    mintOwner: TOKEN_PROGRAM,
    ataBalance: 10_000_000n,
    opens: [],
    ...overrides,
  };
  const fetchImpl = fakeFetch(world);
  const manager = new BatchChannelManager();
  const payer = new BatchSettlementPayer({
    connector: 'https://node.example',
    manager,
    deposit,
    solana: { signer: PAYER, rpc: { url: 'http://rpc', fetchImpl } },
    fetch: fetchImpl,
  });
  return { world, manager, payer };
}

describe('BatchSettlementPayer on Solana', () => {
  it('opens through the connector’s sponsor, with the payer signing only its own slot', async () => {
    const { world, payer, manager } = setup();
    const voucher = await payer.claimFor(DESCRIPTION, 'solana', 1_000n);
    expect(world.opens).toHaveLength(1);
    expect(must(voucher).chain).toBe('solana');
    expect(must(voucher).cumulative).toBe(1_000n);
    expect(manager.depositTotal(must(voucher).channelId)).toBe(1_000_000n);
    expect(must(voucher).claim).toMatchObject({
      blockchain: 'solana',
      scheme: 'batch-settlement',
      channelId: must(voucher).channelId,
      expiresAt: 0,
      maxClaimableAmount: '1000',
      senderId: PAYER.address,
    });
    expect(
      ed25519.verify(
        base58Decode(must(voucher).claim['signature'] as string),
        buildSvmVoucherMessage(must(voucher).channelId, 1_000n),
        PAYER.publicKey
      )
    ).toBe(true);
  });

  it('pays later packets from the same channel', async () => {
    const { world, payer } = setup();
    const first = await payer.claimFor(DESCRIPTION, 'solana', 1_000n);
    const second = await payer.claimFor(DESCRIPTION, 'solana', 500n);
    expect(world.opens).toHaveLength(1);
    expect(must(second).channelId).toBe(must(first).channelId);
    expect(must(second).cumulative).toBe(1_500n);
  });

  it('replaces an exhausted channel with a fresh sponsored one, rather than spend SOL on a top-up', async () => {
    const { world, payer } = setup();
    const first = await payer.claimFor(DESCRIPTION, 'solana', 999_000n);
    const second = await payer.claimFor(DESCRIPTION, 'solana', 5_000n);
    expect(world.opens).toHaveLength(2);
    expect(must(second).channelId).not.toBe(must(first).channelId);
    expect(must(second).cumulative).toBe(5_000n);
  });

  it('with autoOpen off, names the way out of an exhausted channel: close it, then open', async () => {
    const { payer, manager, world } = setup();
    await payer.claimFor(DESCRIPTION, 'solana', 999_000n);
    const strict = new BatchSettlementPayer({
      connector: 'https://node.example',
      manager,
      deposit: 1_000_000n,
      solana: { signer: PAYER, rpc: { url: 'http://rpc', fetchImpl: fakeFetch(world) } },
      fetch: fakeFetch(world),
      autoOpen: false,
    });
    await expect(strict.claimFor(DESCRIPTION, 'solana', 5_000n)).rejects.toThrow(
      /toon-client channel close`, then `toon-client channel open/
    );
  });

  it('deposits at least the connector’s published minimum', async () => {
    const { payer, manager } = setup({}, 10n);
    const voucher = await payer.claimFor(DESCRIPTION, 'solana', 1_000n);
    expect(manager.depositTotal(must(voucher).channelId)).toBe(1_000_000n);
  });

  it('surfaces the sponsor’s refusal by name', async () => {
    const { payer } = setup({
      sponsorAnswer: () => ({
        status: 422,
        body: {
          error: 'cluster_rent_threshold_unsupported',
          detail: 'pre-v3 cluster',
        },
      }),
    });
    const err = await payer
      .claimFor(DESCRIPTION, 'solana', 1_000n)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SponsorRefusedError);
    expect((err as SponsorRefusedError).reason).toBe(
      'cluster_rent_threshold_unsupported'
    );
  });

  it('refuses a sponsor that reports opening some other channel', async () => {
    const { payer } = setup({
      sponsorAnswer: () => ({
        status: 200,
        body: {
          channelId: SPONSOR.address,
          transaction: 's',
          payer: PAYER.address,
          deposit: '1',
        },
      }),
    });
    await expect(payer.claimFor(DESCRIPTION, 'solana', 1_000n)).rejects.toThrow(
      ValidationError
    );
  });

  it('checks the token program against the mint’s owner, and the payer’s token account', async () => {
    await expect(
      setup({
        mintOwner: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
      }).payer.claimFor(DESCRIPTION, 'solana', 1_000n)
    ).rejects.toThrow(ConfigError);
    await expect(
      setup({ ataBalance: null }).payer.claimFor(DESCRIPTION, 'solana', 1_000n)
    ).rejects.toThrow(InsufficientBalanceError);
    await expect(
      setup({ ataBalance: 5n }).payer.claimFor(DESCRIPTION, 'solana', 1_000n)
    ).rejects.toThrow(InsufficientBalanceError);
  });

  it('keeps a channel whose sponsor answered 502, and adopts it once the chain shows it', async () => {
    const { world, payer, manager } = setup({
      sponsorAnswer: () => ({
        status: 502,
        body: { error: 'submission_failed', detail: 'timeout' },
      }),
    });
    await expect(payer.claimFor(DESCRIPTION, 'solana', 1_000n)).rejects.toThrow(
      SponsorRefusedError
    );
    const channelId = must(world.channels[0]);
    expect(manager.pendingDeposit(channelId)).toBe(1_000_000n);

    world.landed.set(channelId, 1_000_000n);
    world.sponsorAnswer = undefined;
    const voucher = await payer.claimFor(DESCRIPTION, 'solana', 1_000n);
    expect(must(voucher).channelId).toBe(channelId);
    expect(world.opens).toHaveLength(1);
    expect(manager.depositTotal(channelId)).toBe(1_000_000n);
  });

  it('forgets a channel whose sponsor definitely refused, and opens afresh', async () => {
    const { world, payer, manager } = setup({
      sponsorAnswer: () => ({
        status: 422,
        body: { error: 'deposit_below_minimum', detail: '' },
      }),
    });
    await expect(payer.claimFor(DESCRIPTION, 'solana', 1_000n)).rejects.toThrow(
      SponsorRefusedError
    );
    expect(manager.channels('https://node.example')).toEqual([]);
    world.sponsorAnswer = undefined;
    await payer.claimFor(DESCRIPTION, 'solana', 1_000n);
    expect(world.opens).toHaveLength(2);
  });

  it('opens afresh when a 502 open never landed', async () => {
    const { world, payer } = setup({
      sponsorAnswer: () => ({
        status: 502,
        body: { error: 'submission_failed', detail: '' },
      }),
    });
    await expect(
      payer.claimFor(DESCRIPTION, 'solana', 1_000n)
    ).rejects.toThrow();
    world.sponsorAnswer = undefined;
    const voucher = await payer.claimFor(DESCRIPTION, 'solana', 1_000n);
    expect(world.opens).toHaveLength(2);
    expect(must(voucher).channelId).toBe(world.channels[1]);
  });
});
