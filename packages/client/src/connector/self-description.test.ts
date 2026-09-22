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
  defaultDestinationFor,
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
   * The law, and the figures the deployed store node answers with.
   *
   * The rule is `base + rate * ceil(bytes / 1024)` — the connector's own
   * `Price::charge` (`connector-domain/src/price.rs`, `bytes.div_ceil(1024)`,
   * connector ADR 0065), which counts whole kibibytes plus one for a remainder
   * and none at all for an empty payload. The boundary rows are the point: 1024
   * bytes is ONE kibibyte, 2048 is two, and the next byte after each starts the
   * next one.
   *
   * The right-hand column is measured, not derived. The store node at
   * `1000 + 10/KiB` answers an unpaid PREPARE with an x402 greeting quoting
   * `price.charge(prepare.data.len())` for the packet it was handed — the same
   * figure its claim gate then collects (`connector-client-edge/src/lib.rs`
   * computes one `charge` and greets, bounds and gates on it). Posting a PREPARE
   * whose `data` is exactly n bytes reads the rule straight off the deployment:
   *
   *     bytes  0     1     1023  1024  1025  2047  2048  2049  5161
   *     quoted 1000  1010  1010  1010  1020  1020  1020  1030  1060
   *
   * This suite previously asserted `floor(n / 1024) + 1` and called it measured.
   * It was a fit: every size anyone had actually sent was a non-multiple of 1024,
   * where the two formulas agree, and at a multiple the client overpaid by one
   * rate — which a connector accepts in silence, so nothing ever reported it
   * (toon-client#629).
   */
  it.each([
    [0, 1000n],
    [1, 1010n],
    [169, 1010n],
    [1023, 1010n],
    [1024, 1010n],
    [1025, 1020n],
    [1185, 1020n],
    [2047, 1020n],
    [2048, 1020n],
    [2049, 1030n],
    [2209, 1030n],
    [3161, 1040n],
    [5161, 1060n],
  ])('charges %i sealed bytes at %s', (bytes, expected) => {
    expect(chargeFor(metered, bytes)).toBe(expected);
  });

  it('charges the base alone for a nonsensical size, as it does for an empty payload', () => {
    expect(chargeFor(metered, -5)).toBe(1000n);
  });

  it('agrees with the connector formula across the first few boundaries', () => {
    // The rule, stated once and checked against itself: no table can be a fit
    // for a formula it is generated from.
    for (let bytes = 0; bytes <= 4096; bytes++) {
      expect(chargeFor(metered, bytes)).toBe(1000n + 10n * BigInt(Math.ceil(bytes / 1024)));
    }
  });
});

describe('defaultDestinationFor', () => {
  // A client is configured with a URL. The route it should address is a fact the
  // node already publishes, so nothing should have to be copied by hand.
  it('takes the primary address a node publishes for itself', () => {
    expect(defaultDestinationFor(parseSelfDescription(STORE_BODY))).toBe('g.toon.store');
  });

  it('skips an address the node serves but does not price', () => {
    // `g.toon.unpriced` is first, but nothing could pay for it.
    const desc = parseSelfDescription({
      ...STORE_BODY,
      ilpAddresses: ['g.toon.unpriced', 'g.toon.store'],
    });
    expect(defaultDestinationFor(desc)).toBe('g.toon.store');
  });

  it('falls back to the first address when the node prices none of them', () => {
    // Better to be refused with the route's terms than to refuse to form a packet.
    const desc = parseSelfDescription({ ...STORE_BODY, routes: [] });
    expect(defaultDestinationFor(desc)).toBe('g.toon.store');
  });

  it('is undefined only for a node that claims no address at all', () => {
    const desc = parseSelfDescription({ ...STORE_BODY, ilpAddresses: [] });
    expect(defaultDestinationFor(desc)).toBeUndefined();
  });

  it('picks the relay, not its ephemeral lane, from the deployed relay document', () => {
    const desc = parseSelfDescription({
      ...STORE_BODY,
      ilpAddresses: ['g.toon.relay', 'g.toon.relay.ephemeral'],
      routes: [
        { prefix: 'g.toon.relay', price: '1' },
        { prefix: 'g.toon.relay.ephemeral', price: '0' },
      ],
    });
    expect(defaultDestinationFor(desc)).toBe('g.toon.relay');
  });
});
