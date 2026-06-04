/**
 * Solana payment-channel primitives — connector-parity gate.
 *
 * The PRIMARY gate for Stage 2b: the client's `deriveChannelPDA` MUST produce
 * the byte-identical PDA the connector's `SolanaPaymentChannelSDK.deriveChannelPDA`
 * (`@toon-protocol/connector` 3.9.0) produces for the same
 * (participantA, participantB, tokenMint, programId). If they diverge, the
 * connector reads a different channel-state account than the client opened and
 * rejects every Solana claim.
 *
 * The known-good vectors below were produced by running the connector 3.9.0 SDK
 * directly:
 *
 *   import { SolanaPaymentChannelSDK }
 *     from '@toon-protocol/connector/dist/settlement/solana-payment-channel-sdk.js';
 *   SolanaPaymentChannelSDK.deriveChannelPDA(a, b, mint, PROGRAM);   // channelPDA + bump
 *   SolanaPaymentChannelSDK.deriveVaultPDA(channelPDA, PROGRAM);     // vaultPDA + bump
 *
 * Re-derive these if the connector bumps and changes the PDA contract.
 */

import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base58Decode } from '@toon-protocol/core';
import {
  deriveChannelPDA,
  deriveVaultPDA,
  buildBalanceProofMessage,
  signBalanceProofMessage,
} from './solana-payment-channel.js';

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

describe('Solana payment-channel: balance-proof message (connector-parity)', () => {
  const PDA = '9YnDSsNuXAUDUN2HsGgY9FFCek1TS5XdLW4dccRoyXLd';

  it('lays out channel_pda(32) || nonce(8 LE) || transferredAmount(8 LE)', () => {
    const nonce = 5n;
    const amount = 1_000_000n;
    const msg = buildBalanceProofMessage(PDA, nonce, amount);
    expect(msg.length).toBe(48);

    // First 32 bytes == raw base58-decoded PDA.
    expect([...msg.slice(0, 32)]).toEqual([...base58Decode(PDA)]);

    // nonce little-endian at offset 32.
    expect(msg[32]).toBe(5);
    expect(msg[33]).toBe(0);

    // amount little-endian at offset 40: 1_000_000 = 0x0F4240.
    expect(msg[40]).toBe(0x40);
    expect(msg[41]).toBe(0x42);
    expect(msg[42]).toBe(0x0f);
  });

  it('signs a message the matching public key verifies (round-trip)', () => {
    const seed = ed25519.utils.randomSecretKey
      ? ed25519.utils.randomSecretKey()
      : new Uint8Array(32).fill(7);
    const pubkey = ed25519.getPublicKey(seed);
    const nonce = 3n;
    const amount = 42n;
    const sig = signBalanceProofMessage(PDA, nonce, amount, seed);
    expect(sig.length).toBe(64);
    const message = buildBalanceProofMessage(PDA, nonce, amount);
    expect(ed25519.verify(sig, message, pubkey)).toBe(true);
  });
});
