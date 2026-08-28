/**
 * Solana payment-channel primitives — parity with the deployed program.
 *
 * The PRIMARY gate for the client's Solana settlement wire. Three contracts are
 * pinned here, each of which the chain (or the connector) refuses outright when
 * it drifts:
 *
 *   1. **PDA derivation** — `deriveChannelPDA` must produce the byte-identical
 *      PDA `processor.rs::derive_channel_pda` derives for the same
 *      (participantA, participantB, tokenMint, programId). If they diverge the
 *      connector reads a different channel-state account than the client opened
 *      and every claim is rejected. The known-good vectors below were produced
 *      by the connector's own SDK; re-derive them if the PDA contract moves.
 *   2. **The 96-byte balance-proof message** of ADR 0053, byte-for-byte,
 *      including that the program id sits at offset 16 — the binding that makes
 *      a proof unredeemable at any other deployment.
 *   3. **The instruction encodings** — discriminators, data layouts and account
 *      orders — read off `packages/solana-program/src/processor.rs`'s own
 *      `next_account_info` sequences, plus the Ed25519 precompile instruction
 *      layout `verify_ed25519_precompile` parses.
 *
 * The end-to-end proof that these actually execute is
 * `src/__integration__/solana-channel-lifecycle.integration.test.ts`, against a
 * real `solana-test-validator` running this same program.
 */

import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base58Decode } from '../../utils/base58.js';
import {
  deriveChannelPDA,
  deriveVaultPDA,
  buildBalanceProofMessage,
  signBalanceProofMessage,
  buildClaimFromChannelInstructions,
  buildEd25519VerifyInstruction,
  decodeChannelAccount,
  settleableAt,
  __testing,
} from './payment-channel.js';

/** Live deployed Solana payment-channel program id (Akash Solana node). */
const PROGRAM_ID = 'EdJxYPDxGvaJuu57DSUptf4soLv8enpdyQJJhHDLiydG';

// Known-good vectors produced by @toon-protocol/connector@3.9.0 SDK.
const VECTORS = [
  {
    participantA: 'GfHq2tTVk9z4eXgZ8nWz3vWqkXBQ8K9aBcDeFgHiJkLm',
    participantB: 'So11111111111111111111111111111111111111112',
    tokenMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC mainnet
    expectedChannelPDA: '9YnDSsNuXAUDUN2HsGgY9FFCek1TS5XdLW4dccRoyXLd',
    expectedChannelBump: 255,
    expectedVaultPDA: '2y4unxy47cURvtT6xwprRRB8KovCpHAJMZ2j2mym5J16',
    expectedVaultBump: 255,
  },
  {
    participantA: 'GfHq2tTVk9z4eXgZ8nWz3vWqkXBQ8K9aBcDeFgHiJkLm',
    participantB: 'So11111111111111111111111111111111111111112',
    tokenMint: '6GbdrVghwNKTz9raga7y3Y4qqX5Zgg3AC4d48Kt7C59Q', // mock-USDC (e2e infra)
    expectedChannelPDA: 'HRnDEs5VsaEJ8gJ6zUVKxRS6eLDi6mBtTt9NmpBVJEJ3',
    expectedChannelBump: 253,
  },
] as const;

describe('Solana payment-channel: connector-parity PDA derivation', () => {
  it('derives channel + vault PDAs byte-identical to connector 3.9.0', () => {
    for (const v of VECTORS) {
      const { pda, bump } = deriveChannelPDA(
        v.participantA,
        v.participantB,
        v.tokenMint,
        PROGRAM_ID
      );
      expect(pda).toBe(v.expectedChannelPDA);
      expect(bump).toBe(v.expectedChannelBump);

      if ('expectedVaultPDA' in v) {
        const vault = deriveVaultPDA(pda, PROGRAM_ID);
        expect(vault.pda).toBe(v.expectedVaultPDA);
        expect(vault.bump).toBe(v.expectedVaultBump);
      }
    }
  });

  it('is order-independent in the participants (sorted seeds)', () => {
    const v = VECTORS[0];
    const forward = deriveChannelPDA(
      v.participantA,
      v.participantB,
      v.tokenMint,
      PROGRAM_ID
    );
    const reversed = deriveChannelPDA(
      v.participantB,
      v.participantA,
      v.tokenMint,
      PROGRAM_ID
    );
    expect(forward.pda).toBe(reversed.pda);
    expect(forward.pda).toBe(v.expectedChannelPDA);
  });

  it('produces a distinct PDA for a different mint', () => {
    const a = VECTORS[0].participantA;
    const b = VECTORS[0].participantB;
    const pdaUsdc = deriveChannelPDA(
      a,
      b,
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      PROGRAM_ID
    ).pda;
    const pdaMock = deriveChannelPDA(
      a,
      b,
      '6GbdrVghwNKTz9raga7y3Y4qqX5Zgg3AC4d48Kt7C59Q',
      PROGRAM_ID
    ).pda;
    expect(pdaUsdc).not.toBe(pdaMock);
  });
});


