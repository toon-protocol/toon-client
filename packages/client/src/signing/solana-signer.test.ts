import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { base58Decode } from '@toon-protocol/core';
import { SolanaSigner } from './solana-signer.js';

/** A valid base58 32-byte address standing in for a channel PDA. */
const CHANNEL_ACCOUNT = 'GfHq2tTVk9z4eXgZ8nWz3vWqkXBQ8K9aBcDeFgHiJkLm';

describe('SolanaSigner.signClaimStateChallenge', () => {
  it('produces a signature that verifies against the tagged challenge message', async () => {
    const seed = randomBytes(32);
    const signer = new SolanaSigner(seed);
    const expires = 1_735_689_600;

    const signatureBase64 = await signer.signClaimStateChallenge({
      channelAccount: CHANNEL_ACCOUNT,
      expires,
    });

    const tag = new TextEncoder().encode('toon-claim-state-challenge-v1');
    const accountBytes = base58Decode(CHANNEL_ACCOUNT);
    const expected = new Uint8Array(tag.length + 32 + 8);
    expected.set(tag, 0);
    expected.set(accountBytes, tag.length);
    new DataView(expected.buffer).setBigUint64(tag.length + 32, BigInt(expires), true);

    const signature = Uint8Array.from(Buffer.from(signatureBase64, 'base64'));
    const publicKey = ed25519.getPublicKey(seed);
    expect(ed25519.verify(signature, expected, publicKey)).toBe(true);
  });

  it('produces a DIFFERENT message than a real balance-proof claim, by length', async () => {
    // A real Solana payment-channel balance-proof message is 48 bytes
    // (`channel_pda(32) || nonce(8 LE) || transferredAmount(8 LE)`); the
    // claim-state challenge tag alone is already longer, so the two can
    // never collide byte-for-byte regardless of field values.
    const tagLength = new TextEncoder().encode('toon-claim-state-challenge-v1').length;
    expect(tagLength + 32 + 8).not.toBe(48);
  });

  it('changes the signature when expires changes', async () => {
    const seed = randomBytes(32);
    const signer = new SolanaSigner(seed);

    const sig1 = await signer.signClaimStateChallenge({
      channelAccount: CHANNEL_ACCOUNT,
      expires: 1_735_689_600,
    });
    const sig2 = await signer.signClaimStateChallenge({
      channelAccount: CHANNEL_ACCOUNT,
      expires: 1_735_689_601,
    });

    expect(sig1).not.toBe(sig2);
  });

  it('rejects a channelAccount that does not decode to 32 bytes', async () => {
    const signer = new SolanaSigner(randomBytes(32));
    await expect(
      signer.signClaimStateChallenge({ channelAccount: 'abc', expires: 1 })
    ).rejects.toThrow(/32 bytes/);
  });
});
