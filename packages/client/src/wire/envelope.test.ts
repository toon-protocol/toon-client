/**
 * Properties of the envelope codec that the vectors do not (and should not)
 * enumerate: arbitrary-input safety, the canonical-length rejections stated as
 * intent rather than as five bytes, and the round trips the vectors only sample.
 *
 * `wire-vectors.test.ts` is the conformance suite. This file is the one that
 * says *why*.
 */

import { describe, it, expect } from 'vitest';
import {
  EnvelopeError,
  EnvelopeErrorKind,
  decodeEnvelope,
  decodeEnvelopeRequest,
  decodeEnvelopeResponse,
  encodeEnvelopeRequest,
  encodeEnvelopeResponse,
  type EnvelopeRequest,
  type EnvelopeResponse,
} from './envelope.js';
import { OerError, OerErrorKind, decodeVarUint, encodeVarUint } from './oer.js';

const utf8 = (s: string) => new TextEncoder().encode(s);

function sampleRequest(): EnvelopeRequest {
  return {
    method: 'POST',
    target: '/orders',
    headers: [
      ['content-type', 'application/json'],
      ['x-request-id', 'abc-123'],
    ],
    body: utf8('{"item":"widget"}'),
  };
}

function sampleResponse(): EnvelopeResponse {
  return {
    status: 200,
    headers: [['content-type', 'application/json']],
    body: utf8('{"ok":true}'),
  };
}

/** The bytes issue #546 reports three spellings of: `GET /`, no headers, no body. */
function canonicalGetRoot(): number[] {
  return [0x01, 0x03, 0x47, 0x45, 0x54, 0x01, 0x2f, 0x00, 0x00];
}

function kindOf(run: () => unknown): EnvelopeErrorKind | 'no-throw' | 'other' {
  try {
    run();
    return 'no-throw';
  } catch (error) {
    return error instanceof EnvelopeError ? error.kind : 'other';
  }
}

describe('VarUInt is canonical', () => {
  it.each([0n, 1n, 127n, 128n, 255n, 256n, 65535n, 65536n, 2n ** 64n - 1n])(
    'round-trips %s',
    (value) => {
      const encoded = encodeVarUint(value);
      const decoded = decodeVarUint(encoded, 0);
      expect(decoded.value).toBe(value);
      expect(decoded.consumed).toBe(encoded.length);
    }
  );

  it('matches the documented short/long boundary', () => {
    expect([...encodeVarUint(0n)]).toEqual([0x00]);
    expect([...encodeVarUint(127n)]).toEqual([0x7f]);
    expect([...encodeVarUint(128n)]).toEqual([0x81, 0x80]);
    expect([...encodeVarUint(255n)]).toEqual([0x81, 0xff]);
  });

  it.each([
    ['a non-minimal long form', [0x81, 0x03], OerErrorKind.NonCanonicalLength],
    ['a zero-length long-form alias', [0x80], OerErrorKind.NonCanonicalLength],
    [
      'a nine-byte determinant',
      [0x89, 1, 0, 0, 0, 0, 0, 0, 0, 3],
      OerErrorKind.LengthDeterminantOverflow,
    ],
    ['a truncated determinant', [0x82, 0x01], OerErrorKind.BufferUnderflow],
  ])('refuses %s', (_name, bytes, kind) => {
    try {
      decodeVarUint(Uint8Array.from(bytes as number[]), 0);
      throw new Error('should not decode');
    } catch (error) {
      expect(error).toBeInstanceOf(OerError);
      expect((error as OerError).kind).toBe(kind);
    }
  });
});

