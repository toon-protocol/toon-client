/**
 * The gift wrap (ADR 0018) and the fulfilment a shared secret derives (ADR
 * 0019): the seal around the {@link ./envelope.js | envelope}, so a packet
 * payload is readable only by the connector that terminates it and the
 * preimage that pays for it needs no app participation.
 *
 * A faithful port of `connector_signer::giftwrap`
 * (`crates/connector-signer/src/giftwrap.rs` on toon-protocol/connector `main`)
 * and of `connector_domain::condition::derive_condition`
 * (`crates/connector-domain/src/condition.rs:27`). `vectors/wire-vectors.json`'s
 * `giftwrap` and `fulfilment` sections are the contract, replayed byte-for-byte
 * in `wire-vectors.test.ts`; the prose here describes the same thing but the
 * bytes decide.
 *
 * ─── The mechanism, as read off the Rust ────────────────────────────────────
 * Recorded here because it cannot be inferred from the vector file's field
 * names, and because the acceptance criterion for toon-client#449 asks for it
 * in writing. Every line below is cited to
 * `crates/connector-signer/src/giftwrap.rs` unless stated otherwise.
 *
 * - **Curve and ECDH.** The receiver's identity key is secp256k1; the value a
 *   real connector reports from `GET /ilp/identity` is its 65-byte
 *   uncompressed form (`0x04 ‖ X ‖ Y`). The sender ECDHs a fresh, per-packet
 *   ephemeral key against it and uses the **raw X-coordinate** of the
 *   resulting point — `crypto.rs`'s `ecdh_x_coordinate` does
 *   `tweak_mul_assign` then `serialize_compressed()[1..]`, deliberately *not*
 *   `libsecp256k1::SharedSecret`'s digest-mixing variant. So: not hashed, and
 *   not the 33-byte compressed point.
 * - **Key derivation.** `HKDF-SHA256`, **no salt** (`Hkdf::new(None, ikm)`,
 *   i.e. HKDF-Extract with an all-zero salt), expanded to 32 bytes under one
 *   of three fixed ASCII `info` strings — `giftwrap.rs`'s `hkdf_key`:
 *   - `toon-giftwrap-request` — the request AEAD key, over the ECDH X.
 *   - `toon-giftwrap-response` — the response AEAD key, over the shared secret.
 *   - `toon-giftwrap-fulfillment` — the fulfilment, over the shared secret.
 *     (American spelling on the wire; the vector *section* is `fulfilment`.)
 *   These three strings are the only domain separation between two AEAD keys
 *   and a payment preimage all derived from the same input, so one wrong
 *   character silently yields bytes that decrypt nothing and satisfy no
 *   condition.
 * - **AEAD.** ChaCha20-Poly1305 (RFC 8439), 12-byte nonce, **no** additional
 *   authenticated data.
 * - **Request framing.** `0x01 ‖ ephemeral_public(65) ‖ nonce(12) ‖
 *   ciphertext`, where the encrypted plaintext is `shared_secret(32) ‖
 *   encoded_envelope`. The secret rides *inside* the sealed request, which is
 *   what lets the response be sealed with no second key exchange.
 * - **Response framing.** `0x02 ‖ nonce(12) ‖ ciphertext`, the plaintext being
 *   just the encoded envelope. Sealed directly with the request's shared
 *   secret.
 * - **Fulfilment and condition.** `fulfilment = HKDF-SHA256(shared_secret,
 *   "toon-giftwrap-fulfillment")`; the condition a sender mints is
 *   `sha256(fulfilment)` — `condition.rs`'s `derive_condition`. A sender knows
 *   the secret before it seals, so it can mint the condition first; the
 *   terminating connector recovers the secret by opening the wrap and derives
 *   the preimage without asking the app anything.
 * - **Telling a sealed reject from a plaintext one.** The leading type byte,
 *   and only that (`looks_like_sealed_response`). A reject raised short of the
 *   termination shares no secret with the sender and carries empty `data`; an
 *   empty `data` is never sealed, so a sealed reject is positive proof that
 *   the destination itself said no.
 *
 * ─── Two failure modes, two types ───────────────────────────────────────────
 * A wrap that cannot be OPENED throws {@link GiftWrapError}. A wrap that opens
 * cleanly but whose recovered plaintext is not a valid envelope throws
 * `EnvelopeError`, from `envelope.ts` — a different class entirely, raised
 * above this module rather than by it. The Rust keeps the same separation
 * (`GiftWrapError` vs `connector_domain::EnvelopeError`) for the same reason:
 * "I could not read this" and "I read this and it was malformed" are different
 * facts about a peer, and collapsing them loses the distinction at every call
 * site.
 *
 * ─── Callers ────────────────────────────────────────────────────────────────
 * `ToonClient.publishEvent` (toon-client#450) seals to a connector that
 * TERMINATES the destination and lets it derive the fulfilment (ADR 0019),
 * via `wire/sealed-exchange.ts`. `serve-job.ts`'s `createJobMessageHandler`
 * (toon-client#537) is the other direction: THIS client is the destination,
 * so it opens a request addressed to its own {@link giftWrapPublicKey} and
 * seals the answer back — never a connector-derived fulfilment, since the
 * hashlock preimage there comes from `hashlock-delivery.ts` instead.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';

// ─── Constants (giftwrap.rs:36-46) ──────────────────────────────────────────

/** ChaCha20-Poly1305 nonce length. */
export const GIFTWRAP_NONCE_LENGTH = 12;
/** The shared secret carried inside a sealed request, and the fulfilment. */
export const GIFTWRAP_SECRET_LENGTH = 32;
/** The uncompressed secp256k1 public key a sealed request carries. */
export const GIFTWRAP_PUBLIC_KEY_LENGTH = 65;

