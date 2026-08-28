import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { base58Decode } from '../utils/base58.js';
import { SolanaSigner } from './solana-signer.js';
import { buildBalanceProofMessage } from '../channel/solana/payment-channel.js';

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

  it('produces a DIFFERENT message than a real balance-proof claim', async () => {
    // A real Solana balance-proof message is the 96-byte ADR 0053 message
    // (`"TOON-BALPROOF-V2" || programId || channelAccount || nonce || amount`).
    // A challenge is 69 bytes and opens with a different tag, so the two can
    // never collide byte-for-byte regardless of field values — a captured
    // challenge cannot be replayed as a payment, or a payment as a challenge.
    const tag = new TextEncoder().encode('toon-claim-state-challenge-v1');
    const challengeLength = tag.length + 32 + 8;
    expect(challengeLength).toBe(69);
    expect(challengeLength).not.toBe(
      buildBalanceProofMessage(
        'Prog1111111111111111111111111111111111111111',
        CHANNEL_ACCOUNT,
        1n,
        1n
      ).length
    );
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
