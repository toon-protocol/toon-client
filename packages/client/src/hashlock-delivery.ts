/**
 * Hashlock delivery helpers (toon-meta#262 decision 5, toon-client#495) —
 * symmetric between the provider and buyer sides of one factory-job
 * increment, per `docs/factory-job-protocol.md` §4.2 (toon-meta).
 *
 * The provider encrypts an increment's artifact under a fresh key and sets
 * `condition = sha256(key)`; the only way to claim the increment's payment
 * is to reveal `key` as the ILP fulfillment — which is the same instant the
 * buyer can decrypt. Neither party moves first, because there is no first.
 *
 * That property holds only if `condition` is derived from nothing but the
 * key that actually decrypts the artifact. {@link encryptArtifact} is the
 * ONLY place a `condition` is minted, and it takes no key or condition
 * parameter — there is no way to call it with a condition that does not
 * match the key it generates. Do not build a second path that derives a
 * condition from the artifact, a job id, or any other value.
 *
 * Artifacts are permanent on Arweave (decision 13) — there is no deletion —
 * so confidentiality rests entirely on `key`. Never log a key, and never let
 * one reach an error message.
 *
 * AEAD: ChaCha20-Poly1305 (RFC 8439), the same primitive `wire/giftwrap.ts`
 * uses for the connector's sealed envelopes — 12-byte random nonce prepended
 * to the ciphertext, no additional authenticated data. The key doubles as
 * the 32-byte ILP fulfillment ({@link fulfillIncrement}), which is why it is
 * exactly {@link CONDITION_LENGTH} bytes rather than a cipher-chosen size.
 *
 * Isomorphic: `@noble/*` only, no Buffer, no `node:crypto`.
 */

import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import {
  CONDITION_LENGTH,
  assertValidCondition,
  fulfillmentMatchesCondition,
} from './utils/condition.js';
import { fromHex } from './utils/binary.js';

/** ChaCha20-Poly1305 nonce length (RFC 8439). */
const NONCE_LENGTH = 12;
/** Poly1305 authentication tag length (RFC 8439). */
const TAG_LENGTH = 16;

/** What encrypting an artifact produces (provider side). */
export interface EncryptedArtifact {
  /** `nonce(12) || AEAD ciphertext` — safe to upload to Arweave as-is. */
  readonly ciphertext: Uint8Array;
  /**
   * The freshly minted 32-byte symmetric key. This is also the ILP
   * fulfillment ({@link fulfillIncrement}) — never reuse it for another
   * increment, never log it, never put it in an error message.
   */
  readonly key: Uint8Array;
  /** `sha256(key)` — publish as the kind:7000 offer's `condition` tag. */
  readonly condition: Uint8Array;
}

/**
 * Provider: encrypt one increment's artifact under a freshly minted key and
 * derive its hashlock condition.
 *
 * Deliberately takes only the artifact bytes. There is no `key` or
 * `condition` parameter — accepting either would let a caller mint a
 * condition that does not match the key that actually decrypts the
 * artifact, silently breaking the atomicity this module exists to
 * guarantee. Call this once per increment; a reused key means paying for
 * increment *i* unlocks increment *i+1*.
 */
export function encryptArtifact(artifact: Uint8Array): EncryptedArtifact {
  const key = randomBytes(CONDITION_LENGTH);
  const nonce = randomBytes(NONCE_LENGTH);
  const sealed = chacha20poly1305(key, nonce).encrypt(artifact);
  const ciphertext = new Uint8Array(NONCE_LENGTH + sealed.length);
  ciphertext.set(nonce, 0);
  ciphertext.set(sealed, NONCE_LENGTH);
  return { ciphertext, key, condition: sha256(key) };
}

/**
 * Provider: fulfil an increment by revealing `key` as the ILP fulfillment.
 * The key IS the fulfillment (identity) — this exists so the "reveal the
 * key" step has one named call site rather than being inlined wherever a
 * FULFILL is built, and so a wrongly-sized key fails loudly here instead of
 * on the wire.
 *
 * @throws {Error} if `key` is not exactly {@link CONDITION_LENGTH} bytes.
 */
export function fulfillIncrement(key: Uint8Array): Uint8Array {
  assertValidCondition(key);
  return key;
}

