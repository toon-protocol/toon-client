/**
 * ADR 0005: a hidden payer proves its proxy before it starts.
 *
 * Each test breaks exactly one path — a fetch that drops its dispatcher, a viem
 * transport without `fetchFn`, a `ws` socket without its agent — and expects
 * `ToonClient.create` to refuse with the path named, with the fake proxy having
 * been asked for nothing. The real transports must pass, also leaving the proxy
 * unasked: a canary is refused by the hook, never forwarded.
 */
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { http as viemHttp } from 'viem';
import { createRequire } from 'node:module';
import { ProxyBypassError, type ProxiedPath } from './errors.js';
import { ToonClient } from './ToonClient.js';
import { startFakeSocks5, type FakeSocks5Server } from '../transport/fake-socks5.js';
import type { ToonClientConfig } from './types.js';

const HS_HOST = 'qrstuvwxyz234567abcdefghijklmnop.anyone';
const TOKEN = '0x3333333333333333333333333333333333333333';
const MNEMONIC = 'test test test test test test test test test test test junk';

const SELF_DESCRIPTION = {
  ilpAddresses: ['g.toon.hs'],
  httpEndpoint: `http://${HS_HOST}/ilp`,
  edgeIdentity: { keyId: 'k1', publicKey: `0x04${'11'.repeat(64)}` },
  batchSettlements: [
    {
      network: 'eip155:84532',
      asset: TOKEN,
      payTo: '0x1111111111111111111111111111111111111111',
      receiverAuthorizer: '0x1111111111111111111111111111111111111111',
      withdrawDelay: 86_400,
      name: 'USDC',
      version: '2',
    },
  ],
  routes: [{ prefix: 'g.toon.hs', price: '0' }],
  peerCarriages: [],
};

let origin: http.Server;
let proxy: FakeSocks5Server;
const rpcCalls: string[] = [];
const WS = createRequire(import.meta.url)('ws') as new (url: string) => unknown;

beforeAll(async () => {
  origin = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.method === 'GET') return void res.end(JSON.stringify(SELF_DESCRIPTION));
      const call = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id: unknown; method: string };
      rpcCalls.push(call.method);
      res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: '0x14a34' }));
    });
  });
  await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve));
  const port = (origin.address() as { port: number }).port;
  proxy = await startFakeSocks5(new Map([[HS_HOST, port]]));
});

afterAll(async () => {
  await proxy.close();
  await new Promise<void>((resolve) => origin.close(() => resolve()));
});

function config(extra: Partial<ToonClientConfig> = {}): ToonClientConfig {
  return {
    connector: `http://${HS_HOST}`,
    mnemonic: MNEMONIC,
    socksProxy: proxy.url,
    rpcUrl: `http://${HS_HOST}/rpc`,
    channelStore: ':memory:',
    ...extra,
  };
}

async function expectBypass(path: ProxiedPath, extra: Partial<ToonClientConfig>): Promise<void> {
  const before = proxy.requests.length;
  const err = await ToonClient.create(config(extra)).then(
    () => undefined,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(ProxyBypassError);
  expect(err).toMatchObject({ code: 'PROXY_BYPASS', path });
  expect((err as Error).message).toContain(path);
  expect(proxy.requests.length).toBe(before);
}

describe('a hidden payer refuses to start when a path ignores its proxy', () => {
  it('client-edge: a fetch that drops its dispatcher', async () => {
    await expectBypass('client-edge', {
      canaryPaths: { clientEdgeFetch: (input) => globalThis.fetch(input) },
    });
  });

  it('evm-rpc: a viem transport without fetchFn', async () => {
    await expectBypass('evm-rpc', {
      canaryPaths: { evmRpcTransport: (url, _fetch, options) => viemHttp(url, options) },
    });
  });

  it('solana-rpc: a fetch that drops its dispatcher', async () => {
    await expectBypass('solana-rpc', {
      canaryPaths: { solanaRpcFetch: (input) => globalThis.fetch(input) },
    });
  });

  it('btp: a ws socket without its agent', async () => {
    await expectBypass('btp', { canaryPaths: { createWebSocket: (url) => new WS(url) } });
  });

  it('proxyRpc: false runs no RPC canary, but still the edge and BTP ones', async () => {
    // A broken EVM path is not even looked at.
    const ok = await ToonClient.create(
      config({ proxyRpc: false, canaryPaths: { evmRpcTransport: (url) => viemHttp(url) } })
    );
    await ok.close();
    await expectBypass('client-edge', {
      proxyRpc: false,
      canaryPaths: { clientEdgeFetch: (input) => globalThis.fetch(input) },
    });
    await expectBypass('btp', {
      proxyRpc: false,
      canaryPaths: { createWebSocket: (url) => new WS(url) },
    });
  });
});

describe('with the real transports', () => {
  it('create succeeds, and no canary reaches the proxy', async () => {
    const before = proxy.requests.length;
    const client = await ToonClient.create(config());
    try {
      // Only the self-description fetch has gone through the proxy so far.
      const seen = proxy.requests.slice(before);
      for (const request of seen) {
        expect(request).toMatchObject({ host: HS_HOST, kind: 'domain' });
      }
      expect(proxy.requests.some((r) => r.host === '127.0.0.1')).toBe(false);
    } finally {
      await client.close();
    }
  });

  it('EVM RPC reaches the proxy as a hostname on its own circuit, via fetchFn', async () => {
    const { createChainRpcTransport } = await import('../transport/socks.js');
    const { rpcTransport } = await import('../transport/rpc.js');
    const evm = createChainRpcTransport(proxy.url, 'evm');
    try {
      const before = proxy.requests.length;
      const result = await rpcTransport({ url: `http://${HS_HOST}/rpc`, fetch: evm.fetch, proxied: true })({}).request({
        method: 'eth_chainId',
      });
      expect(result).toBe('0x14a34');
      expect(rpcCalls).toContain('eth_chainId');
      expect(proxy.requests.slice(before)[0]).toMatchObject({
        host: HS_HOST,
        kind: 'domain',
        username: 'toon-client-rpc-evm',
      });
    } finally {
      await evm.close();
    }
  });
});

describe('a client with no socksProxy', () => {
  it('runs no canary: nothing but the self-description is fetched', async () => {
    const seen: string[] = [];
    const canaries: string[] = [];
    const record = (input: Parameters<typeof fetch>[0]): Promise<Response> => {
      canaries.push(String(input));
      return Promise.reject(new Error('no canary should run'));
    };
    const client = await ToonClient.create({
      // Were a canary run, it would go down these paths.
      canaryPaths: {
        clientEdgeFetch: record,
        solanaRpcFetch: record,
        evmRpcTransport: (url) => {
          canaries.push(url);
          return viemHttp(url);
        },
        createWebSocket: (url) => {
          canaries.push(url);
          return new WS(url);
        },
      },
      connector: 'http://connector.invalid',
      mnemonic: MNEMONIC,
      rpcUrl: 'http://rpc.invalid',
      channelStore: ':memory:',
      fetch: (input) => {
        seen.push(String(input));
        return Promise.resolve(
          new Response(JSON.stringify(SELF_DESCRIPTION), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        );
      },
    });
    try {
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((url) => new URL(url).host === 'connector.invalid')).toBe(true);
      expect(canaries).toEqual([]);
    } finally {
      await client.close();
    }
  });
});
