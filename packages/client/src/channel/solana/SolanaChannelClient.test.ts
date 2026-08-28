/**
 * `SolanaChannelClient` — the binding layer, tested for the decisions it makes
 * on its own rather than for the wire it delegates.
 *
 * The wire itself is pinned by `payment-channel.test.ts` and executed for real
 * by `src/__integration__/solana-channel-lifecycle.integration.test.ts`. What is
 * left here is what this class decides: which side of a sorted participant pair
 * is "us", which token accounts a settlement pays into, and what domain a claim
 * is signed under.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base58Encode } from '../../utils/base58.js';
import { SolanaChannelClient } from './SolanaChannelClient.js';
import * as paymentChannel from './payment-channel.js';

const PROGRAM_ID = 'HY4AYFNe5Vg5BkEwAURNsGY3uFAvGMNpAQPRtgoasJiR';
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const seed = sha256(new TextEncoder().encode('solana-channel-client/payer'));
const PAYER = base58Encode(new Uint8Array(ed25519.getPublicKey(seed)));
const PEER = 'So11111111111111111111111111111111111111112';

function clientFor(overrides: Record<string, unknown> = {}): SolanaChannelClient {
  return new SolanaChannelClient({
    rpcUrl: 'http://127.0.0.1:1',
    programId: PROGRAM_ID,
    tokenMint: MINT,
    payerSeed: seed,
    payerPubkey: PAYER,
    ...overrides,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SolanaChannelClient: derivation', () => {
  it('derives the same channel id from either side of the pair', () => {
    const mine = clientFor().channelId(PEER);
    const theirs = new SolanaChannelClient({
      rpcUrl: 'http://127.0.0.1:1',
      programId: PROGRAM_ID,
      tokenMint: MINT,
      payerSeed: seed,
      payerPubkey: PEER,
    }).channelId(PAYER);
    expect(mine).toBe(theirs);
    expect(mine).toBe(
      paymentChannel.deriveChannelPDA(PAYER, PEER, MINT, PROGRAM_ID).pda
    );
  });

  it('carries the program id, mint and cluster into the claim domain', () => {
    // The program id a claim is signed under comes from CONFIG, never from
    // anything the claim declares — that is the ADR 0053 binding's whole point.
    expect(clientFor().claimMetadata()).toEqual({
      chainType: 'solana',
      programId: PROGRAM_ID,
      tokenMint: MINT,
    });
    expect(clientFor({ cluster: 'solana:devnet' }).claimMetadata()).toEqual({
      chainType: 'solana',
      programId: PROGRAM_ID,
      tokenMint: MINT,
      cluster: 'solana:devnet',
    });
  });
});

describe('SolanaChannelClient: reading our own side', () => {
  function stubAccount(account: paymentChannel.SolanaChannelAccountState): void {
    vi.spyOn(paymentChannel, 'getChannelAccountState').mockResolvedValue(account);
  }

  it('resolves ownDeposit/ownNonce from the sorted participant slots', async () => {
    // On chain, participant_a is min(a, b) — so which slot is ours is a fact
    // about the keys, not about who opened the channel. Reading the wrong one
    // reports the counterparty's collateral as our own headroom, and the
    // program bounds a claim by the CLAIMER's own deposit.
    stubAccount({
      exists: true,
      state: 'opened',
      participantA: PAYER,
      participantB: PEER,
      depositA: 7n,
      depositB: 99n,
      nonceA: 3n,
      nonceB: 42n,
    });
    await expect(clientFor().read('chan')).resolves.toMatchObject({
      ownDeposit: 7n,
      ownNonce: 3n,
    });

    stubAccount({
      exists: true,
      state: 'opened',
      participantA: PEER,
      participantB: PAYER,
      depositA: 7n,
      depositB: 99n,
      nonceA: 3n,
      nonceB: 42n,
    });
    await expect(clientFor().read('chan')).resolves.toMatchObject({
      ownDeposit: 99n,
      ownNonce: 42n,
    });
  });

  it('reports a settlement deadline only once closed', async () => {
    stubAccount({
      exists: true,
      state: 'opened',
      participantA: PAYER,
      closeTimestamp: 0n,
      challengeDuration: 3600n,
    });
    expect((await clientFor().read('chan')).settleableAt).toBeUndefined();

    stubAccount({
      exists: true,
      state: 'closed',
      participantA: PAYER,
      closeTimestamp: 1_800_000_000n,
      challengeDuration: 3600n,
    });
    expect((await clientFor().read('chan')).settleableAt).toBe(1_800_003_600n);
  });

  it('reports zeroes, not a crash, for a channel that is not there', async () => {
    stubAccount({ exists: false });
    await expect(clientFor().read('chan')).resolves.toMatchObject({
      exists: false,
      ownDeposit: 0n,
      ownNonce: 0n,
    });
  });
});

describe('SolanaChannelClient: settle', () => {
  it('pays into each participant ATA for the channel account own mint', async () => {
    vi.spyOn(paymentChannel, 'getChannelAccountState').mockResolvedValue({
      exists: true,
      state: 'closed',
      participantA: PAYER,
      participantB: PEER,
      // Deliberately not the configured mint: the channel's own record wins,
      // because that is what the program validates destinations against.
      tokenMint: '6GbdrVghwNKTz9raga7y3Y4qqX5Zgg3AC4d48Kt7C59Q',
    });
    const settle = vi
      .spyOn(paymentChannel, 'settleSolanaChannel')
      .mockResolvedValue({ settleTxSignature: 'sig' });

    await clientFor().settle('chan');

    const mint = '6GbdrVghwNKTz9raga7y3Y4qqX5Zgg3AC4d48Kt7C59Q';
    expect(settle).toHaveBeenCalledWith(
      expect.objectContaining({
        participantATokenAccount:
          paymentChannel.deriveAssociatedTokenAccount(PAYER, mint),
        participantBTokenAccount:
          paymentChannel.deriveAssociatedTokenAccount(PEER, mint),
      })
    );
    expect(settle.mock.calls[0]?.[0]).not.toHaveProperty('force');
  });

  it('refuses to settle a channel the chain says is not there', async () => {
    // A settled channel's account is zeroed and its lamports reclaimed, so it
    // reads exactly like one that never existed. Firing a doomed transaction
    // would surface as an opaque `custom program error` instead.
    vi.spyOn(paymentChannel, 'getChannelAccountState').mockResolvedValue({
      exists: false,
    });
    await expect(clientFor().settle('chan')).rejects.toThrow(
      /does not exist on chain/
    );
  });

  it('sends force-close-expired when asked', async () => {
    vi.spyOn(paymentChannel, 'getChannelAccountState').mockResolvedValue({
      exists: true,
      state: 'closed',
      participantA: PAYER,
      participantB: PEER,
      tokenMint: MINT,
    });
    const settle = vi
      .spyOn(paymentChannel, 'settleSolanaChannel')
      .mockResolvedValue({ settleTxSignature: 'sig' });
    await clientFor().settle('chan', { force: true });
    expect(settle.mock.calls[0]?.[0]).toMatchObject({ force: true });
  });
});

describe('SolanaChannelClient: open', () => {
  it('defaults the challenge period to an hour, and the source account to the ATA', async () => {
    const open = vi
      .spyOn(paymentChannel, 'openSolanaChannel')
      .mockResolvedValue({ channelPDA: 'chan', opened: true });

    await clientFor().open({ counterparty: PEER, deposit: 1_000n });

    expect(open.mock.calls[0]?.[0]).toMatchObject({
      challengeDuration: 3600n,
      deposit: {
        amount: 1_000n,
        payerTokenAccount: paymentChannel.deriveAssociatedTokenAccount(
          PAYER,
          MINT
        ),
      },
    });
  });

  it('omits the deposit entirely when none is asked for', async () => {
    const open = vi
      .spyOn(paymentChannel, 'openSolanaChannel')
      .mockResolvedValue({ channelPDA: 'chan', opened: true });
    await clientFor().open({ counterparty: PEER });
    expect(open.mock.calls[0]?.[0]).not.toHaveProperty('deposit');
    await clientFor().open({ counterparty: PEER, deposit: 0n });
    expect(open.mock.calls[1]?.[0]).not.toHaveProperty('deposit');
  });
});
