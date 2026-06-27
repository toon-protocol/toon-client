import { describe, it, expect, vi } from 'vitest';
import {
  ControlClient,
  ControlApiError,
  DaemonUnreachableError,
} from './control-client.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('ControlClient', () => {
  it('GETs status from the configured base url', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ready: true, bootstrapping: false }));
    const client = new ControlClient({
      baseUrl: 'http://127.0.0.1:8787/',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const status = await client.status();
    expect(status.ready).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:8787/status');
    expect(init.method).toBe('GET');
  });

  it('POSTs publish with a JSON body and content-type', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ eventId: 'e1', channelId: 'c1', nonce: 3 })
      );
    const client = new ControlClient({
      baseUrl: 'http://127.0.0.1:8787',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await client.publish({ event: { id: 'e1' } as any });
    expect(res.nonce).toBe(3);
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ event: { id: 'e1' } });
  });

  it('builds the events query string', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ events: [], cursor: 0, hasMore: false })
      );
    const client = new ControlClient({
      baseUrl: 'http://127.0.0.1:8787',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.events({ subId: 's1', cursor: 12, limit: 50 });
    const [url] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(
      'http://127.0.0.1:8787/events?subId=s1&cursor=12&limit=50'
    );
  });

  it('throws ControlApiError with retryable flag on 503', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ error: 'bootstrapping', retryable: true }, 503)
      );
    const client = new ControlClient({
      baseUrl: 'http://127.0.0.1:8787',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.status()).rejects.toMatchObject({
      name: 'ControlApiError',
      status: 503,
      retryable: true,
    });
  });

  it('throws DaemonUnreachableError when fetch rejects', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const client = new ControlClient({
      baseUrl: 'http://127.0.0.1:8787',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.status()).rejects.toBeInstanceOf(
      DaemonUnreachableError
    );
  });

  it('retries an idempotent GET on a transient connection failure (stale keep-alive socket)', async () => {
    // First call mimics ECONNRESET on a reaped keep-alive socket; retry on a
    // fresh socket succeeds (toon-client#186).
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce(jsonResponse({ ready: true, bootstrapping: false }));
    const client = new ControlClient({
      baseUrl: 'http://127.0.0.1:8787',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const status = await client.status();
    expect(status.ready).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a mutating POST on a connection failure (no double-publish)', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('socket hang up'));
    const client = new ControlClient({
      baseUrl: 'http://127.0.0.1:8787',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client.publish({ event: { id: 'e1' } as any })
    ).rejects.toBeInstanceOf(DaemonUnreachableError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('classifies a timeout as a retryable 504, not an unreachable daemon', async () => {
    // A handler that never responds until we abort (e.g. a hung on-chain read).
    const fetchImpl = vi.fn(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted.', 'AbortError'))
          );
        })
    );
    const client = new ControlClient({
      baseUrl: 'http://127.0.0.1:8787',
      timeoutMs: 10,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.status()).rejects.toMatchObject({
      name: 'ControlApiError',
      status: 504,
      retryable: true,
    });
    // 504 is not a connection failure, so it is not transparently retried.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('ping() returns false when daemon is down, true when reachable', async () => {
    const down = new ControlClient({
      baseUrl: 'http://127.0.0.1:8787',
      fetchImpl: vi
        .fn()
        .mockRejectedValue(new Error('refused')) as unknown as typeof fetch,
    });
    expect(await down.ping()).toBe(false);

    const up = new ControlClient({
      baseUrl: 'http://127.0.0.1:8787',
      fetchImpl: vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ ready: true })
        ) as unknown as typeof fetch,
    });
    expect(await up.ping()).toBe(true);
  });

  it('ping() treats a reachable-but-erroring daemon as up', async () => {
    const client = new ControlClient({
      baseUrl: 'http://127.0.0.1:8787',
      fetchImpl: vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ error: 'boom' }, 500)
        ) as unknown as typeof fetch,
    });
    expect(await client.ping()).toBe(true);
  });
});

it('ControlApiError carries detail', () => {
  const e = new ControlApiError('x', 502, false, 'relay rejected');
  expect(e.detail).toBe('relay rejected');
});