const REQUEST_INFO = 'toon-giftwrap-request';
const RESPONSE_INFO = 'toon-giftwrap-response';
const FULFILLMENT_INFO = 'toon-giftwrap-fulfillment';

/** `TYPE_GIFTWRAP_REQUEST` — the leading byte of a sealed request. */
export const GIFTWRAP_TYPE_REQUEST = 1;
/** `TYPE_GIFTWRAP_RESPONSE` — the leading byte of a sealed response. */
export const GIFTWRAP_TYPE_RESPONSE = 2;

/** Poly1305 tag length — the minimum a non-empty ciphertext can be. */
const TAG_LENGTH = 16;

// ─── Errors ─────────────────────────────────────────────────────────────────

/**
 * Every distinguishable way a wrap can fail to open — the four variants of
 * `GiftWrapError` in `giftwrap.rs:57-71`, named the same way. There is
 * deliberately no catch-all: this module must never be able to fail "somehow".
 *
 * None of these ever carries decrypted plaintext, matching the Rust's own
 * guarantee.
 */
export enum GiftWrapErrorKind {
  /** The leading byte is not the one this direction requires. */
  InvalidType = 'invalid_type',
  /** The bytes end before the framing does. */
  Truncated = 'truncated',
  /** An ephemeral or receiver public key that is not a usable curve point. */
  InvalidKey = 'invalid_key',
  /** The AEAD refused: wrong key, wrong nonce, or a tampered ciphertext. */
  OpenFailed = 'open_failed',
}

const GIFTWRAP_ERROR_MESSAGES: Record<GiftWrapErrorKind, string> = {
  [GiftWrapErrorKind.InvalidType]: 'invalid gift wrap type byte',
  [GiftWrapErrorKind.Truncated]: 'gift wrap is truncated',
  [GiftWrapErrorKind.InvalidKey]: 'invalid ephemeral or peer public key',
  [GiftWrapErrorKind.OpenFailed]: 'gift wrap failed to decrypt',
};

/**
 * A refusal to open a wrap. `kind` is the machine-readable reason;
 * `expectedType` names the type byte that was required, for
 * {@link GiftWrapErrorKind.InvalidType} — mirroring
 * `GiftWrapError::InvalidType(u8)`.
 */