/**
 * Thrown when `sha256(key)` does not match the condition the buyer actually
 * paid. Never carries `key` or any derived secret — only lengths and hex of
 * the (public) conditions being compared.
 */
export class HashlockConditionMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HashlockConditionMismatchError';
  }
}

/**
 * Thrown when a ciphertext fails to decrypt under a key that DID satisfy the
 * paid condition — a corrupted or tampered artifact fetch. Never carries the
 * key or any recovered plaintext.
 */
export class HashlockDecryptError extends Error {
  constructor(message: string, override readonly cause?: Error) {
    super(message);
    this.name = 'HashlockDecryptError';
  }
}

/**
 * Buyer: verify `key` against `paidCondition`, then decrypt.
 *
 * `paidCondition` MUST be the condition the buyer's own PREPARE carried as
 * `executionCondition` — read from local state, never re-derived from the
 * `key` just handed over by the provider at reveal time. Re-deriving it
 * would make this check tautological and defeat the reason it exists: to
 * catch a provider who advertised one condition, got paid against it, then
 * revealed a DIFFERENT key that happens to decrypt something.
 *
 * @throws {HashlockConditionMismatchError} `sha256(key) !== paidCondition`.
 * @throws {HashlockDecryptError} the AEAD open failed (tampered/corrupted
 *   ciphertext, or a truncated one).
 */
export function decryptArtifact(
  ciphertext: Uint8Array,
  key: Uint8Array,
  paidCondition: Uint8Array
): Uint8Array {
  assertValidCondition(paidCondition);
  if (!fulfillmentMatchesCondition(key, paidCondition)) {
    throw new HashlockConditionMismatchError(
      'sha256(key) does not match the condition that was paid — refusing to decrypt'
    );
  }
  if (ciphertext.length < NONCE_LENGTH + TAG_LENGTH) {
    throw new HashlockDecryptError(
      `ciphertext is too short to be a sealed artifact (${ciphertext.length} bytes)`
    );
  }
  const nonce = ciphertext.subarray(0, NONCE_LENGTH);
  const sealed = ciphertext.subarray(NONCE_LENGTH);
  try {
    return chacha20poly1305(key, nonce).decrypt(sealed);
  } catch (error) {
    throw new HashlockDecryptError(
      'artifact ciphertext failed to decrypt (tampered or corrupted fetch)',
      error instanceof Error ? error : undefined
    );
  }
}

/** What a buyer reads off an advertised kind:7000 increment offer (§4.1). */
export interface IncrementOfferTags {
  /** The `condition` tag's value: hex-encoded `sha256(key)`. */
  readonly conditionHex: string;
  /** The `amount` tag's value: decimal micro-USDC. */
  readonly amountUsdc: string;
}

/** PREPARE-ready fields derived from an advertised increment offer. */
export interface IncrementPrepare {
  /** Spread into `ToonClient.sendSwapPacket`'s `executionCondition`. */
  readonly executionCondition: Uint8Array;
  /** Spread into `ToonClient.sendSwapPacket`'s `amount`. */
  readonly amount: bigint;
}

/**
 * Buyer: turn an advertised kind:7000 increment offer's `condition` and
 * `amount` tags into the fields a PREPARE needs — `executionCondition` MUST
 * equal the offer's `condition` byte for byte (spec §4.2), which is exactly
 * what this returns, undecorated.
 *
 * Pure parsing: does not send anything, does not touch a channel. Feed the
 * result into `sendSwapPacket({ destination, amount, toonData, executionCondition })`.
 *
 * @throws {Error} a malformed hex condition, a condition that is not
 *   {@link CONDITION_LENGTH} bytes once decoded, or a non-positive/
 *   non-numeric amount.
 */
export function buildIncrementPrepare(
  offer: IncrementOfferTags
): IncrementPrepare {
  const executionCondition = fromHex(offer.conditionHex);
  assertValidCondition(executionCondition);

  let amount: bigint;
  try {
    amount = BigInt(offer.amountUsdc);
  } catch {
    throw new Error(`amount tag is not a valid integer: "${offer.amountUsdc}"`);
  }
  if (amount <= 0n) {
    throw new Error(`amount tag must be positive, got "${offer.amountUsdc}"`);
  }

  return { executionCondition, amount };
}
