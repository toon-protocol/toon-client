/**
 * Unit tests for the h402 payment-aware HTTP fetch flow (issue #50).
 *
 * Uses a STUB TERMINATOR: a fake `fetch` that returns a 402 with a
 * `toon-channel` accepts entry on the first call, and a fake `HttpIlpClient`
 * whose `sendIlpPacketWithClaim` returns an ILP FULFILL whose `data` is the
 * base64 of a serialized HTTP/1.1 response. The channel/claim plumbing is
 * MOCKED via the injectable `resolveClaim` hook — payment-claim VALIDATION lives
 * only in the connector and is never reimplemented here.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  Http402Client,
  serializeHttpRequest,
  parseHttpResponse,
  parseX402Body,
  type H402FetchOptions,
} from './Http402Client.js';
import { toBase64, fromBase64, encodeUtf8, decodeUtf8 } from '../utils/binary.js';
import { selectIlpTransport } from './selectIlpTransport.js';

// ─── helpers ────────────────────────────────────────────────────────────────

const TOON_ENDPOINT = 'https://apex.example/ilp';
const TOON_DESTINATION = 'g.toon.apex';

/** A 402 Response whose body offers a `toon-channel` entry. */
function challenge402(
  overrides: Record<string, unknown> = {}
): Response {
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

/** Build an ILP FULFILL result carrying a serialized HTTP response in `data`. */
function fulfillWithHttpResponse(opts: {
  status: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string;
}) {
  const head =
    `HTTP/1.1 ${opts.status} ${opts.statusText ?? 'OK'}\r\n` +
    Object.entries(opts.headers ?? {})
      .map(([k, v]) => `${k}: ${v}`)
      .join('\r\n') +
    (opts.headers && Object.keys(opts.headers).length ? '\r\n' : '') +
    '\r\n';
  const bytes = encodeUtf8(head + (opts.body ?? ''));
  return { accepted: true as const, data: toBase64(bytes) };
}

/** A fake HttpIlpClient capturing the params + claim it was sent. */
function fakeIlpClient(result: { accepted: boolean; data?: string; code?: string; message?: string }) {
  const sendIlpPacketWithClaim = vi.fn(async () => result);
  const sendIlpPacket = vi.fn(async () => result);
  const upgradeToBtp = vi.fn(async () => ({
    sendIlpPacketWithClaim: vi.fn(async () => result),
    disconnect: vi.fn(async () => {}),
  }));
  // Cast: structural stub of the bits Http402Client touches.
  const client = {
    sendIlpPacketWithClaim,
    sendIlpPacket,
    upgradeToBtp,
  } as unknown as import('./HttpIlpClient.js').HttpIlpClient;
  return { client, sendIlpPacketWithClaim, upgradeToBtp };
}

// ─── tests ──────────────────────────────────────────────────────────────────

describe('Http402Client.fetch — 402 → pay → 200', () => {
  it('GET: pays over TOON and reconstructs the 200 Response', async () => {
    const fetchImpl = vi.fn(async () => challenge402());
    const { client: ilp, sendIlpPacketWithClaim } = fakeIlpClient(
      fulfillWithHttpResponse({
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
        body: 'hello paid world',
      })
    );
    const resolveClaim = vi.fn(async () => ({ blockchain: 'evm', sig: 'x' }));

    const h = new Http402Client({
      fetch: fetchImpl as unknown as typeof fetch,
      resolveClaim,
      createIlpClient: () => ilp,
    });

    const res = await h.fetch('https://origin.example/resource?q=1');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain');
    expect(await res.text()).toBe('hello paid world');

    // Paid the price from the toon-channel entry, for its destination.
    expect(resolveClaim).toHaveBeenCalledWith(TOON_DESTINATION, 1000n);

    // The PREPARE carried the serialized HTTP request + the claim.
    expect(sendIlpPacketWithClaim).toHaveBeenCalledOnce();
    const [params, claim] = sendIlpPacketWithClaim.mock.calls[0]!;
    expect(params.destination).toBe(TOON_DESTINATION);
    expect(params.amount).toBe('1000');
    expect(claim).toEqual({ blockchain: 'evm', sig: 'x' });

    const reqText = decodeUtf8(fromBase64(params.data));
    expect(reqText.startsWith('GET /resource?q=1 HTTP/1.1\r\n')).toBe(true);
    expect(reqText).toContain('Host: origin.example');
  });

  it('POST round-trip: serializes the body into the HTTP-in-ILP packet', async () => {
    const fetchImpl = vi.fn(async () => challenge402());
    const { client: ilp, sendIlpPacketWithClaim } = fakeIlpClient(
      fulfillWithHttpResponse({
        status: 201,
        statusText: 'Created',
        headers: { 'Content-Type': 'application/json' },
        body: '{"ok":true}',
      })
    );
    const resolveClaim = vi.fn(async () => ({ claim: 1 }));

    const h = new Http402Client({
      fetch: fetchImpl as unknown as typeof fetch,
      resolveClaim,
      createIlpClient: () => ilp,
    });

    const opts: H402FetchOptions = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"name":"alice"}',
    };
    const res = await h.fetch('https://origin.example/items', opts);

    expect(res.status).toBe(201);
    expect(res.statusText).toBe('Created');
    expect(await res.json()).toEqual({ ok: true });

    const [params] = sendIlpPacketWithClaim.mock.calls[0]!;
    const reqText = decodeUtf8(fromBase64(params.data));
    expect(reqText.startsWith('POST /items HTTP/1.1\r\n')).toBe(true);
    expect(reqText).toContain('Content-Type: application/json');
    expect(reqText).toContain('Content-Length: 16');
    expect(reqText.endsWith('\r\n\r\n{"name":"alice"}')).toBe(true);
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
      accepts: [{ scheme: 'exact', network: 'eip155:8453', maxAmountRequired: '5000' }],
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
    const fetchImpl = vi.fn(async () => challenge402({ supportsUpgrade: true }));
    const { client: ilp, sendIlpPacketWithClaim, upgradeToBtp } = fakeIlpClient(
      fulfillWithHttpResponse({ status: 200, body: 'streamed' })
    );
    const h = new Http402Client({
      fetch: fetchImpl as unknown as typeof fetch,
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
    const fetchImpl = vi.fn(async () => challenge402({ supportsUpgrade: true }));
    const { client: ilp, sendIlpPacketWithClaim, upgradeToBtp } = fakeIlpClient(
      fulfillWithHttpResponse({ status: 200, body: 'streamed-over-btp' })
    );
    const h = new Http402Client({
      fetch: fetchImpl as unknown as typeof fetch,
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
  });

  it('selectIlpTransport: a duplex consumer over an upgradable httpEndpoint chooses http-upgradable', () => {
    const choice = selectIlpTransport(
      { httpEndpoint: TOON_ENDPOINT, supportsUpgrade: true },
      { needsDuplex: true }
    );
    expect(choice).toEqual({ kind: 'http-upgradable', httpEndpoint: TOON_ENDPOINT });
  });
});

describe('h402 framing helpers', () => {
  it('serializeHttpRequest → parseHttpResponse round-trips a typical response', () => {
    // Sanity-check the framing pair end-to-end on a response.
    const reqBytes = serializeHttpRequest({
      method: 'GET',
      url: 'https://x.example/a/b?c=d',
    });
    const reqText = decodeUtf8(reqBytes);
    expect(reqText).toBe('GET /a/b?c=d HTTP/1.1\r\nHost: x.example\r\n\r\n');

    const respBytes = encodeUtf8(
      'HTTP/1.1 404 Not Found\r\nX-Trace: abc\r\n\r\nnope'
    );
    const resp = parseHttpResponse(respBytes);
    expect(resp.status).toBe(404);
    expect(resp.statusText).toBe('Not Found');
    expect(resp.headers.get('x-trace')).toBe('abc');
  });

  it('parseHttpResponse yields a null body for 204', () => {
    const resp = parseHttpResponse(encodeUtf8('HTTP/1.1 204 No Content\r\n\r\n'));
    expect(resp.status).toBe(204);
    expect(resp.body).toBeNull();
  });

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
});