describe('a request envelope', () => {
  it('round-trips exactly', () => {
    const request = sampleRequest();
    const encoded = encodeEnvelopeRequest(request);
    expect(encoded[0]).toBe(1);
    expect(decodeEnvelopeRequest(encoded)).toEqual(request);
  });

  it('keeps duplicate header names, in order', () => {
    const request: EnvelopeRequest = {
      ...sampleRequest(),
      headers: [
        ['x-a', '1'],
        ['x-a', '2'],
      ],
    };
    expect(decodeEnvelopeRequest(encodeEnvelopeRequest(request))).toEqual(
      request
    );
  });

  it('keeps header order that a map would have sorted away', () => {
    const request: EnvelopeRequest = {
      ...sampleRequest(),
      headers: [
        ['z-last', '1'],
        ['a-first', '2'],
      ],
    };
    expect(
      decodeEnvelopeRequest(encodeEnvelopeRequest(request)).headers
    ).toEqual(request.headers);
  });

  it('carries non-ASCII and an empty body without reinterpretation', () => {
    const request: EnvelopeRequest = {
      method: 'GET',
      target: '/search?q=✓',
      headers: [['x-emoji', '🛰️']],
      body: new Uint8Array(0),
    };
    expect(decodeEnvelopeRequest(encodeEnvelopeRequest(request))).toEqual(
      request
    );
  });

  it('carries a body that is not text at all', () => {
    const request: EnvelopeRequest = {
      ...sampleRequest(),
      body: Uint8Array.from([0x00, 0x01, 0xff, 0xfe, 0x80, 0x7f]),
    };
    expect(decodeEnvelopeRequest(encodeEnvelopeRequest(request)).body).toEqual(
      request.body
    );
  });

  it('does not alias the buffer it decoded from', () => {
    const encoded = encodeEnvelopeRequest(sampleRequest());
    const decoded = decodeEnvelopeRequest(encoded);
    encoded.fill(0);
    expect(new TextDecoder().decode(decoded.body)).toBe('{"item":"widget"}');
  });
});

describe('a response envelope', () => {
  it('round-trips exactly', () => {
    const response = sampleResponse();
    const encoded = encodeEnvelopeResponse(response);
    expect(encoded[0]).toBe(2);
    expect(decodeEnvelopeResponse(encoded)).toEqual(response);
  });

  it.each([0, 1, 200, 206, 404, 502, 0xffff])(
    'carries status %i as two big-endian bytes',
    (status) => {
      const encoded = encodeEnvelopeResponse({
        ...sampleResponse(),
        status,
      });
      expect([encoded[1], encoded[2]]).toEqual([status >> 8, status & 0xff]);
      expect(decodeEnvelopeResponse(encoded).status).toBe(status);
    }
  );

  it('refuses to encode a status that does not fit two bytes', () => {
    expect(() =>
      encodeEnvelopeResponse({ ...sampleResponse(), status: 70000 })
    ).toThrow(RangeError);
  });
});

