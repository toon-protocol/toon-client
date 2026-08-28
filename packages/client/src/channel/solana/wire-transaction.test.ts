/**
 * Reading, patching and signing a wire transaction somebody else compiled.
 *
 * The fixture is the point of this suite. `ANT_SPAWN_TRANSACTION` is 828 bytes
 * of real compiled output from `toon-protocol/store`'s own
 * `buildAntSpawnTransaction`, driven by the real `@ar.io/sdk` and `@solana/kit`
 * — so what is asserted below is agreement with the party that actually
 * composes these, not agreement with a fixture this repository wrote to match
 * its own reading of the format.
 *
 * Two invariants carry the most weight, because breaking either produces a
 * transaction that is refused only after it has been paid for:
 *
 *   1. **slots are matched by address.** `requiredSigners` is address-sorted
 *      within a role, so signing "the second slot" is right for one pair of keys
 *      and wrong for the next.
 *   2. **a patched blockhash invalidates every signature over the old message.**
 *      They are zeroed rather than left stale, because a zero slot is what the
 *      gas station reads as unsigned — `missing_client_signature`, before it
 *      spends anything — while a stale one fails signature verification at the
 *      validator with nothing pointing at the cause.
 */

import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base58Decode, base58Encode } from '../../utils/base58.js';
import { fromBase64 } from '../../utils/binary.js';
import {
  generateSolanaKeypair,
  parseSolanaWireTransaction,
  patchSolanaRecentBlockhash,
  signSolanaWireTransaction,
  solanaKeypair,
} from './wire-transaction.js';
import {
  ANT_SPAWN_ADDRESSES,
  ANT_SPAWN_SEEDS,
  ANT_SPAWN_TRANSACTION,
  QUOTED_BLOCKHASH,
} from '../../jobs/ant-spawn.test-support.js';

const mint = solanaKeypair(ANT_SPAWN_SEEDS.mint);
const owner = solanaKeypair(ANT_SPAWN_SEEDS.owner);
const feePayer = solanaKeypair(ANT_SPAWN_SEEDS.feePayer);

/** The 64 bytes of slot `n`, as they sit on the wire. */
function slot(wireBase64: string, n: number): Uint8Array {
  const parsed = parseSolanaWireTransaction(wireBase64);
  const start = parsed.signaturesOffset + n * 64;
  return parsed.bytes.slice(start, start + 64);
}

/** Indices at which two equal-length byte strings differ. */
function differingBytes(a: Uint8Array, b: Uint8Array): number[] {
  expect(a.length).toBe(b.length);
  const out: number[] = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) out.push(i);
  return out;
}