export class GiftWrapError extends Error {
  constructor(
    readonly kind: GiftWrapErrorKind,
    readonly expectedType?: number
  ) {
    super(
      expectedType === undefined
        ? GIFTWRAP_ERROR_MESSAGES[kind]
        : `${GIFTWRAP_ERROR_MESSAGES[kind]}: expected ${expectedType}`
    );
    this.name = 'GiftWrapError';
  }
}

// ─── Shapes ─────────────────────────────────────────────────────────────────

/**
 * What sealing a request produces: the bytes to carry as `Prepare.data`, and
 * the shared secret that both derives this packet's fulfilment and opens the
 * answer. The sender must keep the secret — it is the only thing that opens
 * the response, and the only thing that proves the fulfilment it is paid
 * against was earned rather than guessed.
 */
export interface SealedRequest {
  /** `0x01 ‖ ephemeral_public(65) ‖ nonce(12) ‖ ciphertext`. */
  readonly wrapped: Uint8Array;
  /** The 32 random bytes sealed inside `wrapped`. */
  readonly sharedSecret: Uint8Array;
}

/** What opening a sealed request recovers. */
export interface OpenedRequest {
  /** The encoded envelope — feed to `decodeEnvelopeRequest`. */
  readonly envelopeBytes: Uint8Array;
  /** The 32-byte secret the sender chose, for the fulfilment and the answer. */
  readonly sharedSecret: Uint8Array;
}

/**
 * A key agreement that never hands out secret key material — the TypeScript
 * counterpart of `giftwrap.rs`'s dependency on `Signer::ecdh`, and the reason
 * {@link openRequest} takes this rather than a raw private key: a remote or
 * hardware-backed identity can open a wrap without its key leaving its own
 * boundary.
 *
 * Returns the raw 32-byte ECDH X-coordinate, or throws.
 */
export interface GiftWrapEcdh {
  ecdh(ephemeralPublicKey: Uint8Array): Uint8Array;
}

// ─── Primitives ─────────────────────────────────────────────────────────────

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * `HKDF-SHA256(ikm, salt = none, info, L = 32)` — `giftwrap.rs`'s `hkdf_key`.
 * The absent salt is load-bearing: HKDF-Extract runs with an all-zero salt, so
 * passing a salt of any kind produces a different, silently-wrong key.
 */
function hkdfKey(ikm: Uint8Array, info: string): Uint8Array {
  return hkdf(sha256, ikm, undefined, info, 32);
}

/** `giftwrap.rs`'s `encrypt_with_nonce`: `nonce ‖ ciphertext`. */
function encryptWithNonce(
  key: Uint8Array,
  plaintext: Uint8Array,
  nonce: Uint8Array
): Uint8Array {
  return concat([nonce, chacha20poly1305(key, nonce).encrypt(plaintext)]);
}

/** `giftwrap.rs`'s `decrypt`: splits `nonce ‖ ciphertext` and opens it. */
function decrypt(key: Uint8Array, nonceAndCiphertext: Uint8Array): Uint8Array {
  if (nonceAndCiphertext.length < GIFTWRAP_NONCE_LENGTH) {
    throw new GiftWrapError(GiftWrapErrorKind.Truncated);
  }
  const nonce = nonceAndCiphertext.subarray(0, GIFTWRAP_NONCE_LENGTH);
  const ciphertext = nonceAndCiphertext.subarray(GIFTWRAP_NONCE_LENGTH);
  // A ciphertext shorter than the Poly1305 tag cannot be an AEAD output at
  // all. `@noble/ciphers` throws a plain `Error` for that rather than failing
  // the tag check, so classify it here instead of letting a foreign error type
  // escape this module.
  if (ciphertext.length < TAG_LENGTH) {
    throw new GiftWrapError(GiftWrapErrorKind.Truncated);
  }
  try {
    return chacha20poly1305(key, nonce).decrypt(ciphertext);
  } catch {
    throw new GiftWrapError(GiftWrapErrorKind.OpenFailed);
  }
}