describe('Solana payment-channel: the 96-byte balance proof (ADR 0053)', () => {
  const PDA = '9YnDSsNuXAUDUN2HsGgY9FFCek1TS5XdLW4dccRoyXLd';
  /** The deployed public-devnet payment-channel program. */
  const DEVNET_PROGRAM = '2aEVJ8koKD8LTZrLRSGtAtU7LBt4e7QjjCgf1kzQ7Rip';

  it('lays out tag || programId || channelAccount || nonce LE || amount LE', () => {
    const nonce = 5n;
    const amount = 1_000_000n;
    const msg = buildBalanceProofMessage(DEVNET_PROGRAM, PDA, nonce, amount);
    expect(msg.length).toBe(96);

    // [0..16) the domain tag, ASCII, exactly 16 bytes.
    expect(new TextDecoder().decode(msg.slice(0, 16))).toBe('TOON-BALPROOF-V2');
    // [16..48) the settlement program — the ADR 0053 binding.
    expect([...msg.slice(16, 48)]).toEqual([...base58Decode(DEVNET_PROGRAM)]);
    // [48..80) the channel account.
    expect([...msg.slice(48, 80)]).toEqual([...base58Decode(PDA)]);
    // nonce little-endian at 80.
    expect(msg[80]).toBe(5);
    expect(msg[81]).toBe(0);
    // amount little-endian at 88: 1_000_000 = 0x0F4240.
    expect(msg[88]).toBe(0x40);
    expect(msg[89]).toBe(0x42);
    expect(msg[90]).toBe(0x0f);
  });

  it('is a different message under a different program', () => {
    // The replay ADR 0053 closes: identical channel/nonce/amount, different
    // deployment, and therefore bytes no signature spans both of.
    const a = buildBalanceProofMessage(DEVNET_PROGRAM, PDA, 1n, 1n);
    const b = buildBalanceProofMessage(PROGRAM_ID, PDA, 1n, 1n);
    expect(a).not.toEqual(b);
    expect([...a.slice(0, 16)]).toEqual([...b.slice(0, 16)]);
    expect([...a.slice(48)]).toEqual([...b.slice(48)]);
  });

  it('has no 48-byte form left to sign', () => {
    // The old layout took (channelPDA, nonce, amount) and produced 48 bytes.
    // Calling it that way now signs the PDA as a program id and a nonce as an
    // account — nonsense the type system already refuses, and the length check
    // here is the belt to that brace: nothing this module produces is 48 bytes.
    expect(
      buildBalanceProofMessage(DEVNET_PROGRAM, PDA, 0n, 0n).length
    ).not.toBe(48);
  });

  it('signs a message the matching public key verifies (round-trip)', () => {
    const seed = ed25519.utils.randomSecretKey
      ? ed25519.utils.randomSecretKey()
      : new Uint8Array(32).fill(7);
    const pubkey = ed25519.getPublicKey(seed);
    const nonce = 3n;
    const amount = 42n;
    const sig = signBalanceProofMessage(
      DEVNET_PROGRAM,
      PDA,
      nonce,
      amount,
      seed
    );
    expect(sig.length).toBe(64);
    const message = buildBalanceProofMessage(
      DEVNET_PROGRAM,
      PDA,
      nonce,
      amount
    );
    expect(ed25519.verify(sig, message, pubkey)).toBe(true);

    // ...and does not verify against another deployment's message.
    const elsewhere = buildBalanceProofMessage(PROGRAM_ID, PDA, nonce, amount);
    expect(ed25519.verify(sig, elsewhere, pubkey)).toBe(false);
  });
});

