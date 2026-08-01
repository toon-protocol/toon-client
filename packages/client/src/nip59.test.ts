/**
 * Unit tests for the NIP-59 gift-wrap unwrap primitive (toon-meta#256), using
 * REAL fixtures built with `nostr-tools/nip59` — no hand-rolled crypto on
 * either side of the fence.
 */
import { describe, it, expect } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { wrapEvent, createRumor, createSeal, createWrap } from 'nostr-tools/nip59';
import { encrypt as nip44Encrypt, getConversationKey } from 'nostr-tools/nip44';
import type { NostrEvent } from 'nostr-tools/pure';
import {
  unwrapGiftWrapWithKey,
  GiftWrapAddressError,
  GiftWrapDecryptError,
  GIFT_WRAP_KIND,
  SEAL_KIND,
} from './nip59.js';

describe('unwrapGiftWrapWithKey', () => {
  const senderSecretKey = generateSecretKey();
  const senderPubkey = getPublicKey(senderSecretKey);
  const recipientSecretKey = generateSecretKey();
  const recipientPubkey = getPublicKey(recipientSecretKey);

  it('round-trips a real nostr-tools nip59 wrap back to the original rumor', () => {
    const rumorTemplate = {
      kind: 30078,
      content: JSON.stringify({ channelKey: 'super-secret-channel-key' }),
      tags: [['d', 'buzz-channel-42']],
    };
    const wrap = wrapEvent(rumorTemplate, senderSecretKey, recipientPubkey);

    expect(wrap.kind).toBe(GIFT_WRAP_KIND);

    const result = unwrapGiftWrapWithKey(
      recipientSecretKey,
      recipientPubkey,
      wrap
    );

    expect(result.rumor.kind).toBe(30078);
    expect(result.rumor.content).toBe(rumorTemplate.content);
    expect(result.rumor.tags).toEqual(rumorTemplate.tags);
    expect(result.rumor.pubkey).toBe(senderPubkey);
    // The real author, read off the SEAL — not the wrap's throwaway key.
    expect(result.sealPubkey).toBe(senderPubkey);
    expect(result.sealPubkey).not.toBe(wrap.pubkey);
  });

  it('sealPubkey is the sealer, not the wrap\'s ephemeral pubkey', () => {
    const wrap = wrapEvent(
      { kind: 1, content: 'hello' },
      senderSecretKey,
      recipientPubkey
    );
    // NIP-59: the wrap's own pubkey is a fresh, one-time key — never the
    // sender's real identity.
    expect(wrap.pubkey).not.toBe(senderPubkey);

    const result = unwrapGiftWrapWithKey(
      recipientSecretKey,
      recipientPubkey,
      wrap
    );
    expect(result.sealPubkey).toBe(senderPubkey);
  });

  it('rejects a wrap addressed to someone else (wrong recipient)', () => {
    const someoneElseSecretKey = generateSecretKey();
    const someoneElsePubkey = getPublicKey(someoneElseSecretKey);
    const wrap = wrapEvent(
      { kind: 1, content: 'not for you' },
      senderSecretKey,
      someoneElsePubkey
    );

    expect(() =>
      unwrapGiftWrapWithKey(recipientSecretKey, recipientPubkey, wrap)
    ).toThrow(GiftWrapAddressError);
  });

  it('rejects a non-1059 event as malformed/wrong-kind', () => {
    const notAWrap: NostrEvent = {
      kind: 1,
      pubkey: senderPubkey,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', recipientPubkey]],
      content: 'plain text, not a gift wrap',
      id: 'a'.repeat(64),
      sig: 'b'.repeat(128),
    };
    expect(() =>
      unwrapGiftWrapWithKey(recipientSecretKey, recipientPubkey, notAWrap)
    ).toThrow(GiftWrapAddressError);
  });

  it('rejects a malformed/non-object body as GiftWrapAddressError', () => {
    expect(() =>
      unwrapGiftWrapWithKey(
        recipientSecretKey,
        recipientPubkey,
        null as unknown as NostrEvent
      )
    ).toThrow(GiftWrapAddressError);
    expect(() =>
      unwrapGiftWrapWithKey(
        recipientSecretKey,
        recipientPubkey,
        {} as unknown as NostrEvent
      )
    ).toThrow(GiftWrapAddressError);
  });

  it('rejects garbage ciphertext with GiftWrapDecryptError (422-shaped)', () => {
    // Correctly addressed and shaped, but the content is not valid NIP-44
    // ciphertext at all.
    const garbage: NostrEvent = {
      kind: GIFT_WRAP_KIND,
      pubkey: senderPubkey,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', recipientPubkey]],
      content: 'not-nip44-ciphertext-at-all',
      id: 'a'.repeat(64),
      sig: 'b'.repeat(128),
    };
    expect(() =>
      unwrapGiftWrapWithKey(recipientSecretKey, recipientPubkey, garbage)
    ).toThrow(GiftWrapDecryptError);
  });

  it('rejects a wrap decryptable but not opened by the right key (wrong secret)', () => {
    const wrap = wrapEvent(
      { kind: 1, content: 'hi' },
      senderSecretKey,
      recipientPubkey
    );
    const wrongSecretKey = generateSecretKey();
    // Addressed check passes (the p-tag still names the real recipient) but
    // decryption with the wrong key must fail cleanly, not throw something
    // uncategorized.
    expect(() =>
      unwrapGiftWrapWithKey(wrongSecretKey, recipientPubkey, wrap)
    ).toThrow(GiftWrapDecryptError);
  });

  it('rejects a seal whose signature does not match its claimed pubkey', () => {
    // Build a wrap by hand where the seal's `pubkey` field is forged (claims
    // to be someone else) but the signature is still the sender's — this must
    // fail verifyEvent(seal), not be trusted.
    const rumor = createRumor({ kind: 1, content: 'forged-author test' }, senderSecretKey);
    const seal = createSeal(rumor, senderSecretKey, recipientPubkey);
    const forgedSecretKey = generateSecretKey();
    const forgedPubkey = getPublicKey(forgedSecretKey);
    const forgedSeal = { ...seal, pubkey: forgedPubkey };
    const wrap = createWrap(forgedSeal, recipientPubkey);

    expect(() =>
      unwrapGiftWrapWithKey(recipientSecretKey, recipientPubkey, wrap)
    ).toThrow(GiftWrapDecryptError);
  });

  it('rejects a decrypted rumor that is not a valid event shape', () => {
    // A genuinely-signed, genuinely-opened seal whose CONTENT decrypts to
    // something that isn't an event at all (missing pubkey/tags/etc).
    const sealKey = getConversationKey(senderSecretKey, recipientPubkey);
    const seal = finalizeEvent(
      {
        kind: SEAL_KIND,
        content: nip44Encrypt(JSON.stringify({ not: 'an-event' }), sealKey),
        tags: [],
        created_at: Math.floor(Date.now() / 1000) - 60,
      },
      senderSecretKey
    );
    const wrap = createWrap(seal, recipientPubkey);

    expect(() =>
      unwrapGiftWrapWithKey(recipientSecretKey, recipientPubkey, wrap)
    ).toThrow(GiftWrapDecryptError);
  });

  it('kind constants match the NIP-59 spec', () => {
    expect(GIFT_WRAP_KIND).toBe(1059);
    expect(SEAL_KIND).toBe(13);
  });
});