/**
 * The raw ECDH X-coordinate of `secret * public` — `crypto.rs`'s
 * `ecdh_x_coordinate`. `@noble/curves` returns the compressed point, whose
 * bytes `1..33` are exactly the `serialize_compressed()[1..]` the Rust takes.
 */
function ecdhXCoordinate(
  secretKey: Uint8Array,
  publicKey: Uint8Array
): Uint8Array {
  let compressed: Uint8Array;
  try {
    compressed = secp256k1.getSharedSecret(secretKey, publicKey, true);
  } catch {
    throw new GiftWrapError(GiftWrapErrorKind.InvalidKey);
  }
  return compressed.slice(1);
}

/**
 * The ordinary local case of {@link GiftWrapEcdh}: a 32-byte secp256k1 secret
 * key held in this process. `openRequest` accepts a bare key too and wraps it
 * in this.
 */
export function localGiftWrapEcdh(secretKey: Uint8Array): GiftWrapEcdh {
  return {
    ecdh: (ephemeralPublicKey) =>
      ecdhXCoordinate(secretKey, ephemeralPublicKey),
  };
}

/**
 * The 65-byte uncompressed secp256k1 public key a `secretKey` opens gift
 * wraps under — the counterpart {@link openRequest}/{@link localGiftWrapEcdh}
 * derive their ECDH from, and the same format a real connector reports from
 * `GET /ilp/identity` (`ConnectorIdentity.publicKey`). A caller publishes
 * this as a `kind:31990` advertisement's `seal_pubkey` tag (toon-meta#266
 * §3.1) so a buyer can seal a job's PREPARE `data` to it directly, without a
 * `GET /identity` this client cannot serve (ADR 0022).
 */
export function giftWrapPublicKey(secretKey: Uint8Array): Uint8Array {
  try {
    return secp256k1.getPublicKey(secretKey, false);
  } catch {
    throw new GiftWrapError(GiftWrapErrorKind.InvalidKey);
  }
}

// ─── Request direction ──────────────────────────────────────────────────────

/**
 * The deterministic core of {@link sealRequest}, parameterized on every value
 * a real seal draws at random — the counterpart of the Rust's
 * `seal_request_with_randomness`, which that crate gates behind a `test-util`
 * feature for a reason worth repeating: **reusing a (key, nonce) pair under
 * ChaCha20-Poly1305 is catastrophic**, so caller-supplied randomness is a
 * footgun, not a convenience. Use {@link sealRequest} unless you are replaying
 * a fixed vector.
 *
 * `receiverPublicKey` may be the 65-byte uncompressed form a connector's
 * `GET /ilp/identity` reports, or the 33-byte compressed form; the ECDH result
 * is the same point either way. The ephemeral key is always emitted
 * uncompressed, because that is what the framing pins.
 */
export function sealRequestWithRandomness(
  plaintext: Uint8Array,
  receiverPublicKey: Uint8Array,
  ephemeralSecretKey: Uint8Array,
  sharedSecret: Uint8Array,
  nonce: Uint8Array
): Uint8Array {
  if (sharedSecret.length !== GIFTWRAP_SECRET_LENGTH) {
    throw new GiftWrapError(GiftWrapErrorKind.Truncated);
  }
  if (nonce.length !== GIFTWRAP_NONCE_LENGTH) {
    throw new GiftWrapError(GiftWrapErrorKind.Truncated);
  }

  let ephemeralPublicKey: Uint8Array;
  try {
    ephemeralPublicKey = secp256k1.getPublicKey(ephemeralSecretKey, false);
  } catch {
    throw new GiftWrapError(GiftWrapErrorKind.InvalidKey);
  }

  const aeadKey = hkdfKey(
    ecdhXCoordinate(ephemeralSecretKey, receiverPublicKey),
    REQUEST_INFO
  );
  const inner = concat([sharedSecret, plaintext]);

  return concat([
    Uint8Array.of(GIFTWRAP_TYPE_REQUEST),
    ephemeralPublicKey,
    encryptWithNonce(aeadKey, inner, nonce),
  ]);
}