describe('every failure mode is distinguishable', () => {
  it('rejects the wrong type byte in each direction', () => {
    const request = encodeEnvelopeRequest(sampleRequest());
    request[0] = 2;
    expect(kindOf(() => decodeEnvelopeRequest(request))).toBe(
      EnvelopeErrorKind.InvalidType
    );

    const response = encodeEnvelopeResponse(sampleResponse());
    response[0] = 1;
    expect(kindOf(() => decodeEnvelopeResponse(response))).toBe(
      EnvelopeErrorKind.InvalidType
    );
  });

  it('rejects trailing bytes rather than ignoring them', () => {
    const encoded = encodeEnvelopeRequest(sampleRequest());
    const extended = Uint8Array.from([...encoded, 0xff]);
    expect(kindOf(() => decodeEnvelopeRequest(extended))).toBe(
      EnvelopeErrorKind.TrailingBytes
    );
  });

  it('rejects an empty buffer as underflow, not as a wrong type', () => {
    expect(kindOf(() => decodeEnvelopeRequest(new Uint8Array(0)))).toBe(
      EnvelopeErrorKind.BufferUnderflow
    );
    expect(kindOf(() => decodeEnvelopeResponse(new Uint8Array(0)))).toBe(
      EnvelopeErrorKind.BufferUnderflow
    );
  });

  it('rejects a truncated response status', () => {
    expect(kindOf(() => decodeEnvelopeResponse(Uint8Array.from([2, 0])))).toBe(
      EnvelopeErrorKind.BufferUnderflow
    );
  });

  it('rejects invalid UTF-8 and names the field', () => {
    // A lone continuation byte: valid as bytes, not as text.
    const bytes = Uint8Array.from([0x01, 0x01, 0x80]);
    try {
      decodeEnvelopeRequest(bytes);
      throw new Error('should not decode');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvelopeError);
      expect((error as EnvelopeError).kind).toBe(EnvelopeErrorKind.InvalidUtf8);
      expect((error as EnvelopeError).field).toBe('method');
    }
  });

  it('accepts the canonical GET / and refuses both aliases of it', () => {
    // The point of ADR 0023: these three nearly encode the same envelope, and
    // exactly one of them is allowed to.
    const canonical = Uint8Array.from(canonicalGetRoot());
    expect(decodeEnvelopeRequest(canonical).method).toBe('GET');

    const nonMinimal = Uint8Array.from([
      0x01,
      0x81,
      0x03,
      ...canonicalGetRoot().slice(2),
    ]);
    expect(kindOf(() => decodeEnvelopeRequest(nonMinimal))).toBe(
      EnvelopeErrorKind.NonCanonicalLength
    );

    const zeroLengthAlias = Uint8Array.from([
      0x01, 0x80, 0x01, 0x2f, 0x00, 0x00,
    ]);
    expect(kindOf(() => decodeEnvelopeRequest(zeroLengthAlias))).toBe(
      EnvelopeErrorKind.NonCanonicalLength
    );
  });

  it('rejects an over-wide determinant instead of truncating it', () => {
    const overWide = Uint8Array.from([
      0x01, 0x89, 0x01, 0, 0, 0, 0, 0, 0, 0, 0x03, 0x47, 0x45, 0x54, 0x01, 0x2f,
      0x00, 0x00,
    ]);
    expect(kindOf(() => decodeEnvelopeRequest(overWide))).toBe(
      EnvelopeErrorKind.LengthDeterminantOverflow
    );
  });

  it('refuses a header count larger than the bytes that remain', () => {
    // `0x88 ffffffffffffffff` header pairs would be u64::MAX headers. A decoder
    // that trusted the count and looped would never return.
    const absurd = Uint8Array.from([
      0x01, 0x03, 0x47, 0x45, 0x54, 0x01, 0x2f, 0x88, 0xff, 0xff, 0xff, 0xff,
      0xff, 0xff, 0xff, 0xff, 0x00,
    ]);
    expect(kindOf(() => decodeEnvelopeRequest(absurd))).toBe(
      EnvelopeErrorKind.BufferUnderflow
    );
  });
});

describe('arbitrary bytes never produce an unhandled error', () => {
  /** Deterministic PRNG — a fuzz that fails must fail again on the next run. */
  function* pseudoRandom(seed: number): Generator<number> {
    let state = seed >>> 0;
    for (;;) {
      state = (state * 1664525 + 1013904223) >>> 0;
      yield (state >>> 24) & 0xff;
    }
  }

  it('throws only EnvelopeError, across 4000 random buffers', () => {
    const rng = pseudoRandom(0x5eed);
    const surprises: { bytes: string; error: unknown }[] = [];

    for (let i = 0; i < 2000; i++) {
      const length = (rng.next().value as number) % 40;
      const bytes = Uint8Array.from(
        { length },
        () => rng.next().value as number
      );
      for (const direction of ['request', 'response'] as const) {
        try {
          decodeEnvelope(bytes, direction);
        } catch (error) {
          if (!(error instanceof EnvelopeError)) {
            surprises.push({
              bytes: Array.from(bytes, (b) => b.toString(16)).join(''),
              error,
            });
          }
        }
      }
    }

    expect(surprises).toEqual([]);
  });

  it('throws only EnvelopeError on single-byte mutations of a valid envelope', () => {
    const base = encodeEnvelopeRequest(sampleRequest());
    for (let i = 0; i < base.length; i++) {
      for (const replacement of [0x00, 0x01, 0x02, 0x7f, 0x80, 0x89, 0xff]) {
        const mutated = Uint8Array.from(base);
        mutated[i] = replacement;
        try {
          decodeEnvelopeRequest(mutated);
        } catch (error) {
          expect(error).toBeInstanceOf(EnvelopeError);
        }
      }
    }
  });
});
