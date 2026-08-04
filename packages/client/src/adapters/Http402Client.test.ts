/**
 * Unit tests for the h402 payment-aware HTTP fetch flow (issue #50), on the
 * one envelope (#451).
 *
 * The terminator is {@link FakeTerminatingConnector} — the same fake
 * `publishEvent`'s tests use. It serves `GET /ilp/identity`, genuinely OPENS
 * what this adapter sealed, and seals its answer back with the secret it
 * recovered. That is deliberate: a hand-written FULFILL fixture would encode
 * this repo's own idea of the wire twice and agree with itself. Here the only
 * way to produce an answer the adapter can read is to have decoded the request
 * first, so the two directions check each other.
 *
 * The channel/claim plumbing is MOCKED via the injectable `resolveClaim` hook —
 * payment-claim VALIDATION lives only in the connector and is never
 * reimplemented here.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  Http402Client,
  parseX402Body,
  type H402FetchOptions,
} from './Http402Client.js';
import { decodeUtf8 } from '../utils/binary.js';
import { selectIlpTransport } from './selectIlpTransport.js';
import { FakeTerminatingConnector } from '../wire/fake-connector.test-support.js';
import { SealedResponseError } from '../wire/sealed-exchange.js';
import type { EnvelopeResponse } from '../wire/envelope.js';
import type { HttpIlpClient } from './HttpIlpClient.js';

// ─── helpers ────────────────────────────────────────────────────────────────

const TOON_ENDPOINT = 'https://apex.example/ilp';
const TOON_DESTINATION = 'g.toon.apex';

/** A 402 Response whose body offers a `toon-channel` entry. */
function challenge402(overrides: Record<string, unknown> = {}): Response {
  const body = {
    x402Version: 1,
    accepts: [
      { scheme: 'exact', network: 'eip155:8453', maxAmountRequired: '5000' },
      {
        scheme: 'toon-channel',
        network: 'evm:base:8453',
        destination: TOON_DESTINATION,
        amount: '1000',
        httpEndpoint: TOON_ENDPOINT,
        supportsUpgrade: false,
        ...overrides,
      },
    ],
  };
  return new Response(JSON.stringify(body), {
    status: 402,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * A `fetch` that answers `GET /ilp/identity` as `connector` and everything
 * else with the 402 challenge. Both requests genuinely go through the
 * adapter's injected `fetch`, so a test that forgets the identity round trip
 * fails rather than silently using a default key.
 */
function fetchWith(
  connector: FakeTerminatingConnector,
  challenge: () => Response = () => challenge402()
) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/ilp/identity')) return connector.fetch(input);
    return challenge();
  }) as unknown as typeof fetch;
}

/**
 * A fake HttpIlpClient that terminates every packet through `connector`:
 * it opens what was sealed and seals `connector.answer` back.
 */
function fakeIlpClient(connector: FakeTerminatingConnector) {
  const sendIlpPacketWithClaim = vi.fn(
    async (params: { data: string; executionCondition?: Uint8Array }) =>
      connector.fulfill(params.data)
  );
  const btpSend = vi.fn(async (params: { data: string }) =>
    connector.fulfill(params.data)
  );
  const disconnect = vi.fn(async () => {});
  const upgradeToBtp = vi.fn(async () => ({
    sendIlpPacketWithClaim: btpSend,
    disconnect,
  }));
  const client = {
    sendIlpPacketWithClaim,
    sendIlpPacket: vi.fn(),
    upgradeToBtp,
  } as unknown as HttpIlpClient;
  return { client, sendIlpPacketWithClaim, btpSend, upgradeToBtp };
}

/** Set the app's answer behind the fake connector. */
function answers(
  connector: FakeTerminatingConnector,
  status: number,
  headers: [string, string][] = [],
  body = ''
): void {
  connector.answer = {
    status,
    headers,
    body: new TextEncoder().encode(body),
  } satisfies EnvelopeResponse;
}

/**
 * The first element, with a named failure when there isn't one. A `!` here
 * would report "cannot read property of undefined" three lines later instead
 * of "nothing was sent".
 */