describe('Solana payment-channel: the Ed25519 precompile instruction', () => {
  const SIGNER = 'GfHq2tTVk9z4eXgZ8nWz3vWqkXBQ8K9aBcDeFgHiJkLm';
  const signature = new Uint8Array(64).fill(0xab);
  const message = new Uint8Array(96).fill(0xcd);

  it('lays out the header the program parses, all indices 0xFFFF', () => {
    const ix = buildEd25519VerifyInstruction(SIGNER, signature, message);
    expect(ix.programId).toBe(__testing.ED25519_PROGRAM_ID);
    expect(ix.keys).toEqual([]);

    const d = ix.data;
    const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
    expect(d[0]).toBe(1); // num_signatures — the program demands exactly 1
    // Offsets are fixed by the layout: pubkey at 16, signature at 48,
    // message at 112 (processor.rs reads them from these exact positions).
    expect(view.getUint16(2, true)).toBe(48); // signature_offset
    expect(view.getUint16(4, true)).toBe(0xffff); // signature_instruction_index
    expect(view.getUint16(6, true)).toBe(16); // public_key_offset
    expect(view.getUint16(8, true)).toBe(0xffff); // public_key_instruction_index
    expect(view.getUint16(10, true)).toBe(112); // message_data_offset
    expect(view.getUint16(12, true)).toBe(96); // message_data_size
    expect(view.getUint16(14, true)).toBe(0xffff); // message_instruction_index

    expect([...d.slice(16, 48)]).toEqual([...base58Decode(SIGNER)]);
    expect([...d.slice(48, 112)]).toEqual([...signature]);
    expect([...d.slice(112)]).toEqual([...message]);
    expect(d.length).toBe(112 + 96);
  });

  it('refuses a signature that is not 64 bytes', () => {
    // A short signature would shift the message offset and have the precompile
    // verify a different span than the program compares — a silent mismatch.
    expect(() =>
      buildEd25519VerifyInstruction(SIGNER, new Uint8Array(63), message)
    ).toThrow(/64 bytes/);
  });
});

describe('Solana payment-channel: claim_from_channel (06)', () => {
  const PDA = '9YnDSsNuXAUDUN2HsGgY9FFCek1TS5XdLW4dccRoyXLd';
  const CLAIMER = 'GfHq2tTVk9z4eXgZ8nWz3vWqkXBQ8K9aBcDeFgHiJkLm';
  const FEE_PAYER = 'So11111111111111111111111111111111111111112';

  const instructions = buildClaimFromChannelInstructions({
    programId: PROGRAM_ID,
    channelPDA: PDA,
    claimerPubkey: CLAIMER,
    feePayerPubkey: FEE_PAYER,
    nonce: 7n,
    transferredAmount: 250_000n,
    signature: new Uint8Array(64).fill(1),
  });

  it('puts the Ed25519 precompile at index 0, where the program looks', () => {
    // `load_instruction_at_checked(0, ...)` — index 0 or nothing.
    expect(instructions).toHaveLength(2);
    expect(instructions[0]?.programId).toBe(__testing.ED25519_PROGRAM_ID);
    expect(instructions[1]?.programId).toBe(PROGRAM_ID);
  });

  it('signs the same message it asks the program to check', () => {
    // The program rebuilds the message from its own id + the (nonce, amount)
    // in the instruction data and requires the precompile's message to equal
    // it byte-for-byte, so these two must agree or nothing redeems.
    const precompiled = instructions[0]?.data.slice(112);
    expect(precompiled).toEqual(
      buildBalanceProofMessage(PROGRAM_ID, PDA, 7n, 250_000n)
    );
  });

  it('encodes 06 || nonce LE || transferredAmount LE', () => {
    const data = instructions[1]?.data as Uint8Array;
    expect(data.length).toBe(24);
    expect([...data.slice(0, 8)]).toEqual([6, 0, 0, 0, 0, 0, 0, 0]);
    expect(data[8]).toBe(7); // nonce, u64 LE
    expect([...data.slice(16, 20)]).toEqual([0x90, 0xd0, 0x03, 0x00]); // 250_000
  });

  it('orders the accounts the way process_claim_from_channel reads them', () => {
    // fee_payer (signer) · claimer (NOT a signer) · channel (w) · instructions
    expect(instructions[1]?.keys).toEqual([
      { pubkey: FEE_PAYER, isSigner: true, isWritable: false },
      { pubkey: CLAIMER, isSigner: false, isWritable: false },
      { pubkey: PDA, isSigner: false, isWritable: true },
      {
        pubkey: __testing.INSTRUCTIONS_SYSVAR_ID,
        isSigner: false,
        isWritable: false,
      },
    ]);
  });
});

