import { describe, it, expect } from 'vitest';
import {
  FULFILLMENT_LENGTH,
  assertValidFulfillment,
  fulfillmentMatches,
} from './fulfillment.js';
import { deriveFulfillment } from '../wire/giftwrap.js';

/** The fulfilment a sealed request's shared secret derives (ADR 0019). */
const fulfilmentOf = (seed: number): Uint8Array =>
  deriveFulfillment(new Uint8Array(32).fill(seed));

describe('fulfillmentMatches — the sender’s end-to-end check (ADR 0069)', () => {
  it('accepts the exact bytes the packet’s own secret derives', () => {
    const expected = fulfilmentOf(0x11);
    expect(fulfillmentMatches(deriveFulfillment(new Uint8Array(32).fill(0x11)), expected))
      .toBe(true);
  });

  it('rejects another secret’s fulfilment', () => {
    expect(fulfillmentMatches(fulfilmentOf(0x22), fulfilmentOf(0x11))).toBe(false);
  });

  it('fails closed on an absent, short or long fulfilment', () => {
    const expected = fulfilmentOf(0x11);
    expect(fulfillmentMatches(undefined, expected)).toBe(false);
    expect(fulfillmentMatches(expected.slice(0, 31), expected)).toBe(false);
    const long = new Uint8Array(33);
    long.set(expected);
    expect(fulfillmentMatches(long, expected)).toBe(false);
  });

  it('fails closed on an all-zero fulfilment', () => {
    // The shape a hop that answers without opening the wrap would produce.
    expect(fulfillmentMatches(new Uint8Array(32), fulfilmentOf(0x11))).toBe(false);
  });

  it('fails closed when the EXPECTED value is itself malformed', () => {
    // A caller that got its own side wrong must not accidentally accept
    // everything; refusing is the safe direction, and the transports refuse
    // to send at all (see `assertValidFulfillment`).
    expect(fulfillmentMatches(fulfilmentOf(0x11), new Uint8Array(31))).toBe(false);
  });
});

describe('assertValidFulfillment', () => {
  it('accepts exactly 32 bytes', () => {
    expect(() => assertValidFulfillment(fulfilmentOf(0x11))).not.toThrow();
    expect(FULFILLMENT_LENGTH).toBe(32);
  });

  it.each([0, 31, 33, 64])('rejects %i bytes', (len) => {
    expect(() => assertValidFulfillment(new Uint8Array(len).fill(7))).toThrow(
      /32 bytes/
    );
  });
});
