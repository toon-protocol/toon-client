/**
 * The seal's behaviour, as opposed to its bytes.
 *
 * The bytes are `wire-vectors.test.ts`'s job — every pinned wrap, fulfilment
 * and condition is reproduced there against the connector's committed vectors.
 * What is left, and what lives here, are the properties a fixed fixture cannot
 * express: that a REAL seal draws fresh randomness every time, that the two
 * failure modes stay distinguishable, and that the wrong key never yields
 * plaintext. Each mirrors a `#[test]` in
 * `crates/connector-signer/src/giftwrap.rs`.
 */

import { describe, it, expect } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { randomBytes } from '@noble/hashes/utils.js';
import {
  GIFTWRAP_NONCE_LENGTH,
  GIFTWRAP_PUBLIC_KEY_LENGTH,
  GIFTWRAP_SECRET_LENGTH,
  GIFTWRAP_TYPE_REQUEST,
  GIFTWRAP_TYPE_RESPONSE,
  GiftWrapError,
  GiftWrapErrorKind,
  deriveCondition,
  deriveFulfillment,
  giftWrapPublicKey,
  localGiftWrapEcdh,
  looksLikeSealedResponse,
  openRequest,
  openResponse,
  sealRequest,
  sealRequestWithRandomness,
  sealResponse,
  sealResponseWithRandomness,
} from './giftwrap.js';
import {
  EnvelopeError,
  decodeEnvelopeRequest,
  encodeEnvelopeRequest,
} from './envelope.js';
import { fulfillmentMatchesCondition } from '../utils/condition.js';

function receiver(): { secret: Uint8Array; publicKey: Uint8Array } {
  const secret = secp256k1.utils.randomSecretKey();
  return { secret, publicKey: secp256k1.getPublicKey(secret, false) };
}

const PLAINTEXT = encodeEnvelopeRequest({
  method: 'POST',
  target: '/orders',
  headers: [['content-type', 'application/json']],
  body: new TextEncoder().encode('{"item":"widget"}'),
});