/**
 * Seal `plaintext` (an encoded envelope) to `receiverPublicKey`. A fresh
 * ephemeral key pair, shared secret and nonce are drawn for this call alone,
 * so no two sealed requests — even to the same receiver, even with the same
 * plaintext — share any of the three.
 *
 * Returns the wire bytes and the shared secret. Mint the packet's execution
 * condition as {@link deriveCondition}({@link deriveFulfillment}(secret))
 * before sending: the terminating connector recovers the same secret by
 * opening this wrap, so the preimage it is paid against is one it derived, not
 * one anybody handed it.
 */
export function sealRequest(
  plaintext: Uint8Array,
  receiverPublicKey: Uint8Array
): SealedRequest {
  const ephemeralSecretKey = secp256k1.utils.randomSecretKey();
  const sharedSecret = randomBytes(GIFTWRAP_SECRET_LENGTH);
  const nonce = randomBytes(GIFTWRAP_NONCE_LENGTH);

  return {
    wrapped: sealRequestWithRandomness(
      plaintext,
      receiverPublicKey,
      ephemeralSecretKey,
      sharedSecret,
      nonce
    ),
    sharedSecret,
  };
}

/**
 * Open a sealed request addressed to `identity`, recovering the encoded
 * envelope and the shared secret carried alongside it.
 *
 * `identity` is either a 32-byte secp256k1 secret key or a {@link GiftWrapEcdh}
 * that never exposes one. `serve-job.ts` calls this for real (toon-client#537):
 * when this client is itself the BTP destination, it is the party that opens
 * the wrap. It also makes the seal testable from both ends — and the vectors'
 * "opening it with the fixture's secret key must recover the envelope and the
 * secret exactly" a check this repo can actually run.
 */
export function openRequest(
  bytes: Uint8Array,
  identity: Uint8Array | GiftWrapEcdh
): OpenedRequest {
  if (bytes.length === 0) {
    throw new GiftWrapError(GiftWrapErrorKind.Truncated);
  }
  if (bytes[0] !== GIFTWRAP_TYPE_REQUEST) {
    throw new GiftWrapError(
      GiftWrapErrorKind.InvalidType,
      GIFTWRAP_TYPE_REQUEST
    );
  }
  if (bytes.length < 1 + GIFTWRAP_PUBLIC_KEY_LENGTH) {
    throw new GiftWrapError(GiftWrapErrorKind.Truncated);
  }

  const ephemeralPublicKey = bytes.slice(1, 1 + GIFTWRAP_PUBLIC_KEY_LENGTH);
  const ciphertext = bytes.subarray(1 + GIFTWRAP_PUBLIC_KEY_LENGTH);

  const agreement =
    identity instanceof Uint8Array ? localGiftWrapEcdh(identity) : identity;
  let ecdhSecret: Uint8Array;
  try {
    ecdhSecret = agreement.ecdh(ephemeralPublicKey);
  } catch (error) {
    throw error instanceof GiftWrapError
      ? error
      : new GiftWrapError(GiftWrapErrorKind.InvalidKey);
  }

  const plaintext = decrypt(hkdfKey(ecdhSecret, REQUEST_INFO), ciphertext);
  if (plaintext.length < GIFTWRAP_SECRET_LENGTH) {
    throw new GiftWrapError(GiftWrapErrorKind.Truncated);
  }

  return {
    envelopeBytes: plaintext.slice(GIFTWRAP_SECRET_LENGTH),
    sharedSecret: plaintext.slice(0, GIFTWRAP_SECRET_LENGTH),
  };
}

// ─── Response direction ─────────────────────────────────────────────────────

/**
 * The deterministic core of {@link sealResponse}, parameterized on the nonce.
 * Same footgun, same warning as {@link sealRequestWithRandomness}: a nonce
 * reused under one shared secret destroys the confidentiality of both
 * responses sealed with it.
 */