describe('parseSolanaWireTransaction', () => {
  it('reads the store\'s real v0 draft', () => {
    const parsed = parseSolanaWireTransaction(ANT_SPAWN_TRANSACTION);

    expect(parsed.version).toBe(0);
    expect(parsed.bytes).toHaveLength(828);
    // Compiled order: fee payer first, then the two writable signers, sorted by
    // address. Owner before mint is a fact about THESE keys only.
    expect(parsed.signers).toEqual([
      ANT_SPAWN_ADDRESSES.feePayer,
      ANT_SPAWN_ADDRESSES.owner,
      ANT_SPAWN_ADDRESSES.mint,
    ]);
    expect(parsed.staticAccounts).toHaveLength(10);
    expect(parsed.staticAccounts.slice(0, 3)).toEqual(parsed.signers);
    // The four programs the gas station's whitelist has to cover.
    expect(parsed.staticAccounts.slice(6)).toEqual([
      '11111111111111111111111111111111',
      'ComputeBudget111111111111111111111111111111',
      'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d',
      'DbHbRwUD1oAn1mrDSqtWtvwGcNrmhWdD2g8L4xmeQ7NX',
    ]);
    // A draft carries the placeholder blockhash: quote with it, never execute it.
    expect(parsed.recentBlockhash).toBe('11111111111111111111111111111111');
    // 1 count byte + 3 × 64 signature bytes; then version, header, 10 keys.
    expect(parsed.signaturesOffset).toBe(1);
    expect(parsed.messageOffset).toBe(193);
    expect(parsed.recentBlockhashOffset).toBe(193 + 1 + 3 + 1 + 10 * 32);
  });

  it('reports every zero-filled slot as unsigned', () => {
    expect(parseSolanaWireTransaction(ANT_SPAWN_TRANSACTION).unsigned).toEqual([
      ANT_SPAWN_ADDRESSES.feePayer,
      ANT_SPAWN_ADDRESSES.owner,
      ANT_SPAWN_ADDRESSES.mint,
    ]);
  });

  it('accepts raw bytes as readily as base64', () => {
    const fromBytes = parseSolanaWireTransaction(fromBase64(ANT_SPAWN_TRANSACTION));
    expect(fromBytes.signers).toEqual(
      parseSolanaWireTransaction(ANT_SPAWN_TRANSACTION).signers
    );
  });

  it('reads a legacy message, which carries no version prefix', () => {
    // Hand-built, and deliberately minimal: one signer, one account, no
    // instructions. The v0 fixture above is the one that has to be real; this
    // exists only to pin that a first byte with the high bit CLEAR is a header
    // byte and not a version.
    const key = base58Decode(ANT_SPAWN_ADDRESSES.owner);
    const blockhash = base58Decode(QUOTED_BLOCKHASH);
    const wire = new Uint8Array([
      1, // one signature slot
      ...new Uint8Array(64),
      1, 0, 0, // header: 1 required signature, 0 readonly signed, 0 readonly unsigned
      1, // one static account
      ...key,
      ...blockhash,
      0, // no instructions
    ]);

    const parsed = parseSolanaWireTransaction(wire);
    expect(parsed.version).toBe('legacy');
    expect(parsed.signers).toEqual([ANT_SPAWN_ADDRESSES.owner]);
    expect(parsed.recentBlockhash).toBe(QUOTED_BLOCKHASH);
  });

  it('refuses bytes that are not a transaction of this shape', () => {
    // A slot count the bytes cannot hold.
    expect(() => parseSolanaWireTransaction(new Uint8Array([9, 0, 0]))).toThrow(
      /signature slots do not fit/
    );
    // A header that disagrees with the slot count — the one disagreement that
    // would otherwise put every signature in the wrong place.
    const wire = fromBase64(ANT_SPAWN_TRANSACTION).slice();
    wire[193 + 1] = 2;
    expect(() => parseSolanaWireTransaction(wire)).toThrow(
      /3 signature slots but the header requires 2/
    );
  });
});

describe('signSolanaWireTransaction', () => {
  it('fills the client slots and leaves the fee payer\'s alone', () => {
    const signed = signSolanaWireTransaction(ANT_SPAWN_TRANSACTION, [mint, owner]);

    // The one slot a client never touches: the gas station fills it, and that
    // signature is what makes it the payer.
    expect(parseSolanaWireTransaction(signed).unsigned).toEqual([
      ANT_SPAWN_ADDRESSES.feePayer,
    ]);
    expect(slot(signed, 0)).toEqual(new Uint8Array(64));
  });

  it('writes each signature over the message bytes, in that key\'s own slot', () => {
    const signed = signSolanaWireTransaction(ANT_SPAWN_TRANSACTION, [mint, owner]);
    const parsed = parseSolanaWireTransaction(signed);
    const message = parsed.bytes.subarray(parsed.messageOffset);

    // Slot 1 is the owner and slot 2 the mint FOR THESE KEYS — verified by
    // address, which is the only way that is true in general.
    expect(
      ed25519.verify(slot(signed, 1), message, base58Decode(ANT_SPAWN_ADDRESSES.owner))
    ).toBe(true);
    expect(
      ed25519.verify(slot(signed, 2), message, base58Decode(ANT_SPAWN_ADDRESSES.mint))
    ).toBe(true);
    // …and not the other way round.
    expect(
      ed25519.verify(slot(signed, 1), message, base58Decode(ANT_SPAWN_ADDRESSES.mint))
    ).toBe(false);
  });

  it('changes nothing but the slots it fills', () => {
    const before = fromBase64(ANT_SPAWN_TRANSACTION);
    const after = fromBase64(signSolanaWireTransaction(ANT_SPAWN_TRANSACTION, [mint, owner]));
    const changed = differingBytes(before, after);
    // Every changed byte is inside slots 1 and 2 — the message, which every
    // signature covers, is untouched. This is what "do not recompile" means.
    expect(Math.min(...changed)).toBeGreaterThanOrEqual(1 + 64);
    expect(Math.max(...changed)).toBeLessThan(1 + 3 * 64);
  });

  it('is ordered by address, not by the order the signers were handed in', () => {
    expect(signSolanaWireTransaction(ANT_SPAWN_TRANSACTION, [mint, owner])).toBe(
      signSolanaWireTransaction(ANT_SPAWN_TRANSACTION, [owner, mint])
    );
  });

  it('answers in the spelling it was asked in', () => {
    const bytes = signSolanaWireTransaction(fromBase64(ANT_SPAWN_TRANSACTION), [mint]);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(typeof signSolanaWireTransaction(ANT_SPAWN_TRANSACTION, [mint])).toBe('string');
  });

  it('refuses a key the transaction never asked for', () => {
    const stranger = generateSolanaKeypair();
    expect(() =>
      signSolanaWireTransaction(ANT_SPAWN_TRANSACTION, [stranger])
    ).toThrow(/is not a required signer/);
  });
});