function first<T>(items: readonly T[], what: string): T {
  const item = items[0];
  if (item === undefined) throw new Error(`expected at least one ${what}`);
  return item;
}

// ─── tests ──────────────────────────────────────────────────────────────────

describe('Http402Client.fetch — 402 → pay → 200', () => {
  it('GET: pays over TOON and presents the sealed answer as a Response', async () => {
    const connector = new FakeTerminatingConnector();
    answers(
      connector,
      200,
      [['content-type', 'text/plain']],
      'hello paid world'
    );
    const { client: ilp, sendIlpPacketWithClaim } = fakeIlpClient(connector);
    const resolveClaim = vi.fn(async () => ({ blockchain: 'evm', sig: 'x' }));

    const h = new Http402Client({
      fetch: fetchWith(connector),
      resolveClaim,
      createIlpClient: () => ilp,
    });

    const res = await h.fetch('https://origin.example/resource?q=1');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain');
    expect(await res.text()).toBe('hello paid world');

    // Paid the price from the toon-channel entry, for its destination.
    expect(resolveClaim).toHaveBeenCalledWith(TOON_DESTINATION, 1000n);

    expect(sendIlpPacketWithClaim).toHaveBeenCalledOnce();
    const [params, claim] = first(
      sendIlpPacketWithClaim.mock.calls,
      'sent packet'
    );
    expect(params.destination).toBe(TOON_DESTINATION);
    expect(params.amount).toBe('1000');
    expect(claim).toEqual({ blockchain: 'evm', sig: 'x' });

    // What the connector actually decoded — asserted on the far side of the
    // seal, not on what the caller meant to send.
    expect(connector.opened).toHaveLength(1);
    const { request } = first(connector.opened, 'opened request');
    expect(request.method).toBe('GET');
    // Handler-relative (ADR 0025): no leading '/'.
    expect(request.target).toBe('resource?q=1');
    expect(request.body).toHaveLength(0);
  });

  it('carries a real, derived execution condition that the fulfilment satisfies', async () => {
    const connector = new FakeTerminatingConnector();
    const { client: ilp, sendIlpPacketWithClaim } = fakeIlpClient(connector);

    const h = new Http402Client({
      fetch: fetchWith(connector),
      resolveClaim: vi.fn(async () => ({})),
      createIlpClient: () => ilp,
    });
    await h.fetch('https://origin.example/resource');

    const [params] = first(sendIlpPacketWithClaim.mock.calls, 'sent packet');
    const condition = params.executionCondition;
    if (condition === undefined) throw new Error('no execution condition sent');
    expect(condition).toBeInstanceOf(Uint8Array);
    expect(condition).toHaveLength(32);
    // All-zero is refused outright by the connector (`condition_is_present`),
    // which is exactly the defect this path used to have.
    expect(condition.every((b) => b === 0)).toBe(false);
  });

  it('POST: carries method, target, headers and body inside the envelope', async () => {
    const connector = new FakeTerminatingConnector();
    answers(
      connector,
      201,
      [['content-type', 'application/json']],
      '{"ok":true}'
    );
    const { client: ilp } = fakeIlpClient(connector);

    const h = new Http402Client({
      fetch: fetchWith(connector),
      resolveClaim: vi.fn(async () => ({ claim: 1 })),
      createIlpClient: () => ilp,
    });

    const opts: H402FetchOptions = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"name":"alice"}',
    };
    const res = await h.fetch('https://origin.example/items', opts);

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });

    const { request } = first(connector.opened, 'opened request');
    expect(request.method).toBe('POST');
    // Handler-relative (ADR 0025): no leading '/'.
    expect(request.target).toBe('items');
    expect(request.headers).toEqual([['Content-Type', 'application/json']]);
    expect(decodeUtf8(request.body)).toBe('{"name":"alice"}');
  });

  it('synthesises neither Host nor Content-Length — the connector recomputes both', async () => {
    // The old codec added both. `connector-runtime/src/app_client.rs` skips
    // `host` and `content-length` by name when it builds the app request, and
    // the envelope already carries the body length, so emitting them was
    // writing bytes the far side discards.
    const connector = new FakeTerminatingConnector();
    const { client: ilp } = fakeIlpClient(connector);

    const h = new Http402Client({
      fetch: fetchWith(connector),
      resolveClaim: vi.fn(async () => ({})),
      createIlpClient: () => ilp,
    });
    await h.fetch('https://origin.example/items', {
      method: 'POST',
      body: 'abcdefgh',
    });

    const names = first(connector.opened, 'opened request').request.headers.map(
      ([n]) => n.toLowerCase()
    );
    expect(names).not.toContain('host');
    expect(names).not.toContain('content-length');
    // The length is still on the wire — as the envelope's own determinant.
    expect(first(connector.opened, 'opened request').request.body).toHaveLength(
      8
    );
  });

  it('preserves header order and duplicate response headers', async () => {
    const connector = new FakeTerminatingConnector();
    answers(
      connector,
      200,
      [
        ['set-cookie', 'a=1'],
        ['set-cookie', 'b=2'],
        ['x-trace', 'abc'],
      ],
      'ok'
    );
    const { client: ilp } = fakeIlpClient(connector);

    const h = new Http402Client({
      fetch: fetchWith(connector),
      resolveClaim: vi.fn(async () => ({})),
      createIlpClient: () => ilp,
    });
    const res = await h.fetch('https://origin.example/r');

    expect(res.headers.get('x-trace')).toBe('abc');
    expect(res.headers.getSetCookie()).toEqual(['a=1', 'b=2']);
  });

  it('an app error status is an ANSWER, not a failure — it is returned, not thrown', async () => {
    // ADR 0020: a non-2xx inside the response envelope rides home on a FULFILL
    // and value moved. `fetch` semantics say the same thing — a 404 is a
    // Response.
    const connector = new FakeTerminatingConnector();
    answers(connector, 404, [['content-type', 'text/plain']], 'nope');
    const { client: ilp } = fakeIlpClient(connector);

    const h = new Http402Client({
      fetch: fetchWith(connector),
      resolveClaim: vi.fn(async () => ({})),
      createIlpClient: () => ilp,
    });
    const res = await h.fetch('https://origin.example/missing');

    expect(res.status).toBe(404);
    expect(res.statusText).toBe(''); // no reason phrase on this wire
    expect(await res.text()).toBe('nope');
  });

  it('yields a null body for a 204', async () => {
    const connector = new FakeTerminatingConnector();
    answers(connector, 204);
    const { client: ilp } = fakeIlpClient(connector);

    const h = new Http402Client({
      fetch: fetchWith(connector),
      resolveClaim: vi.fn(async () => ({})),
      createIlpClient: () => ilp,
    });
    const res = await h.fetch('https://origin.example/none');

    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
  });

  it('seals to the identity of the connector the 402 named', async () => {
    const connector = new FakeTerminatingConnector();
    const fetchImpl = fetchWith(connector);
    const { client: ilp } = fakeIlpClient(connector);

    const h = new Http402Client({
      fetch: fetchImpl,
      resolveClaim: vi.fn(async () => ({})),
      createIlpClient: () => ilp,
    });
    await h.fetch('https://origin.example/r');

    // The identity was fetched from the endpoint's origin, and the packet
    // opened under that key — which is the only reason `opened` is non-empty.
    const urls = (
      fetchImpl as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls.map((c) => String(c[0]));
    expect(urls).toContain('https://apex.example/ilp/identity');
    expect(connector.opened).toHaveLength(1);
  });
});

