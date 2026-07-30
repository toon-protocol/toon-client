/**
 * `sealed-exchange.ts`: the three obligations a sender has on this wire, and
 * whether they actually hold together.
 *
 * The interesting property is not that any one of seal / condition / open
 * works — `giftwrap.test.ts` and `wire-vectors.test.ts` already hold those to
 * the connector's committed bytes. It is that the THREE agree: that the
 * condition minted here is the one the fulfilment derived from the secret
 * sealed here satisfies, and that the answer sealed with that same secret
 * opens here. Every test below closes that loop against a real receiver rather
 * than a fixture.
 */

import { describe, it, expect } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  readExchangeOutcome,
  sealExchange,
  SealedResponseError,
  envelopeHeader,
} from './sealed-exchange.js';
import {
  decodeEnvelopeRequest,
  encodeEnvelopeResponse,
  type EnvelopeRequest,
  type EnvelopeResponse,
} from './envelope.js';
import {
  deriveFulfillment,
  localGiftWrapEcdh,
  openRequest,
  sealResponse,
} from './giftwrap.js';
import { isZeroCondition } from '../utils/condition.js';

const RECEIVER_SECRET = new Uint8Array(32).fill(5);
const RECEIVER_PUBLIC = secp256k1.getPublicKey(RECEIVER_SECRET, false);

const request: EnvelopeRequest = {
  method: 'POST',
  // '' = the handler's own path (ADR 0025) — what a real write sends.
  target: '',
  headers: [['content-type', 'application/json']],
  body: new TextEncoder().encode('{"event":{}}'),
};

const answer: EnvelopeResponse = {
  status: 200,
  headers: [
    ['content-type', 'application/json'],
    ['x-relay', 'ok'],
  ],
  body: new TextEncoder().encode('{"ok":true}'),
};

/** What the receiver recovers, using only its identity key. */
function receive(data: Uint8Array) {
  const { envelopeBytes, sharedSecret } = openRequest(
    data,
    localGiftWrapEcdh(RECEIVER_SECRET)
  );
  return {
    request: decodeEnvelopeRequest(envelopeBytes),
    sharedSecret,
    fulfillment: deriveFulfillment(sharedSecret),
  };
}

describe('sealExchange', () => {
  it('seals an encoded envelope the intended receiver — and only it — can read', () => {
    const exchange = sealExchange(request, RECEIVER_PUBLIC);

    expect(receive(exchange.data).request).toEqual(request);

    // A forwarding hop holds no identity secret for this destination.
    expect(() =>
      openRequest(exchange.data, localGiftWrapEcdh(new Uint8Array(32).fill(6)))
    ).toThrow();
  });

  it('mints the condition the receiver can satisfy without ever being told it', () => {
    const exchange = sealExchange(request, RECEIVER_PUBLIC);
    const { fulfillment } = receive(exchange.data);

    // The receiver derived this from the secret it recovered, with no app
    // participation and nothing sent alongside the condition (ADR 0019).
    expect(Array.from(fulfillment)).toEqual(Array.from(exchange.fulfillment));
    expect(Array.from(sha256(fulfillment))).toEqual(
      Array.from(exchange.condition)
    );
  });

  it('never mints the all-zero condition the connector refuses outright', () => {
    for (let i = 0; i < 8; i++) {
      expect(isZeroCondition(sealExchange(request, RECEIVER_PUBLIC).condition))
        .toBe(false);
    }
  });

  it('mints a fresh secret per call, so no two packets share a condition', () => {
    const a = sealExchange(request, RECEIVER_PUBLIC);
    const b = sealExchange(request, RECEIVER_PUBLIC);
    expect(Array.from(a.sharedSecret)).not.toEqual(Array.from(b.sharedSecret));
    expect(Array.from(a.condition)).not.toEqual(Array.from(b.condition));
    // Identical plaintext, different bytes: the wrap leaks no equality either.
    expect(Array.from(a.data)).not.toEqual(Array.from(b.data));
  });
});