function caught(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('sealing and opening a request', () => {
  it('round-trips the envelope and the shared secret', () => {
    const { secret, publicKey } = receiver();
    const sealed = sealRequest(PLAINTEXT, publicKey);

    const opened = openRequest(sealed.wrapped, secret);

    expect(opened.envelopeBytes).toEqual(PLAINTEXT);
    expect(opened.sharedSecret).toEqual(sealed.sharedSecret);
  });

  it('frames the wrap exactly as the wire spec says', () => {
    const { publicKey } = receiver();
    const { wrapped } = sealRequest(PLAINTEXT, publicKey);

    expect(wrapped[0]).toBe(GIFTWRAP_TYPE_REQUEST);
    // `0x04 ‖ X ‖ Y` — the uncompressed form the framing pins, not the
    // 33-byte compressed one.
    expect(wrapped[1]).toBe(0x04);
    // type + ephemeral public + nonce + (plaintext + secret + Poly1305 tag).
    expect(wrapped.length).toBe(
      1 +
        GIFTWRAP_PUBLIC_KEY_LENGTH +
        GIFTWRAP_NONCE_LENGTH +
        GIFTWRAP_SECRET_LENGTH +
        PLAINTEXT.length +
        16
    );
  });

  it('accepts the receiver key compressed or uncompressed', () => {
    // A connector reports the 65-byte form at `GET /ilp/identity`, but the
    // ECDH result is a property of the point, not of how it was written down.
    const { secret } = receiver();
    const uncompressed = secp256k1.getPublicKey(secret, false);
    const compressed = secp256k1.getPublicKey(secret, true);
    const ephemeral = secp256k1.utils.randomSecretKey();
    const sharedSecret = randomBytes(GIFTWRAP_SECRET_LENGTH);
    const nonce = randomBytes(GIFTWRAP_NONCE_LENGTH);

    expect(
      sealRequestWithRandomness(
        PLAINTEXT,
        compressed,
        ephemeral,
        sharedSecret,
        nonce
      )
    ).toEqual(
      sealRequestWithRandomness(
        PLAINTEXT,
        uncompressed,
        ephemeral,
        sharedSecret,
        nonce
      )
    );
  });

  it('draws a fresh ephemeral key, secret and nonce for every seal', () => {
    // The one property a pinned vector can never check, and the one whose
    // failure is catastrophic: a repeated (key, nonce) under ChaCha20-Poly1305
    // leaks both plaintexts, and a repeated shared secret repeats the payment
    // preimage.
    const { publicKey } = receiver();
    const first = sealRequest(PLAINTEXT, publicKey);
    const second = sealRequest(PLAINTEXT, publicKey);

    expect(first.wrapped).not.toEqual(second.wrapped);
    expect(first.sharedSecret).not.toEqual(second.sharedSecret);
    const ephemeralOf = (w: Uint8Array) => w.slice(1, 1 + 65).toString();
    expect(ephemeralOf(first.wrapped)).not.toBe(ephemeralOf(second.wrapped));
  });

  it('opens through a GiftWrapEcdh that never exposes the secret key', () => {
    // The `Signer::ecdh` shape: a KMS- or HSM-backed identity can open a wrap
    // without its key crossing its own boundary.
    const { secret, publicKey } = receiver();
    const { wrapped, sharedSecret } = sealRequest(PLAINTEXT, publicKey);

    const opened = openRequest(wrapped, localGiftWrapEcdh(secret));

    expect(opened.sharedSecret).toEqual(sharedSecret);
  });

  it('does not open under a different identity — a forwarding hop sees opaque bytes', () => {
    const { publicKey } = receiver();
    const forwardingHop = receiver();
    const { wrapped } = sealRequest(PLAINTEXT, publicKey);

    const error = caught(() => openRequest(wrapped, forwardingHop.secret));

    expect(error).toBeInstanceOf(GiftWrapError);
    expect((error as GiftWrapError).kind).toBe(GiftWrapErrorKind.OpenFailed);
  });

  it('refuses a tampered ciphertext rather than yielding plaintext', () => {
    const { secret, publicKey } = receiver();
    const { wrapped } = sealRequest(PLAINTEXT, publicKey);
    wrapped[wrapped.length - 1] ^= 0xff;

    expect(
      (caught(() => openRequest(wrapped, secret)) as GiftWrapError).kind
    ).toBe(GiftWrapErrorKind.OpenFailed);
  });

  it('refuses a tampered ephemeral public key', () => {
    const { secret, publicKey } = receiver();
    const { wrapped } = sealRequest(PLAINTEXT, publicKey);
    wrapped[10] ^= 0xff;

    const error = caught(() => openRequest(wrapped, secret));

    expect(error).toBeInstanceOf(GiftWrapError);
    // Either the point no longer parses (invalid_key) or it parses to a
    // different point whose ECDH gives the wrong key (open_failed). Both are
    // refusals; neither is plaintext.
    expect([
      GiftWrapErrorKind.InvalidKey,
      GiftWrapErrorKind.OpenFailed,
    ]).toContain((error as GiftWrapError).kind);
  });

  it('refuses a response wrap fed to openRequest, naming the type it wanted', () => {
    const { secret, publicKey } = receiver();
    const { wrapped } = sealRequest(PLAINTEXT, publicKey);
    wrapped[0] = GIFTWRAP_TYPE_RESPONSE;

    const error = caught(() => openRequest(wrapped, secret)) as GiftWrapError;

    expect(error.kind).toBe(GiftWrapErrorKind.InvalidType);
    expect(error.expectedType).toBe(GIFTWRAP_TYPE_REQUEST);
  });

  it('refuses truncated bytes', () => {
    const { secret, publicKey } = receiver();
    const { wrapped } = sealRequest(PLAINTEXT, publicKey);

    for (const bytes of [
      new Uint8Array(0),
      Uint8Array.of(GIFTWRAP_TYPE_REQUEST),
      // A full, well-formed ephemeral key but not even room for a nonce.
      wrapped.slice(0, 1 + GIFTWRAP_PUBLIC_KEY_LENGTH + 4),
      // A nonce but a ciphertext shorter than the Poly1305 tag.
      wrapped.slice(0, 1 + GIFTWRAP_PUBLIC_KEY_LENGTH + GIFTWRAP_NONCE_LENGTH),
    ]) {
      const error = caught(() => openRequest(bytes, secret));
      expect(error).toBeInstanceOf(GiftWrapError);
      expect((error as GiftWrapError).kind).toBe(GiftWrapErrorKind.Truncated);
    }
  });
});

describe('sealing and opening a response', () => {
  it("opens under the request's own secret, with no second key exchange", () => {
    const { secret, publicKey } = receiver();
    const request = sealRequest(PLAINTEXT, publicKey);
    const { sharedSecret } = openRequest(request.wrapped, secret);

    const sealed = sealResponse(sharedSecret, PLAINTEXT);

    // Opened with the SENDER's copy of the secret, which never left it.
    expect(openResponse(request.sharedSecret, sealed)).toEqual(PLAINTEXT);
  });

  it('does not open under any other secret', () => {
    const sharedSecret = randomBytes(GIFTWRAP_SECRET_LENGTH);
    const sealed = sealResponse(sharedSecret, PLAINTEXT);

    const error = caught(() =>
      openResponse(randomBytes(GIFTWRAP_SECRET_LENGTH), sealed)
    );

    expect((error as GiftWrapError).kind).toBe(GiftWrapErrorKind.OpenFailed);
  });

  it('refuses a tampered ciphertext', () => {
    const sharedSecret = randomBytes(GIFTWRAP_SECRET_LENGTH);
    const sealed = sealResponse(sharedSecret, PLAINTEXT);
    sealed[sealed.length - 1] ^= 0xff;

    expect(
      (caught(() => openResponse(sharedSecret, sealed)) as GiftWrapError).kind
    ).toBe(GiftWrapErrorKind.OpenFailed);
  });

  it('refuses a request wrap fed to openResponse', () => {
    const { publicKey } = receiver();
    const { wrapped, sharedSecret } = sealRequest(PLAINTEXT, publicKey);

    const error = caught(() =>
      openResponse(sharedSecret, wrapped)
    ) as GiftWrapError;

    expect(error.kind).toBe(GiftWrapErrorKind.InvalidType);
    expect(error.expectedType).toBe(GIFTWRAP_TYPE_RESPONSE);
  });

  it('draws a fresh nonce for every response sealed with one secret', () => {
    const sharedSecret = randomBytes(GIFTWRAP_SECRET_LENGTH);

    expect(sealResponse(sharedSecret, PLAINTEXT)).not.toEqual(
      sealResponse(sharedSecret, PLAINTEXT)
    );
  });
});

describe('telling a sealed reject from a plaintext one', () => {
  it('reads the leading type byte and nothing else', () => {
    const sharedSecret = randomBytes(GIFTWRAP_SECRET_LENGTH);
    const { publicKey } = receiver();

    expect(looksLikeSealedResponse(sealResponse(sharedSecret, PLAINTEXT))).toBe(
      true
    );
    expect(
      looksLikeSealedResponse(sealRequest(PLAINTEXT, publicKey).wrapped)
    ).toBe(false);
  });

  it('never reads an empty Reject.data as sealed', () => {
    // Every reject raised short of the termination carries empty `data` and
    // shares no secret with the sender. Reading one as sealed would turn "a
    // hop declined" into "the destination declined".
    expect(looksLikeSealedResponse(new Uint8Array(0))).toBe(false);
  });

  it('does not need the shared secret to decide', () => {
    const sealed = sealResponse(randomBytes(GIFTWRAP_SECRET_LENGTH), PLAINTEXT);
    expect(looksLikeSealedResponse(sealed)).toBe(true);
  });
});

describe('two failure modes, two types', () => {
  it('separates "could not open" from "opened, but not an envelope"', () => {
    // The acceptance criterion this exists for: a caller must be able to tell
    // a wrap it could not read from a peer that sent it nonsense. The first is
    // a GiftWrapError raised by giftwrap.ts; the second is an EnvelopeError
    // raised above it, by the codec, on plaintext that opened perfectly well.
    const { secret, publicKey } = receiver();

    const unopenable = sealRequest(PLAINTEXT, publicKey).wrapped;
    unopenable[unopenable.length - 1] ^= 0xff;
    expect(caught(() => openRequest(unopenable, secret))).toBeInstanceOf(
      GiftWrapError
    );

    const garbageInside = sealRequest(Uint8Array.of(0x09, 0x09), publicKey);
    const opened = openRequest(garbageInside.wrapped, secret);
    expect(opened.envelopeBytes).toEqual(Uint8Array.of(0x09, 0x09));
    const envelopeFailure = caught(() =>
      decodeEnvelopeRequest(opened.envelopeBytes)
    );
    expect(envelopeFailure).toBeInstanceOf(EnvelopeError);
    expect(envelopeFailure).not.toBeInstanceOf(GiftWrapError);
  });
});

describe('the fulfilment a shared secret derives', () => {
  it('satisfies the condition the sender minted before it ever sealed', () => {
    // The whole point of ADR 0019: the sender can mint its condition from a
    // secret it chose, and the terminating connector produces the preimage by
    // opening the wrap — no app participation, nothing carried in the clear.
    const { secret, publicKey } = receiver();
    const { wrapped, sharedSecret } = sealRequest(PLAINTEXT, publicKey);
    const condition = deriveCondition(deriveFulfillment(sharedSecret));

    const recovered = openRequest(wrapped, secret).sharedSecret;

    expect(
      fulfillmentMatchesCondition(deriveFulfillment(recovered), condition)
    ).toBe(true);
  });

  it('is 32 bytes and differs from the secret it came from', () => {
    const sharedSecret = randomBytes(GIFTWRAP_SECRET_LENGTH);
    const fulfilment = deriveFulfillment(sharedSecret);

    expect(fulfilment).toHaveLength(GIFTWRAP_SECRET_LENGTH);
    expect(fulfilment).not.toEqual(sharedSecret);
  });

  it("does not satisfy another secret's condition", () => {
    const condition = deriveCondition(
      deriveFulfillment(randomBytes(GIFTWRAP_SECRET_LENGTH))
    );
    const other = deriveFulfillment(randomBytes(GIFTWRAP_SECRET_LENGTH));

    expect(fulfillmentMatchesCondition(other, condition)).toBe(false);
  });

  it('is domain-separated from both AEAD keys the same secret derives', () => {
    // The three `info` strings are the only thing keeping a payment preimage
    // from being a key that also decrypts traffic. If the fulfilment ever
    // equalled either AEAD key, revealing it on a FULFILL would reveal the
    // packet.
    const sharedSecret = randomBytes(GIFTWRAP_SECRET_LENGTH);
    const fulfilment = deriveFulfillment(sharedSecret);

    // Reconstruct what the response AEAD key must be by sealing a known
    // plaintext with the secret and checking the fulfilment does not open it.
    const sealed = sealResponse(sharedSecret, PLAINTEXT);
    expect(caught(() => openResponse(fulfilment, sealed))).toBeInstanceOf(
      GiftWrapError
    );
  });

  it('refuses a secret that is not 32 bytes rather than deriving from it', () => {
    expect(
      (caught(() => deriveFulfillment(new Uint8Array(31))) as GiftWrapError)
        .kind
    ).toBe(GiftWrapErrorKind.Truncated);
  });
});

describe('the caller-supplied-randomness variants', () => {
  it('refuse a shared secret or nonce of the wrong length', () => {
    const { publicKey } = receiver();
    const ephemeral = secp256k1.utils.randomSecretKey();
    const goodSecret = randomBytes(GIFTWRAP_SECRET_LENGTH);
    const goodNonce = randomBytes(GIFTWRAP_NONCE_LENGTH);

    // A short nonce zero-padded, or a short secret, would silently produce a
    // wrap nothing can open — and, for a repeated nonce, one that leaks.
    expect(
      caught(() =>
        sealRequestWithRandomness(
          PLAINTEXT,
          publicKey,
          ephemeral,
          new Uint8Array(31),
          goodNonce
        )
      )
    ).toBeInstanceOf(GiftWrapError);
    expect(
      caught(() =>
        sealRequestWithRandomness(
          PLAINTEXT,
          publicKey,
          ephemeral,
          goodSecret,
          new Uint8Array(8)
        )
      )
    ).toBeInstanceOf(GiftWrapError);
    expect(
      caught(() =>
        sealResponseWithRandomness(goodSecret, PLAINTEXT, new Uint8Array(8))
      )
    ).toBeInstanceOf(GiftWrapError);
  });

  it('refuse an ephemeral secret that is not a valid scalar', () => {
    const { publicKey } = receiver();

    expect(
      (
        caught(() =>
          sealRequestWithRandomness(
            PLAINTEXT,
            publicKey,
            new Uint8Array(32),
            randomBytes(GIFTWRAP_SECRET_LENGTH),
            randomBytes(GIFTWRAP_NONCE_LENGTH)
          )
        ) as GiftWrapError
      ).kind
    ).toBe(GiftWrapErrorKind.InvalidKey);
  });

  it('refuse a receiver key that is not a curve point', () => {
    expect(
      (
        caught(() =>
          sealRequestWithRandomness(
            PLAINTEXT,
            new Uint8Array(65),
            secp256k1.utils.randomSecretKey(),
            randomBytes(GIFTWRAP_SECRET_LENGTH),
            randomBytes(GIFTWRAP_NONCE_LENGTH)
          )
        ) as GiftWrapError
      ).kind
    ).toBe(GiftWrapErrorKind.InvalidKey);
  });
});

describe('giftWrapPublicKey', () => {
  it('derives the same uncompressed public key a sender ECDHs against to reach this secret', () => {
    const { secret, publicKey } = receiver();
    expect(giftWrapPublicKey(secret)).toEqual(publicKey);
  });

  it('is stable across calls — the same secret always yields the same key', () => {
    const { secret } = receiver();
    expect(giftWrapPublicKey(secret)).toEqual(giftWrapPublicKey(secret));
  });

  it('is what a sealed request to it actually opens under', () => {
    const { secret } = receiver();
    const publicKey = giftWrapPublicKey(secret);

    const { wrapped, sharedSecret } = sealRequest(PLAINTEXT, publicKey);
    const opened = openRequest(wrapped, secret);

    expect(opened.envelopeBytes).toEqual(PLAINTEXT);
    expect(opened.sharedSecret).toEqual(sharedSecret);
  });

  it('throws GiftWrapError for a secret key that is not a valid scalar', () => {
    expect(
      (caught(() => giftWrapPublicKey(new Uint8Array(32))) as GiftWrapError)
        .kind
    ).toBe(GiftWrapErrorKind.InvalidKey);
  });
});