describe('Http402Client.fetch — refusals', () => {
  it('reports a reject sealed at the termination as the DESTINATION refusing', async () => {
    const connector = new FakeTerminatingConnector();
    const sendIlpPacketWithClaim = vi.fn(async (params: { data: string }) =>
      connector.rejectSealed(params.data, 'F99', 'the app refused')
    );
    const ilp = {
      sendIlpPacketWithClaim,
      upgradeToBtp: vi.fn(),
    } as unknown as HttpIlpClient;

    const h = new Http402Client({
      fetch: fetchWith(connector),
      resolveClaim: vi.fn(async () => ({})),
      createIlpClient: () => ilp,
    });

    await expect(h.fetch('https://origin.example/r')).rejects.toThrow(
      /refused by the destination: F99 the app refused/
    );
  });

  it('reports a plaintext reject as a PATH refusal', async () => {
    const connector = new FakeTerminatingConnector();
    const sendIlpPacketWithClaim = vi.fn(async () => ({
      accepted: false as const,
      code: 'F02',
      message: 'no route to destination',
    }));
    const ilp = {
      sendIlpPacketWithClaim,
      upgradeToBtp: vi.fn(),
    } as unknown as HttpIlpClient;

    const h = new Http402Client({
      fetch: fetchWith(connector),
      resolveClaim: vi.fn(async () => ({})),
      createIlpClient: () => ilp,
    });

    await expect(h.fetch('https://origin.example/r')).rejects.toThrow(
      /refused by a connector on the path: F02 no route to destination/
    );
  });

  it('a malformed answer fails the same way it does anywhere else in this package', async () => {
    // The two codecs used to disagree about this: `Http402Client` threw
    // `ConnectorError` on a bad status line while `fulfill-http.ts` returned
    // `{isHttp:false}` for the same bytes. One reader now, one failure.
    const connector = new FakeTerminatingConnector();
    const sendIlpPacketWithClaim = vi.fn(async () => ({
      accepted: true as const,
      data: 'AAAA', // not a sealed response
    }));
    const ilp = {
      sendIlpPacketWithClaim,
      upgradeToBtp: vi.fn(),
    } as unknown as HttpIlpClient;

    const h = new Http402Client({
      fetch: fetchWith(connector),
      resolveClaim: vi.fn(async () => ({})),
      createIlpClient: () => ilp,
    });

    await expect(h.fetch('https://origin.example/r')).rejects.toBeInstanceOf(
      SealedResponseError
    );
  });
});

