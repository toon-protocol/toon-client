/**
 * NIP-59 gift-wrap UNWRAP, receiver side only. Backs the daemon's
 * `POST /nip59-unwrap` control-API endpoint (toon-meta#256): an external
 * agent process (buzz#19's agent-members) hands the daemon a kind:1059 event
 * addressed to the daemon's own Nostr identity, and gets back the decrypted
 * inner event — without the daemon's secret key ever leaving this process,
 * let alone the caller's.
 *
 * There is deliberately no `wrap` (sender) side here yet — nothing in this
 * client originates gift wraps today (the swap rumor path builds its own via
 * the sdk). Add one only when a sender use case actually needs it.
 *
 * Uses `nostr-tools/nip44` for both decrypt layers and `nostr-tools/pure`'s
 * `verifyEvent` for the seal signature check — no hand-rolled crypto.
 *
 * ─── Why a bespoke unwrap instead of `nostr-tools/nip59`'s `unwrapEvent` ────
 * `unwrapEvent` throws away the seal once it has decrypted through it, so it
 * can never tell a caller who actually signed the rumor — only the wrap's
 * ephemeral, throwaway `pubkey` is visible from outside. NIP-59 is explicit
 * that authorship must be read off the SEAL, never the wrap, so this module
 * decrypts the two layers by hand (still via `nip44.getConversationKey` /
 * `nip44.decrypt`, the same primitives `unwrapEvent` uses internally) in
 * order to surface `seal.pubkey` — verified against the seal's own
 * signature, not merely trusted as a decrypted field.
 */

import { getConversationKey, decrypt as nip44Decrypt } from 'nostr-tools/nip44';
import { verifyEvent } from 'nostr-tools/pure';
import type { NostrEvent, UnsignedEvent } from 'nostr-tools/pure';

/** `kind:1059` — the outer gift wrap. */
export const GIFT_WRAP_KIND = 1059;
/** `kind:13` — the inner seal, signed by the real author. */
export const SEAL_KIND = 13;

/**
 * The wrap was structurally invalid, not a gift wrap, or not addressed to
 * the identity attempting to unwrap it. None of these required decrypting
 * anything — they're rejectable from the event's plaintext envelope alone.
 * Maps to HTTP 400 at the control-API boundary.
 */
export class GiftWrapAddressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GiftWrapAddressError';
  }
}

/**
 * The wrap looked addressable but a cryptographic step failed: a NIP-44
 * layer didn't decrypt, the decrypted payload wasn't the expected event
 * shape, or the seal's signature didn't verify against its own `pubkey`.
 * Maps to HTTP 422 at the control-API boundary.
 */
export class GiftWrapDecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GiftWrapDecryptError';
  }
}

/** Result of a successful unwrap. */
export interface UnwrappedGiftWrap {
  /** The decrypted inner event (NIP-59 calls it the "rumor") — unsigned. */
  rumor: UnsignedEvent & { id?: string };
  /**
   * The hex pubkey that signed the kind:13 seal, VERIFIED against the seal's
   * own signature. This — never `wrap.pubkey`, which NIP-59 mints fresh and
   * throws away per wrap — is the real author.
   */
  sealPubkey: string;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Structural check for "looks like a fully-signed Nostr event". */
function isNostrEventShape(value: unknown): value is NostrEvent {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e['kind'] === 'number' &&
    typeof e['pubkey'] === 'string' &&
    typeof e['content'] === 'string' &&
    typeof e['created_at'] === 'number' &&
    Array.isArray(e['tags']) &&
    typeof e['id'] === 'string' &&
    typeof e['sig'] === 'string'
  );
}

/** Structural check for "looks like an unsigned event shell" (the rumor). */
function isUnsignedEventShape(
  value: unknown
): value is UnsignedEvent & { id?: string } {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e['kind'] === 'number' &&
    typeof e['pubkey'] === 'string' &&
    typeof e['content'] === 'string' &&
    typeof e['created_at'] === 'number' &&
    Array.isArray(e['tags'])
  );
}

/**
 * Unwrap a NIP-59 gift wrap addressed to `recipientPubkey`, decrypting both
 * layers with `recipientSecretKey`. Pure function (no I/O, no client state)
 * so it can be unit-tested directly against real `nostr-tools/nip59` fixtures
 * — see `nip59.test.ts`. {@link ToonClient.unwrapGiftWrap} is a thin
 * passthrough that supplies the client's own identity key.
 *
 * @throws {GiftWrapAddressError} malformed input, wrong kind, or not
 *   addressed to `recipientPubkey`.
 * @throws {GiftWrapDecryptError} a NIP-44 layer failed to decrypt, decrypted
 *   to the wrong shape, or the seal's signature didn't verify.
 */
export function unwrapGiftWrapWithKey(
  recipientSecretKey: Uint8Array,
  recipientPubkey: string,
  wrap: NostrEvent
): UnwrappedGiftWrap {
  if (!isNostrEventShape(wrap)) {
    throw new GiftWrapAddressError(
      'wrap is not a valid Nostr event (kind/pubkey/content/created_at/tags/id/sig required).'
    );
  }
  if (wrap.kind !== GIFT_WRAP_KIND) {
    throw new GiftWrapAddressError(
      `wrap.kind must be ${GIFT_WRAP_KIND} (gift wrap), got ${wrap.kind}.`
    );
  }
  const addressedToUs = wrap.tags.some(
    (tag) => tag[0] === 'p' && tag[1] === recipientPubkey
  );
  if (!addressedToUs) {
    throw new GiftWrapAddressError(
      'gift wrap is not addressed to this identity (no matching "p" tag).'
    );
  }

  // ── Layer 1: open the wrap with the ephemeral sender key, revealing the seal.
  let seal: unknown;
  try {
    const wrapKey = getConversationKey(recipientSecretKey, wrap.pubkey);
    seal = JSON.parse(nip44Decrypt(wrap.content, wrapKey));
  } catch (err) {
    throw new GiftWrapDecryptError(
      `failed to decrypt gift wrap (layer 1): ${message(err)}`
    );
  }
  if (!isNostrEventShape(seal) || seal.kind !== SEAL_KIND) {
    throw new GiftWrapDecryptError(
      'decrypted wrap content is not a valid kind:13 seal event.'
    );
  }
  // The seal's signature is the ONLY thing that proves `seal.pubkey` — a
  // freshly-decrypted plain object — actually authored the rumor. Skipping
  // this check would let anyone who can encrypt-to-us forge an arbitrary
  // `sealPubkey` in the response.
  if (!verifyEvent(seal)) {
    throw new GiftWrapDecryptError(
      "seal signature verification failed — the seal was not validly signed by its claimed pubkey."
    );
  }

  // ── Layer 2: open the seal with the real sender key, revealing the rumor.
  let rumor: unknown;
  try {
    const sealKey = getConversationKey(recipientSecretKey, seal.pubkey);
    rumor = JSON.parse(nip44Decrypt(seal.content, sealKey));
  } catch (err) {
    throw new GiftWrapDecryptError(
      `failed to decrypt seal (layer 2): ${message(err)}`
    );
  }
  if (!isUnsignedEventShape(rumor)) {
    throw new GiftWrapDecryptError(
      'decrypted seal content is not a valid unsigned event (rumor).'
    );
  }

  return { rumor, sealPubkey: seal.pubkey };
}