describe('Solana payment-channel: the 178-byte ChannelState account', () => {
  const A = 'GfHq2tTVk9z4eXgZ8nWz3vWqkXBQ8K9aBcDeFgHiJkLm';
  const B = 'So11111111111111111111111111111111111111112';
  const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

  function u64(v: bigint): Uint8Array {
    const out = new Uint8Array(8);
    for (let i = 0; i < 8; i++) out[i] = Number((v >> BigInt(i * 8)) & 0xffn);
    return out;
  }

  /** A `ChannelState` laid out at `state.rs`'s own offsets. */
  function encode(
    overrides: { state?: number; closeTimestamp?: bigint } = {}
  ): Uint8Array {
    const data = new Uint8Array(178);
    data.set(new TextEncoder().encode('pchannel'), 0);
    data.set(base58Decode(A), 8);
    data.set(base58Decode(B), 40);
    data.set(base58Decode(MINT), 72);
    data.set(u64(1_000_000n), 104); // deposit_a
    data.set(u64(2_000_000n), 112); // deposit_b
    data.set(u64(111n), 120); // transferred_amount_a
    data.set(u64(222n), 128); // transferred_amount_b
    data.set(u64(3n), 136); // nonce_a
    data.set(u64(4n), 144); // nonce_b
    data.set(u64(3600n), 152); // challenge_duration
    data[160] = overrides.state ?? 1; // state: Closed
    data.set(u64(BigInt.asUintN(64, overrides.closeTimestamp ?? 1_800_000_000n)), 161);
    data[169] = 254; // bump
    return data;
  }

  it('decodes every field, at the offsets state.rs declares', () => {
    const account = decodeChannelAccount(encode());
    expect(account).toEqual({
      exists: true,
      state: 'closed',
      participantA: A,
      participantB: B,
      tokenMint: MINT,
      depositA: 1_000_000n,
      depositB: 2_000_000n,
      transferredAmountA: 111n,
      transferredAmountB: 222n,
      nonceA: 3n,
      nonceB: 4n,
      challengeDuration: 3600n,
      closeTimestamp: 1_800_000_000n,
      bump: 254,
    });
  });

  it('reads close_timestamp as a signed i64', () => {
    // The field is `i64` on chain. Read as u64, a negative clock would decode
    // as ~1.8e19 and settleableAt would put settlement past the heat death of
    // the universe instead of in the past.
    const account = decodeChannelAccount(encode({ closeTimestamp: -1n }));
    expect(account.closeTimestamp).toBe(-1n);
    expect(__testing.readI64LE(encode({ closeTimestamp: -1n }), 161)).toBe(-1n);
  });

  it('rejects a short account or a wrong discriminator', () => {
    expect(decodeChannelAccount(new Uint8Array(177))).toEqual({ exists: false });
    const wrong = encode();
    wrong[0] = 0x00;
    expect(decodeChannelAccount(wrong)).toEqual({ exists: false });
  });

  it('computes settleableAt only for a closed channel', () => {
    expect(settleableAt(decodeChannelAccount(encode()))).toBe(
      1_800_000_000n + 3600n
    );
    // An open channel has no settlement deadline — reporting one derived from
    // a zero close_timestamp would claim it is settleable now.
    expect(settleableAt(decodeChannelAccount(encode({ state: 0 })))).toBeUndefined();
    expect(settleableAt({ exists: false })).toBeUndefined();
  });
});

describe('Solana payment-channel: well-known program addresses', () => {
  it('every sysvar/program id decodes to exactly 32 bytes', () => {
    // A typo in one of these base58 constants produces a valid-looking string
    // that decodes short, and the transaction fails on chain with an account
    // error that says nothing about which account.
    for (const id of [
      __testing.CLOCK_SYSVAR_ID,
      __testing.INSTRUCTIONS_SYSVAR_ID,
      __testing.ED25519_PROGRAM_ID,
      __testing.TOKEN_PROGRAM_ID,
    ]) {
      expect(base58Decode(id).length).toBe(32);
    }
  });
});
