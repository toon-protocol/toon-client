import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { startFakeSocks5, type FakeSocks5Server } from './fake-socks5.js';
import {
  DEFAULT_HS_CONNECT_TIMEOUT_MS,
  createHiddenServiceTransport,
  probeSocks5Proxy,
  type HiddenServiceTransport,
} from './socks.js';

/** `socks`'s own default, from its `common/constants.ts`. */
const SOCKS_LIBRARY_DEFAULT_TIMEOUT_MS = 30_000;

/**
 * A hidden-service address that resolves nowhere. That is the point: nothing in
 * these tests can succeed by accident through the operating system's resolver,
 * so a passing test is evidence the name travelled to the proxy.
 */
const HS_HOST = 'qrstuvwxyz234567abcdefghijklmnop.anyone';

describe('DEFAULT_HS_CONNECT_TIMEOUT_MS', () => {
  it('leaves the socks default far behind, so slow is not read as unreachable', () => {
    // A cold introduction-point circuit routinely takes longer than 30s. Falling
    // back to the library default would turn every slow first request into an
    // "unreachable" error, which is indistinguishable from a wrong address.
    expect(DEFAULT_HS_CONNECT_TIMEOUT_MS).toBeGreaterThan(SOCKS_LIBRARY_DEFAULT_TIMEOUT_MS * 2);
  });
});

describe('probeSocks5Proxy', () => {
  it('resolves against a listening proxy', async () => {
    const proxy = await startFakeSocks5(new Map());
    await expect(probeSocks5Proxy(proxy.url)).resolves.toBeUndefined();
    await proxy.close();
  });

  it('fails closed, naming the daemon, when nothing is listening', async () => {
    // Port 1 on loopback: reserved, and nothing may bind it.
    await expect(probeSocks5Proxy('socks5h://127.0.0.1:1', 500)).rejects.toThrow(
      /No SOCKS5 proxy at 127\.0\.0\.1:1/
    );
    await expect(probeSocks5Proxy('socks5h://127.0.0.1:1', 500)).rejects.toThrow(/anon` daemon/);
  });
});

describe('createHiddenServiceTransport', () => {
  let origin: http.Server;
  let originPort: number;
  let proxy: FakeSocks5Server;
  let transport: HiddenServiceTransport;

  beforeEach(async () => {
    origin = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            path: req.url,
            host: req.headers.host,
            method: req.method,
            contentType: req.headers['content-type'] ?? null,
            body: Array.from(Buffer.concat(chunks)),
          })
        );
      });
    });
    await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve));
    originPort = (origin.address() as AddressInfo).port;
    proxy = await startFakeSocks5(new Map([[HS_HOST, originPort]]));
    transport = createHiddenServiceTransport(proxy.url, { connectTimeoutMs: 5_000 });
  });

  afterEach(async () => {
    await transport.close();
    await proxy.close();
    await new Promise<void>((resolve) => origin.close(() => resolve()));
  });

  it('fetches a hidden service, sending the hostname to the proxy to resolve', async () => {
    const response = await transport.fetch(`http://${HS_HOST}/ilp`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ path: '/ilp', host: HS_HOST });

    // The load-bearing assertion. `kind: 'domain'` means the client handed the
    // proxy a NAME. Had it resolved locally the fixture would have seen an
    // `ipv4` destination — and in the real world the address would already have
    // gone out in a DNS query.
    expect(proxy.requests).toEqual([{ host: HS_HOST, port: 80, kind: 'domain' }]);
  });

  it('returns a global Response, not undici\'s', async () => {
    // Callers compare against the global class; an undici Response would fail
    // those checks in ways that only show up far from here.
    const response = await transport.fetch(`http://${HS_HOST}/`);
    expect(response).toBeInstanceOf(Response);
    expect(proxy.requests.at(-1)).toEqual({ host: HS_HOST, port: 80, kind: 'domain' });
  });

  it('carries a POST body and headers through the proxy', async () => {
    const response = await transport.fetch(`http://${HS_HOST}/ilp`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array([1, 2, 3]),
    });
    await expect(response.json()).resolves.toMatchObject({
      method: 'POST',
      path: '/ilp',
      contentType: 'application/octet-stream',
      body: [1, 2, 3],
    });
    expect(proxy.requests.at(-1)).toEqual({ host: HS_HOST, port: 80, kind: 'domain' });
  });

  it('exposes a dispatcher the global fetch honours — the viem path', async () => {
    // viem's HTTP transport calls the global `fetch` and accepts no injected
    // one, so ADR 0002 hangs entirely on this working.
    //
    // This is also the test that catches an undici major bump: Node's own
    // bundled undici defines the handler it hands `dispatcher.dispatch`, and
    // its shape changed between Node 22 and Node 26. Only undici 7 accepts
    // both — see the note at the top of `socks.ts`.
    const response = await globalThis.fetch(`http://${HS_HOST}/rpc`, {
      dispatcher: transport.dispatcher,
    } as RequestInit);

    await expect(response.json()).resolves.toMatchObject({ path: '/rpc' });
    expect(proxy.requests.at(-1)).toEqual({ host: HS_HOST, port: 80, kind: 'domain' });
  });

  it('surfaces a refusal when the proxy cannot reach the destination', async () => {
    await expect(transport.fetch('http://unknown234567.anyone/')).rejects.toThrow();
    // Even the failure is evidence: the unreachable name reached the proxy as a
    // name. A client that had resolved it locally would have failed earlier, in
    // its own resolver, and the proxy would have recorded nothing at all.
    expect(proxy.requests.at(-1)).toEqual({ host: 'unknown234567.anyone', port: 80, kind: 'domain' });
  });

  it('opens a BTP websocket through the proxy', async () => {
    const wss = new WebSocketServer({ server: origin });
    wss.on('connection', (socket) => socket.send('btp-hello'));

    const ws = transport.createWebSocket(`ws://${HS_HOST}/btp`) as {
      on(event: string, cb: (data: unknown) => void): void;
      close(): void;
    };

    const message = await new Promise<string>((resolve, reject) => {
      ws.on('message', (data) => resolve(String(data)));
      ws.on('error', (err) => reject(err));
    });

    expect(message).toBe('btp-hello');
    expect(proxy.requests.at(-1)).toEqual({ host: HS_HOST, port: 80, kind: 'domain' });
    ws.close();
    wss.close();
  });
});
