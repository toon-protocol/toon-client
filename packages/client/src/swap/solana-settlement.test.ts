/**
 * Solana settlement submission (toon-client#604).
 *
 * These are the checks that can run WITHOUT a validator, so CI has coverage of
 * the submit path's control flow and its refusals. They are deliberately not the
 * proof that the transaction works: bytes that look right are exactly how the
 * original defect (toon#214) survived. That proof is
 * `../__integration__/solana-settlement-redeem.integration.test.ts`, which boots
 * a real `solana-test-validator` with the real program and requires that on-chain
 * `nonce_a` / `transferred_amount_a` MOVED. Nothing here can substitute for it.
 */
import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base58Decode, base58Encode } from '@toon-protocol/core';
import type { SettlementBundle } from '@toon-protocol/sdk';

import {
  buildSolanaSettlementTransaction,
  decodeSolanaSettlementClaimAmounts,
  submitSolanaSettlement,
  SolanaSettlementError,
  type SolanaSettlementRpc,
} from './solana-settlement.js';

const RECIPIENT_SEED = sha256(new TextEncoder().encode('solana-settle/rcpt'));
const RECIPIENT = base58Encode(
  new Uint8Array(ed25519.getPublicKey(RECIPIENT_SEED))
);
const STRANGER_SEED = sha256(new TextEncoder().encode('solana-settle/other'));
const BLOCKHASH = base58Encode(new Uint8Array(32).fill(9));
const NONCE = 7n;
const AMOUNT = 250_000n;

/** short_vec(u16) — one byte below 0x80, which every case here stays under. */
function shortVec(n: number): Uint8Array {
  if (n >= 0x80) throw new Error('test helper only covers single-byte lengths');
  return new Uint8Array([n]);
}

function u64LE(v: bigint): Uint8Array {
  const out = new Uint8Array(8);
  let x = v;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

/**
 * A compiled legacy Message shaped like the sdk's: `header(3) ||
 * short_vec(numKeys) || numKeys*32 || blockhash(32) || short_vec(1) || claimIx`,
 * with the recipient as account 0 and the 24-byte `ClaimFromChannel` data last.
 */
function message(
  opts: {
    feePayer?: string;
    requiredSignatures?: number;
    numKeys?: number;
    discriminator?: bigint;
  } = {}
): Uint8Array {
  const feePayer = opts.feePayer ?? RECIPIENT;
  const numKeys = opts.numKeys ?? 6;
  const keys = new Uint8Array(numKeys * 32);
  keys.set(base58Decode(feePayer), 0);
  for (let i = 1; i < numKeys; i++)
    keys.set(new Uint8Array(32).fill(i), i * 32);
  const claimIx = new Uint8Array([
    ...u64LE(opts.discriminator ?? 6n),
    ...u64LE(NONCE),
    ...u64LE(AMOUNT),
  ]);
  return new Uint8Array([
    opts.requiredSignatures ?? 1,
    0,
    4,
    ...shortVec(numKeys),
    ...keys,
    ...new Uint8Array(32), // all-zero recent-blockhash placeholder
    ...shortVec(1),
    ...claimIx,
  ]);
}

function bundle(overrides: Partial<SettlementBundle> = {}): SettlementBundle {
  return {
    chain: 'solana:localnet',
    chainKind: 'solana',
    channelId: base58Encode(new Uint8Array(32).fill(3)),
    nonce: NONCE.toString(),
    cumulativeAmount: AMOUNT.toString(),
    recipient: RECIPIENT,
    unsignedTxBytes: message(),
    ...overrides,
  } as SettlementBundle;
}

function fakeRpc(
  overrides: Partial<SolanaSettlementRpc> = {}
): SolanaSettlementRpc & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    getLatestBlockhash: async () => BLOCKHASH,
    sendTransaction: async (_url, tx) => {
      sent.push(tx);
      return 'txsig';
    },
    waitForConfirmation: async () => undefined,
    ...overrides,
  } as SolanaSettlementRpc & { sent: string[] };
}