describe('readExchangeOutcome — a FULFILL', () => {
  it('opens the answer the receiver sealed with the request’s own secret', () => {
    const exchange = sealExchange(request, RECEIVER_PUBLIC);
    const { sharedSecret } = receive(exchange.data);
    const sealed = sealResponse(sharedSecret, encodeEnvelopeResponse(answer));

    const outcome = readExchangeOutcome(
      { accepted: true },
      sealed,
      exchange.sharedSecret
    );

    expect(outcome).toEqual({ kind: 'answered', response: answer });
  });

  it('carries a non-2xx answer home as an answer, not a failure (ADR 0020)', () => {
    const exchange = sealExchange(request, RECEIVER_PUBLIC);
    const { sharedSecret } = receive(exchange.data);
    const notFound: EnvelopeResponse = {
      status: 404,
      headers: [],
      body: new TextEncoder().encode('nope'),
    };
    const sealed = sealResponse(sharedSecret, encodeEnvelopeResponse(notFound));

    const outcome = readExchangeOutcome(
      { accepted: true },
      sealed,
      exchange.sharedSecret
    );

    expect(outcome.kind).toBe('answered');
    expect(outcome.kind === 'answered' && outcome.response.status).toBe(404);
  });

  it('refuses an unsealed FULFILL rather than inventing an outcome', () => {
    const exchange = sealExchange(request, RECEIVER_PUBLIC);
    let thrown: unknown;
    try {
      readExchangeOutcome(
        { accepted: true },
        new TextEncoder().encode('ack:1'),
        exchange.sharedSecret
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SealedResponseError);
    expect((thrown as SealedResponseError).kind).toBe('not-sealed');
  });

  it('refuses an empty FULFILL', () => {
    const exchange = sealExchange(request, RECEIVER_PUBLIC);
    expect(() =>
      readExchangeOutcome({ accepted: true }, undefined, exchange.sharedSecret)
    ).toThrow(SealedResponseError);
  });

  it('refuses an answer sealed to somebody else', () => {
    const mine = sealExchange(request, RECEIVER_PUBLIC);
    const theirs = sealExchange(request, RECEIVER_PUBLIC);
    const sealed = sealResponse(
      receive(theirs.data).sharedSecret,
      encodeEnvelopeResponse(answer)
    );

    let thrown: unknown;
    try {
      readExchangeOutcome({ accepted: true }, sealed, mine.sharedSecret);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SealedResponseError);
    expect((thrown as SealedResponseError).kind).toBe('unopenable');
  });

  it('refuses an answer that opens but is not a response envelope', () => {
    const exchange = sealExchange(request, RECEIVER_PUBLIC);
    const { sharedSecret } = receive(exchange.data);
    const sealed = sealResponse(sharedSecret, new TextEncoder().encode('junk'));

    let thrown: unknown;
    try {
      readExchangeOutcome({ accepted: true }, sealed, exchange.sharedSecret);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SealedResponseError);
    expect((thrown as SealedResponseError).kind).toBe('malformed-envelope');
  });
});

describe('readExchangeOutcome — a REJECT', () => {
  it('reads a reject sealed at the termination as the DESTINATION refusing', () => {
    const exchange = sealExchange(request, RECEIVER_PUBLIC);
    const { sharedSecret } = receive(exchange.data);
    const detail = new TextEncoder().encode('over quota');

    const outcome = readExchangeOutcome(
      { accepted: false, code: 'F99', message: 'app refused' },
      sealResponse(sharedSecret, detail),
      exchange.sharedSecret
    );

    expect(outcome.kind).toBe('destination-refused');
    expect(outcome.kind === 'destination-refused' && outcome.code).toBe('F99');
    expect(
      outcome.kind === 'destination-refused' &&
        new TextDecoder().decode(outcome.detail)
    ).toBe('over quota');
  });

  it('reads a plaintext reject as a PATH refusal', () => {
    const exchange = sealExchange(request, RECEIVER_PUBLIC);

    const outcome = readExchangeOutcome(
      { accepted: false, code: 'F02', message: 'no route' },
      undefined,
      exchange.sharedSecret
    );

    expect(outcome).toEqual({
      kind: 'path-refused',
      code: 'F02',
      message: 'no route',
    });
  });

  it('does not take a hop’s word for a seal it could not have produced', () => {
    // An intermediary can write the sealed-response type byte; it cannot
    // produce bytes that OPEN. Only opening proves the destination spoke.
    const exchange = sealExchange(request, RECEIVER_PUBLIC);
    const forged = new Uint8Array([2, ...new Uint8Array(40).fill(0xab)]);

    const outcome = readExchangeOutcome(
      { accepted: false, code: 'F99', message: 'the destination said no' },
      forged,
      exchange.sharedSecret
    );

    expect(outcome.kind).toBe('path-refused');
  });

  it('does not mistake a sealed REQUEST for a sealed response', () => {
    const exchange = sealExchange(request, RECEIVER_PUBLIC);

    const outcome = readExchangeOutcome(
      { accepted: false, code: 'F01', message: 'bounced' },
      exchange.data,
      exchange.sharedSecret
    );

    expect(outcome.kind).toBe('path-refused');
  });
});

describe('envelopeHeader', () => {
  it('reads a header case-insensitively, and reports an absent one as undefined', () => {
    expect(envelopeHeader(answer, 'Content-Type')).toBe('application/json');
    expect(envelopeHeader(answer, 'x-relay')).toBe('ok');
    expect(envelopeHeader(answer, 'x-missing')).toBeUndefined();
  });

  it('returns the first of a duplicated header, preserving wire order', () => {
    const duplicated: EnvelopeResponse = {
      status: 200,
      headers: [
        ['set-cookie', 'a=1'],
        ['set-cookie', 'b=2'],
      ],
      body: new Uint8Array(0),
    };
    expect(envelopeHeader(duplicated, 'set-cookie')).toBe('a=1');
  });
});