describe('Http402Client.fetch — pass-through / fallback', () => {
  it('passes non-402 responses straight through', async () => {
    const ok = new Response('fine', { status: 200 });
    const fetchImpl = vi.fn(async () => ok);
    const h = new Http402Client({
      fetch: fetchImpl as unknown as typeof fetch,
      resolveClaim: vi.fn(),
      createIlpClient: vi.fn(),
    });
    const res = await h.fetch('https://origin.example/free');
    expect(res).toBe(ok);
  });

  it('AC5: returns the original 402 unchanged when no toon-channel entry is offered', async () => {
    // Only a vanilla x402 `exact` entry — no toon-channel.
    const body = {
      x402Version: 1,
      accepts: [
        { scheme: 'exact', network: 'eip155:8453', maxAmountRequired: '5000' },
      ],
    };
    const original = new Response(JSON.stringify(body), { status: 402 });
    const fetchImpl = vi.fn(async () => original);
    const createIlpClient = vi.fn();

    const h = new Http402Client({
      fetch: fetchImpl as unknown as typeof fetch,
      resolveClaim: vi.fn(),
      createIlpClient,
    });

    const res = await h.fetch('https://origin.example/paid');
    expect(res.status).toBe(402);
    // Original body still readable → we returned the untouched Response.
    expect(await res.json()).toEqual(body);
    // Never attempted to pay.
    expect(createIlpClient).not.toHaveBeenCalled();
  });

  it('AC5: surfaces the vanilla 402 when no claim resolver is configured', async () => {
    const fetchImpl = vi.fn(async () => challenge402());
    const createIlpClient = vi.fn();
    const h = new Http402Client({
      fetch: fetchImpl as unknown as typeof fetch,
      createIlpClient,
    });
    const res = await h.fetch('https://origin.example/paid');
    expect(res.status).toBe(402);
    expect(createIlpClient).not.toHaveBeenCalled();
  });
});