describe('buildSolanaSettlementTransaction', () => {
  it('[P0] signs the message AFTER the blockhash is patched in', () => {
    const b = bundle();
    const tx = buildSolanaSettlementTransaction(b, {
      recipientSeed: RECIPIENT_SEED,
      recentBlockhash: BLOCKHASH,
    });
    const raw = Buffer.from(tx.txBase64, 'base64');
    expect(raw[0]).toBe(1); // short_vec: exactly one signature
    const signature = new Uint8Array(raw.subarray(1, 65));
    const signed = new Uint8Array(raw.subarray(65));

    // The submitted message carries the live blockhash, not the placeholder…
    const blockhashAt = 3 + 1 + 6 * 32;
    expect(Array.from(signed.slice(blockhashAt, blockhashAt + 32))).toEqual(
      Array.from(base58Decode(BLOCKHASH))
    );
    // …and the signature verifies over exactly those submitted bytes. Signing
    // the placeholder and swapping the blockhash in afterwards would produce a
    // signature over bytes that are not the ones broadcast, and the chain would
    // reject it.
    expect(ed25519.verify(signature, signed, base58Decode(RECIPIENT))).toBe(
      true
    );
    // The placeholder itself is never signed.
    expect(
      ed25519.verify(signature, b.unsignedTxBytes, base58Decode(RECIPIENT))
    ).toBe(false);
  });

  it('[P0] refuses a signer that is not the claim recipient', () => {
    expect(() =>
      buildSolanaSettlementTransaction(bundle(), {
        recipientSeed: STRANGER_SEED,
        recentBlockhash: BLOCKHASH,
      })
    ).toThrow(/not the recipient of this claim/);
    try {
      buildSolanaSettlementTransaction(bundle(), {
        recipientSeed: STRANGER_SEED,
        recentBlockhash: BLOCKHASH,
      });
    } catch (err) {
      expect(err).toBeInstanceOf(SolanaSettlementError);
      expect((err as SolanaSettlementError).code).toBe('RECIPIENT_MISMATCH');
    }
  });

  it('[P0] refuses a non-solana bundle and a wrong-size seed', () => {
    expect(() =>
      buildSolanaSettlementTransaction(bundle({ chainKind: 'evm' }), {
        recipientSeed: RECIPIENT_SEED,
        recentBlockhash: BLOCKHASH,
      })
    ).toThrow(/only handles solana bundles/);
    expect(() =>
      buildSolanaSettlementTransaction(bundle(), {
        recipientSeed: RECIPIENT_SEED.slice(0, 16),
        recentBlockhash: BLOCKHASH,
      })
    ).toThrow(/32-byte Ed25519 seed/);
  });

  it('[P0] refuses a message needing more than the one signature it can produce', () => {
    expect(() =>
      buildSolanaSettlementTransaction(
        bundle({ unsignedTxBytes: message({ requiredSignatures: 2 }) }),
        { recipientSeed: RECIPIENT_SEED, recentBlockhash: BLOCKHASH }
      )
    ).toThrow(/cannot be completed by the recipient alone/);
  });

  it('[P0] refuses a truncated message rather than mis-parsing its offsets', () => {
    expect(() =>
      buildSolanaSettlementTransaction(
        bundle({ unsignedTxBytes: new Uint8Array([1, 0, 4]) }),
        { recipientSeed: RECIPIENT_SEED, recentBlockhash: BLOCKHASH }
      )
    ).toThrow(/too short/);
    expect(() =>
      buildSolanaSettlementTransaction(
        bundle({ unsignedTxBytes: new Uint8Array([1, 0, 4, 6, 1, 2, 3]) }),
        { recipientSeed: RECIPIENT_SEED, recentBlockhash: BLOCKHASH }
      )
    ).toThrow(/truncated/);
  });
});

describe('decodeSolanaSettlementClaimAmounts', () => {
  it('[P0] reads (nonce, transferredAmount) out of the program instruction data', () => {
    expect(decodeSolanaSettlementClaimAmounts(bundle())).toEqual({
      nonce: NONCE,
      transferredAmount: AMOUNT,
    });
  });

  it('[P0] refuses a message that does not end in a ClaimFromChannel', () => {
    expect(() =>
      decodeSolanaSettlementClaimAmounts(
        bundle({ unsignedTxBytes: message({ discriminator: 3n }) })
      )
    ).toThrow(/discriminator 3, expected 6/);
  });
});

describe('submitSolanaSettlement', () => {
  it('[P0] fetches a blockhash, broadcasts, and confirms', async () => {
    const rpc = fakeRpc();
    const res = await submitSolanaSettlement(bundle(), {
      rpcUrl: 'http://localhost:1',
      recipientSeed: RECIPIENT_SEED,
      rpc,
    });
    expect(res.txHash).toBe('txsig');
    expect(rpc.sent).toHaveLength(1);
  });

  it('[P0] with no RPC url it reports NO_RPC_CONFIGURED and never broadcasts', async () => {
    const rpc = fakeRpc();
    await expect(
      submitSolanaSettlement(bundle(), {
        rpcUrl: '',
        recipientSeed: RECIPIENT_SEED,
        rpc,
      })
    ).rejects.toMatchObject({ code: 'NO_RPC_CONFIGURED' });
    expect(rpc.sent).toEqual([]);
  });

  it('[P0] a transaction that confirmed WITH an execution error is a failure, not a success', async () => {
    // The whole point of this path is that on-chain state moved. A confirmed
    // transaction that reverted moved nothing, and reporting it as submitted
    // would recreate the silent gap #604 closed.
    const rpc = fakeRpc({
      waitForConfirmation: async () => {
        throw new Error('Transaction txsig failed: {"InstructionError":[1,…]}');
      },
    });
    await expect(
      submitSolanaSettlement(bundle(), {
        rpcUrl: 'http://localhost:1',
        recipientSeed: RECIPIENT_SEED,
        rpc,
      })
    ).rejects.toMatchObject({ code: 'SUBMISSION_FAILED' });
  });

  it('[P0] a refused broadcast names the channel and nonce it was for', async () => {
    const rpc = fakeRpc({
      sendTransaction: async () => {
        throw new Error('blockhash not found');
      },
    });
    await expect(
      submitSolanaSettlement(bundle(), {
        rpcUrl: 'http://localhost:1',
        recipientSeed: RECIPIENT_SEED,
        rpc,
      })
    ).rejects.toThrow(/nonce 7.*blockhash not found/s);
  });
});
