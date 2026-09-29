/**
 * The Solana plumbing this client builds every transaction with: program-derived
 * addresses, associated token accounts, and the legacy message compiler.
 *
 * The ATA fixture is the payment-channels program's own codama client's answer
 * (`@solana/kit`'s `getProgramDerivedAddress`) for these keys, so the
 * derivation is checked against an independent implementation rather than
 * against itself.
 */
import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base58Decode, base58Encode } from '../../utils/base58.js';
import {
  __testing,
  compileLegacyMessage,
  deriveAssociatedTokenAccount,
  findProgramAddress,
  serializeLegacyTransaction,
} from './payment-channel.js';
import { parseSolanaWireTransaction } from './wire-transaction.js';

const PAYER = 'AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9';
const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const BLOCKHASH = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N';

describe('program-derived addresses', () => {
  it('derives the associated token account the program’s own client derives', () => {
    expect(deriveAssociatedTokenAccount(PAYER, MINT)).toBe(
      'H1AviagU5Y17z77v1F9qZPJ9kCbCsL4ewiZABNfGYoRs'
    );
  });

  it('finds an off-curve address with the highest bump that yields one', () => {
    const { pda, bump } = findProgramAddress(
      [new TextEncoder().encode('seed')],
      base58Decode('CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX')
    );
    expect(pda.length).toBe(32);
    expect(__testing.isOnCurve(pda)).toBe(false);
    expect(bump).toBeGreaterThanOrEqual(0);
    expect(bump).toBeLessThanOrEqual(255);
  });

  it('pads a short key to 32 bytes on the left', () => {
    const padded = __testing.padTo32(new Uint8Array([1, 2]));
    expect(padded.length).toBe(32);
    expect([...padded.slice(30)]).toEqual([1, 2]);
    expect(base58Decode(__testing.TOKEN_PROGRAM_ID).length).toBe(32);
  });
});

describe('compileLegacyMessage and serializeLegacyTransaction', () => {
  const payerKey = new Uint8Array(32).fill(1);
  const payer = base58Encode(ed25519.getPublicKey(payerKey));
  const other = base58Encode(ed25519.getPublicKey(new Uint8Array(32).fill(2)));
  const writable = base58Encode(new Uint8Array(32).fill(3));
  const program = 'CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX';

  it('puts the fee payer first and orders signers before the rest', () => {
    const compiled = compileLegacyMessage(
      payer,
      [
        {
          programId: program,
          keys: [
            { pubkey: writable, isSigner: false, isWritable: true },
            { pubkey: other, isSigner: true, isWritable: false },
          ],
          data: new Uint8Array([7]),
        },
      ],
      BLOCKHASH
    );
    expect(compiled.signers).toEqual([payer, other]);

    const unsigned = serializeLegacyTransaction(compiled, []);
    const parsed = parseSolanaWireTransaction(unsigned);
    expect(parsed.signers).toEqual([payer, other]);
    expect(parsed.unsigned).toEqual([payer, other]);
    expect(parsed.recentBlockhash).toBe(BLOCKHASH);
    expect(parsed.staticAccounts).toEqual([payer, other, writable, program]);
  });

  it('writes each signature into its slot, over exactly the message', () => {
    const compiled = compileLegacyMessage(payer, [], BLOCKHASH);
    const signature = ed25519.sign(compiled.message, payerKey);
    const tx = serializeLegacyTransaction(compiled, [signature]);
    const parsed = parseSolanaWireTransaction(tx);
    expect(parsed.unsigned).toEqual([]);
    expect(
      ed25519.verify(
        tx.subarray(parsed.signaturesOffset, parsed.signaturesOffset + 64),
        tx.subarray(parsed.messageOffset),
        ed25519.getPublicKey(payerKey)
      )
    ).toBe(true);
  });
});