describe('patchSolanaRecentBlockhash', () => {
  it('overwrites the 32 blockhash bytes and nothing else in the message', () => {
    const patched = patchSolanaRecentBlockhash(ANT_SPAWN_TRANSACTION, QUOTED_BLOCKHASH);
    const parsed = parseSolanaWireTransaction(patched);

    expect(parsed.recentBlockhash).toBe(QUOTED_BLOCKHASH);
    // The draft was unsigned, so the only bytes that may differ are the
    // blockhash's own. (Not all 32 of them do: the placeholder blockhash is 32
    // zero bytes, so a quoted hash with a zero byte in it collides there.)
    const changed = differingBytes(fromBase64(ANT_SPAWN_TRANSACTION), fromBase64(patched));
    expect(changed.length).toBeGreaterThan(0);
    for (const index of changed) {
      expect(index).toBeGreaterThanOrEqual(parsed.recentBlockhashOffset);
      expect(index).toBeLessThan(parsed.recentBlockhashOffset + 32);
    }
  });

  it('clears signatures made over the message it just changed', () => {
    const signed = signSolanaWireTransaction(ANT_SPAWN_TRANSACTION, [mint, owner]);
    const patched = patchSolanaRecentBlockhash(signed, QUOTED_BLOCKHASH);

    // A signature over the old message is not "nearly right" — it is a
    // signature over bytes that no longer exist. Sign AFTER patching.
    expect(parseSolanaWireTransaction(patched).unsigned).toEqual([
      ANT_SPAWN_ADDRESSES.feePayer,
      ANT_SPAWN_ADDRESSES.owner,
      ANT_SPAWN_ADDRESSES.mint,
    ]);
  });

  it('patch-then-sign leaves only the fee payer to fill', () => {
    const executable = signSolanaWireTransaction(
      patchSolanaRecentBlockhash(ANT_SPAWN_TRANSACTION, QUOTED_BLOCKHASH),
      [mint, owner]
    );
    const parsed = parseSolanaWireTransaction(executable);

    expect(parsed.recentBlockhash).toBe(QUOTED_BLOCKHASH);
    expect(parsed.unsigned).toEqual([ANT_SPAWN_ADDRESSES.feePayer]);
    const message = parsed.bytes.subarray(parsed.messageOffset);
    expect(
      ed25519.verify(slot(executable, 2), message, base58Decode(ANT_SPAWN_ADDRESSES.mint))
    ).toBe(true);
  });

  it('refuses a blockhash that is not 32 bytes', () => {
    expect(() => patchSolanaRecentBlockhash(ANT_SPAWN_TRANSACTION, 'abc')).toThrow(
      /must decode to 32 bytes/
    );
  });
});

describe('keypairs', () => {
  it('generates a fresh single-use keypair whose address is its public half', () => {
    const one = generateSolanaKeypair();
    const two = generateSolanaKeypair();

    expect(one.address).toBe(base58Encode(one.publicKey));
    expect(one.address).not.toBe(two.address);
    expect(one.publicKey).toEqual(new Uint8Array(ed25519.getPublicKey(one.privateKey)));
  });

  it('derives the public half rather than trusting a 64-byte secret\'s tail', () => {
    const corrupt = new Uint8Array(64);
    corrupt.set(ANT_SPAWN_SEEDS.owner, 0);
    corrupt.fill(0xff, 32);

    expect(solanaKeypair(corrupt).address).toBe(ANT_SPAWN_ADDRESSES.owner);
    expect(solanaKeypair(ANT_SPAWN_SEEDS.owner).address).toBe(ANT_SPAWN_ADDRESSES.owner);
    expect(feePayer.address).toBe(ANT_SPAWN_ADDRESSES.feePayer);
  });

  it('refuses a secret that is neither a seed nor a secret key', () => {
    expect(() => solanaKeypair(new Uint8Array(31))).toThrow(/32-byte seed or a 64-byte/);
  });
});