export function sealResponseWithRandomness(
  sharedSecret: Uint8Array,
  plaintext: Uint8Array,
  nonce: Uint8Array
): Uint8Array {
  if (sharedSecret.length !== GIFTWRAP_SECRET_LENGTH) {
    throw new GiftWrapError(GiftWrapErrorKind.Truncated);
  }
  if (nonce.length !== GIFTWRAP_NONCE_LENGTH) {
    throw new GiftWrapError(GiftWrapErrorKind.Truncated);
  }
  return concat([
    Uint8Array.of(GIFTWRAP_TYPE_RESPONSE),
    encryptWithNonce(hkdfKey(sharedSecret, RESPONSE_INFO), plaintext, nonce),
  ]);
}

/**
 * Seal `plaintext` — an encoded response envelope, or a reject's diagnostic
 * bytes — with the request's own `sharedSecret`. No second key exchange: the
 * secret is bidirectional by construction, which is also why a sealed reject
 * can only have come from the termination.
 */
export function sealResponse(
  sharedSecret: Uint8Array,
  plaintext: Uint8Array
): Uint8Array {
  return sealResponseWithRandomness(
    sharedSecret,
    plaintext,
    randomBytes(GIFTWRAP_NONCE_LENGTH)
  );
}

/**
 * Open a sealed response with the shared secret {@link sealRequest} returned
 * for the request it answers. No signer, no key exchange, no identity key.
 */
export function openResponse(
  sharedSecret: Uint8Array,
  bytes: Uint8Array
): Uint8Array {
  if (bytes.length === 0) {
    throw new GiftWrapError(GiftWrapErrorKind.Truncated);
  }
  if (bytes[0] !== GIFTWRAP_TYPE_RESPONSE) {
    throw new GiftWrapError(
      GiftWrapErrorKind.InvalidType,
      GIFTWRAP_TYPE_RESPONSE
    );
  }
  if (sharedSecret.length !== GIFTWRAP_SECRET_LENGTH) {
    throw new GiftWrapError(GiftWrapErrorKind.Truncated);
  }
  return decrypt(hkdfKey(sharedSecret, RESPONSE_INFO), bytes.subarray(1));
}

/**
 * Whether `bytes` is shaped like a sealed response — the leading type byte and
 * nothing else, exactly as `looks_like_sealed_response` does it. This is how a
 * sender tells a reject raised BY the destination from one raised on the way
 * to it, without holding the secret to try opening it.
 *
 * Empty `data`, which every reject raised short of a termination carries, is
 * never sealed.
 */
export function looksLikeSealedResponse(bytes: Uint8Array): boolean {
  return bytes.length > 0 && bytes[0] === GIFTWRAP_TYPE_RESPONSE;
}

// ─── Fulfilment and condition ───────────────────────────────────────────────

/**
 * The fulfilment a request's shared secret derives (ADR 0019):
 * `HKDF-SHA256(shared_secret, "toon-giftwrap-fulfillment")`, 32 bytes.
 * Domain-separated by its own `info` string from both AEAD keys the same
 * secret also derives, so it can never collide with either.
 */
export function deriveFulfillment(sharedSecret: Uint8Array): Uint8Array {
  if (sharedSecret.length !== GIFTWRAP_SECRET_LENGTH) {
    throw new GiftWrapError(GiftWrapErrorKind.Truncated);
  }
  return hkdfKey(sharedSecret, FULFILLMENT_INFO);
}

/**
 * The condition a `fulfillment` satisfies: `sha256(fulfillment)` —
 * `connector_domain::condition::derive_condition`. Hashing only ever runs in
 * this direction; there is deliberately no function here that goes from a
 * condition back to a fulfilment.
 *
 * The hash is the same one `utils/condition.ts` already uses; what ADR 0019
 * changes is where the preimage comes from. `mintExecutionCondition` there
 * draws a random preimage the sender must then carry to the FULFILL itself;
 * here the preimage is DERIVED from the secret sealed inside the packet, so
 * the terminating connector can produce it without the sender or the app
 * handing it over. Checking a returned fulfilment against a condition is
 * unchanged either way — use `fulfillmentMatchesCondition` from
 * `utils/condition.ts` for that rather than a second copy of it here.
 */
export function deriveCondition(fulfillment: Uint8Array): Uint8Array {
  return sha256(fulfillment);
}