describe('Http402Client.fetch — AC4 transport selection / upgrade', () => {
  it('one-shot consumer stays on stateless HTTP (no upgrade)', async () => {
    const connector = new FakeTerminatingConnector();
    answers(connector, 200, [], 'streamed');
    const {
      client: ilp,
      sendIlpPacketWithClaim,
      upgradeToBtp,
    } = fakeIlpClient(connector);
    const h = new Http402Client({
      fetch: fetchWith(connector, () =>
        challenge402({ supportsUpgrade: true })
      ),
      resolveClaim: vi.fn(async () => ({})),
      createIlpClient: () => ilp,
    });
    const res = await h.fetch('https://origin.example/big');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('streamed');
    expect(sendIlpPacketWithClaim).toHaveBeenCalledOnce();
    expect(upgradeToBtp).not.toHaveBeenCalled();
  });

  it('needsDuplex + supportsUpgrade drives the http-upgradable BTP upgrade call path', async () => {
    const connector = new FakeTerminatingConnector();
    answers(connector, 200, [], 'streamed-over-btp');
    const {
      client: ilp,
      sendIlpPacketWithClaim,
      btpSend,
      upgradeToBtp,
    } = fakeIlpClient(connector);
    const h = new Http402Client({
      fetch: fetchWith(connector, () =>
        challenge402({ supportsUpgrade: true })
      ),
      resolveClaim: vi.fn(async () => ({})),
      createIlpClient: () => ilp,
      needsDuplex: true,
    });
    const res = await h.fetch('https://origin.example/big');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('streamed-over-btp');
    // selectIlpTransport(duplex, supportsUpgrade) → http-upgradable → upgradeToBtp.
    expect(upgradeToBtp).toHaveBeenCalledOnce();
    // The one-shot HTTP client's send is NOT used; the BTP session's is.
    expect(sendIlpPacketWithClaim).not.toHaveBeenCalled();
    // The BTP leg carries the same sealed packet and the same real condition —
    // the zero-fill defect was in BOTH transports.
    const [btpParams] = first(btpSend.mock.calls, 'BTP packet');
    expect(
      (btpParams as { executionCondition?: Uint8Array }).executionCondition
    ).toHaveLength(32);
  });

  it('selectIlpTransport: a duplex consumer over an upgradable httpEndpoint chooses http-upgradable', () => {
    const choice = selectIlpTransport(
      { httpEndpoint: TOON_ENDPOINT, supportsUpgrade: true },
      { needsDuplex: true }
    );
    expect(choice).toEqual({
      kind: 'http-upgradable',
      httpEndpoint: TOON_ENDPOINT,
    });
  });
});

describe('x402 challenge parsing', () => {
  it('parseX402Body reads field aliases defensively', () => {
    const parsed = parseX402Body({
      accepts: [
        {
          scheme: 'toon-channel',
          payTo: 'g.toon.alt',
          price: 42,
          ilpEndpoint: 'https://alt/ilp',
          upgradable: true,
        },
      ],
    });
    expect(parsed.toonChannel).toEqual({
      scheme: 'toon-channel',
      destination: 'g.toon.alt',
      amount: 42n,
      httpEndpoint: 'https://alt/ilp',
      supportsUpgrade: true,
    });
  });

  it('parseX402Body ignores a toon-channel entry missing destination/endpoint', () => {
    const parsed = parseX402Body({
      accepts: [{ scheme: 'toon-channel', amount: '5' }],
    });
    expect(parsed.toonChannel).toBeUndefined();
  });

  it('preserves the extra bag, including session_lease_ttl_ms and unknown keys (issue #506)', () => {
    const parsed = parseX402Body({
      accepts: [
        {
          scheme: 'toon-channel',
          payTo: 'g.toon.alt',
          amount: '42',
          httpEndpoint: 'https://alt/ilp',
          extra: {
            ilpAddress: 'g.toon.alt',
            session_lease_ttl_ms: 120_000,
            some_future_field: 'unknown-but-preserved',
          },
        },
      ],
    });
    expect(parsed.toonChannel?.extra).toEqual({
      ilpAddress: 'g.toon.alt',
      session_lease_ttl_ms: 120_000,
      some_future_field: 'unknown-but-preserved',
    });
  });

  it('yields extra: undefined — not a default, not a throw — when the entry has no extra bag', () => {
    const parsed = parseX402Body({
      accepts: [
        {
          scheme: 'toon-channel',
          payTo: 'g.toon.alt',
          amount: '42',
          httpEndpoint: 'https://alt/ilp',
        },
      ],
    });
    expect(parsed.toonChannel?.extra).toBeUndefined();
  });
});
