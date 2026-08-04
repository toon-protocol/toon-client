/**
 * ToonClient.getLastX402Terms (issue #506): the client-level surface for the
 * x402 `accepts[0].extra` bag — starting with `session_lease_ttl_ms`
 * (connector#722) — captured from the most recent `h402Fetch` 402 probe, so
 * a caller (buzz#84) can read the negotiated terms without re-issuing a
 * probe by hand.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ToonClient } from './ToonClient.js';

function baseConfig() {
  return {
    secretKey: new Uint8Array(32).fill(7),
    connectorUrl: 'http://localhost:9999',
    destinationAddress: 'g.proxy',
    ilpInfo: {
      pubkey: '0'.repeat(64),
      ilpAddress: 'g.toon.test',
    },
    toonEncoder: (_e: unknown) => new Uint8Array([1, 2, 3, 4]),
    toonDecoder: (_t: string) => ({}) as never,
  } as unknown as ConstructorParameters<typeof ToonClient>[0];
}

/** A started client with no channel manager — the h402 pay-over-TOON leg
 * never engages, so every 402 probe falls back to the vanilla challenge
 * (AC5 in Http402Client). That is enough to exercise the capture wiring
 * without standing up a signer/channel-manager fixture. */
function startedClient(): ToonClient {
  const client = new ToonClient(baseConfig());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (client as any).state = {
    bootstrapService: {},
    discoveryTracker: {},
    runtimeClient: {},
    peersDiscovered: 0,
  };
  return client;
}

function challengeBody(extra?: Record<string, unknown>) {
  return {
    x402Version: 2,
    accepts: [
      {
        scheme: 'toon-channel',
        destination: 'g.toon.apex',
        amount: '1000',
        httpEndpoint: 'https://apex.example/ilp',
        ...(extra !== undefined ? { extra } : {}),
      },
    ],
  };
}

let realFetch: typeof fetch;

beforeEach(() => {
  realFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('ToonClient.getLastX402Terms', () => {
  it('is undefined before any h402Fetch call', () => {
    const client = startedClient();
    expect(client.getLastX402Terms()).toBeUndefined();
  });

  it('captures the extra bag (including session_lease_ttl_ms) from an unpaid 402 probe', async () => {
    const client = startedClient();
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify(
          challengeBody({
            ilpAddress: 'g.toon.apex',
            session_lease_ttl_ms: 120_000,
            some_future_field: 'unknown-but-preserved',
          })
        ),
        { status: 402, headers: { 'content-type': 'application/json' } }
      )) as unknown as typeof fetch;

    const res = await client.h402Fetch('https://origin.example/resource');

    // No channel manager configured: the vanilla 402 is returned unchanged.
    expect(res.status).toBe(402);

    const terms = client.getLastX402Terms();
    expect(terms?.destination).toBe('g.toon.apex');
    expect(terms?.extra?.session_lease_ttl_ms).toBe(120_000);
    expect(terms?.extra?.some_future_field).toBe('unknown-but-preserved');
  });

  it('yields extra: undefined for a connector predating #722, not a default', async () => {
    const client = startedClient();
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(challengeBody()), {
        status: 402,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;

    await client.h402Fetch('https://origin.example/resource');

    expect(client.getLastX402Terms()?.extra).toBeUndefined();
  });

  it('a non-402 response leaves the last terms untouched', async () => {
    const client = startedClient();
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify(challengeBody({ session_lease_ttl_ms: 120_000 })),
        { status: 402, headers: { 'content-type': 'application/json' } }
      )) as unknown as typeof fetch;
    await client.h402Fetch('https://origin.example/resource');
    expect(client.getLastX402Terms()?.extra?.session_lease_ttl_ms).toBe(
      120_000
    );

    globalThis.fetch = (async () =>
      new Response('ok', { status: 200 })) as unknown as typeof fetch;
    const res = await client.h402Fetch('https://origin.example/other');

    expect(res.status).toBe(200);
    expect(client.getLastX402Terms()?.extra?.session_lease_ttl_ms).toBe(
      120_000
    );
  });
});
