/**
 * The x402 terms the SHIPPED connector actually emits, pinned.
 *
 * `Http402Client.test.ts` next door covers the parser's defensive aliases
 * against hypothetical shapes. This file covers exactly one shape — the one
 * produced by `payment_required()` in
 * `crates/connector-client-edge/src/lib.rs`, reproduced verbatim in
 * `docs/protocol/client-edge-spec.md` §1.4 — so that a change to THAT function
 * fails here, in a test naming the source it was copied from, rather than in
 * production.
 *
 * The fixture is byte-for-byte the spec's example: `X402PaymentRequired` /
 * `X402PaymentOption` / `X402ChannelExtra` serialize in declaration order, and
 * `amount`, `extra.price` are strings while `maxTimeoutSeconds` is a number.
 */

import { describe, it, expect } from 'vitest';
import { parseX402Body, parseX402Challenge } from './Http402Client.js';

/**
 * `payment_required("g.example.app", 100)`. Do not "tidy" this: it is a copy,
 * not a construction.
 */
const CONNECTOR_402_BODY = {
  x402Version: 2,
  resource: { url: 'g.example.app' },
  accepts: [
    {
      scheme: 'toon-channel',
      network: 'g.example.app',
      amount: '100',
      payTo: 'g.example.app',
      maxTimeoutSeconds: 60,
      httpEndpoint: '/ilp',
      extra: {
        ilpAddress: 'g.example.app',
        endpoint: '/ilp',
        price: '100',
      },
    },
  ],
} as const;

describe("the connector's own 402 terms", () => {
  it('parses into a usable toon-channel offer', () => {
    const parsed = parseX402Body(
      CONNECTOR_402_BODY,
      'https://apex.example/some/resource'
    );

    expect(parsed.x402Version).toBe(2);
    expect(parsed.toonChannel).toEqual({
      scheme: 'toon-channel',
      network: 'g.example.app',
      destination: 'g.example.app',
      amount: 100n,
      httpEndpoint: 'https://apex.example/ilp',
      supportsUpgrade: false,
    });
  });

  it('reads the destination from extra.ilpAddress, not from payTo', () => {
    // The connector sets `payTo` to the destination too, which is why reading
    // `payTo` looks correct today. Make them differ: `extra.ilpAddress` is the
    // documented carrier of the ILP address and must win.
    const body = {
      ...CONNECTOR_402_BODY,
      accepts: [
        {
          ...CONNECTOR_402_BODY.accepts[0],
          payTo: '0xNotAnIlpAddressAtAll',
          extra: { ...CONNECTOR_402_BODY.accepts[0].extra },
        },
      ],
    };

    expect(
      parseX402Body(body, 'https://apex.example/r')?.toonChannel
    ).toMatchObject({ destination: 'g.example.app' });
  });

  it('reads the price from extra.price', () => {
    const body = {
      ...CONNECTOR_402_BODY,
      accepts: [
        {
          ...CONNECTOR_402_BODY.accepts[0],
          amount: undefined,
          extra: { ...CONNECTOR_402_BODY.accepts[0].extra, price: '4200' },
        },
      ],
    };

    expect(
      parseX402Body(body, 'https://apex.example/r').toonChannel?.amount
    ).toBe(4200n);
  });

  it('resolves the RELATIVE httpEndpoint the connector emits against the resource URL', () => {
    // `httpEndpoint` is the literal string "/ilp" — unusable as a fetch target
    // on its own. Without a base it is passed through unchanged (old behaviour).
    expect(parseX402Body(CONNECTOR_402_BODY).toonChannel?.httpEndpoint).toBe(
      '/ilp'
    );
    expect(
      parseX402Body(CONNECTOR_402_BODY, 'https://apex.example:8080/deep/path')
        .toonChannel?.httpEndpoint
    ).toBe('https://apex.example:8080/ilp');
  });

  it('leaves an absolute httpEndpoint alone', () => {
    const body = {
      ...CONNECTOR_402_BODY,
      accepts: [
        {
          ...CONNECTOR_402_BODY.accepts[0],
          httpEndpoint: 'https://other.example/ilp',
        },
      ],
    };
    expect(
      parseX402Body(body, 'https://apex.example/r').toonChannel?.httpEndpoint
    ).toBe('https://other.example/ilp');
  });

  it('parses the same body off a real 402 Response, using Response.url as the base', async () => {
    const response = new Response(JSON.stringify(CONNECTOR_402_BODY), {
      status: 402,
      headers: { 'content-type': 'application/json' },
    });
    // `Response.url` is empty on a synthesized Response, so redefine it — this
    // is the value `fetch` would have populated.
    Object.defineProperty(response, 'url', {
      value: 'https://apex.example/paid/resource',
    });

    const parsed = await parseX402Challenge(response);
    expect(parsed.toonChannel?.httpEndpoint).toBe('https://apex.example/ilp');
    expect(parsed.toonChannel?.destination).toBe('g.example.app');
    expect(parsed.toonChannel?.amount).toBe(100n);
  });

  it('does not offer a toon-channel entry for a scheme it does not understand', () => {
    const body = {
      x402Version: 2,
      resource: { url: 'g.example.app' },
      accepts: [{ ...CONNECTOR_402_BODY.accepts[0], scheme: 'exact' }],
    };
    expect(
      parseX402Body(body, 'https://apex.example/r').toonChannel
    ).toBeUndefined();
  });
});
