/**
 * The route half of `GET /ilp`: what a route costs, and what one packet on it
 * therefore costs.
 *
 * The per-KiB rate has its own suite because dropping it was silent. The parser
 * kept `{ prefix, price }` and discarded `pricePerKib`, so a metered route was
 * quoted at its base price, the claim under-paid, and the deployed store node
 * refused every send `F03 — advances value by 1000, less than this route's
 * price of 1010`. Nothing local disagreed; the field simply was not read.
 */
import { describe, it, expect } from 'vitest';
import {
  chargeFor,
  parseSelfDescription,
  routeFor,
  routePriceFor,
} from './self-description.js';

/** The deployed store node's own routes, as it publishes them. */
const STORE_BODY = {
  ilpAddresses: ['g.toon.store', 'g.toon.relay.store'],
  peerCarriages: ['btp'],
  settlements: [],
  routes: [
    { prefix: 'g.toon.relay.store', price: '1000', pricePerKib: '10' },
    { prefix: 'g.toon.store', price: '1000', pricePerKib: '10' },
  ],
  supportedVersions: [1],
  defaultVersion: 1,
};

describe('parseSelfDescription — route pricing', () => {
  it('keeps the per-KiB rate a metered route publishes', () => {
    const desc = parseSelfDescription(STORE_BODY);
    expect(routeFor(desc, 'g.toon.store')).toEqual({
      prefix: 'g.toon.store',
      price: 1000n,
      pricePerKib: 10n,
    });
  });

  it('omits the rate on a flat-priced route rather than defaulting it to zero', () => {
    const desc = parseSelfDescription({
      ...STORE_BODY,
      routes: [{ prefix: 'g.toon.relay', price: '1' }],
    });
    expect(routeFor(desc, 'g.toon.relay')).not.toHaveProperty('pricePerKib');
  });

  it('accepts the rate as a JSON number as well as a decimal string', () => {
    const desc = parseSelfDescription({
      ...STORE_BODY,
      routes: [{ prefix: 'g.a', price: 1000, pricePerKib: 10 }],
    });
    expect(routeFor(desc, 'g.a')?.pricePerKib).toBe(10n);
  });

  it('drops an unreadable rate but keeps the route — a price list survives one bad key', () => {
    const desc = parseSelfDescription({
      ...STORE_BODY,
      routes: [{ prefix: 'g.a', price: '1000', pricePerKib: 'free-ish' }],
    });
    expect(routeFor(desc, 'g.a')?.price).toBe(1000n);
    expect(routeFor(desc, 'g.a')).not.toHaveProperty('pricePerKib');
  });

  it('still matches on the longest governing prefix', () => {
    const desc = parseSelfDescription(STORE_BODY);
    expect(routeFor(desc, 'g.toon.relay.store.deep')?.prefix).toBe('g.toon.relay.store');
    // A label boundary, never a substring: `g.toon.storeroom` is not this route.
    expect(routeFor(desc, 'g.toon.storeroom')).toBeUndefined();
  });

  it('routePriceFor still answers the base price alone', () => {
    expect(routePriceFor(parseSelfDescription(STORE_BODY), 'g.toon.store')).toBe(1000n);
  });
});

describe('chargeFor', () => {
  const metered = { price: 1000n, pricePerKib: 10n };

  it('leaves a flat-priced route untouched at any size', () => {
    expect(chargeFor({ price: 1000n }, 0)).toBe(1000n);
    expect(chargeFor({ price: 1000n }, 10_000)).toBe(1000n);
  });

  it('treats an explicit zero rate as flat', () => {
    expect(chargeFor({ price: 1000n, pricePerKib: 0n }, 10_000)).toBe(1000n);
  });

  /**
   * The figures on the right are what the deployed store node actually charged
   * for a sealed payload of that size, recovered by deliberately underpaying
   * and reading the price back off its `F03`. The boundary rows are the point:
   * the count is kibibytes STARTED, `floor(n / 1024) + 1`, so 1024 bytes is
   * already two units. `ceil` would make it one and under-pay by the rate.
   */
  it.each([
    [0, 1010n],
    [169, 1010n],
    [1023, 1010n],
    [1024, 1020n],
    [1185, 1020n],
    [2209, 1030n],
    [3161, 1040n],
    [5161, 1060n],
  ])('charges %i sealed bytes at %s', (bytes, expected) => {
    expect(chargeFor(metered, bytes)).toBe(expected);
  });

  it('never charges less than the base price for a nonsensical size', () => {
    expect(chargeFor(metered, -5)).toBe(1010n);
  });
});
