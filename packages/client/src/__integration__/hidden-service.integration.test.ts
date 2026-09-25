/**
 * Integration test: a paid packet to a connector that is a hidden service.
 *
 * Two halves, and only the first can run unattended.
 *
 * **Half one — the whole client, against a real SOCKS5 proxy.** A local proxy and
 * a local origin, wired exactly as the daemon would wire them, proving that the
 * whole client (not just the transport module) can reach a `.anyone` name it
 * cannot resolve: `ToonClient.create` dials the client edge, reads the node's
 * self-description, and never once asks the operating system where
 * `<something>.anyone` lives. This runs in the integration tier with no external
 * services.
 *
 * **Half two — a real hidden service.** Skipped, and skipped for a reason worth
 * stating: at the time of writing the devnet publishes no `.anyone` connector, so
 * there is no address to point it at. Nothing here is stubbed to make it pass;
 * it is gated on `TOON_HS_CONNECTOR`, and the day a hidden-service node is
 * deployed the test is one environment variable away from being real. Point it
 * at one with:
 *
 * ```bash
 * TOON_HS_CONNECTOR=http://<addr>.anyone TOON_SOCKS=socks5h://127.0.0.1:9050 \
 *   TOON_MNEMONIC='…' pnpm test:integration
 * ```
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ToonClient } from '../client/ToonClient.js';
import { startFakeSocks5, type FakeSocks5Server } from '../transport/fake-socks5.js';

/** A hidden-service name with no clearnet existence — the point of the exercise. */
const HS_HOST = 'qrstuvwxyz234567abcdefghijklmnop.anyone';
const MNEMONIC = 'test test test test test test test test test test test junk';

describe('a client whose connector is a hidden service', () => {
  let origin: http.Server;
  let originPort: number;
  let proxy: FakeSocks5Server;
  let originRequests: string[];

  beforeAll(async () => {
    originRequests = [];
    origin = http.createServer((req, res) => {
      originRequests.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'application/json' });
      // The minimum a stranger needs to transact, per the self-description spec.
      res.end(
        JSON.stringify({
          ilpAddresses: ['g.toon.hs'],
          httpEndpoint: `http://${HS_HOST}/ilp`,
          edgeIdentity: { keyId: 'k1', publicKey: `0x04${'11'.repeat(64)}` },
          settlements: [
            {
              kind: 'evm',
              chain: 'evm:84532',
              settlementAddress: '0x1111111111111111111111111111111111111111',
              tokenNetworkRegistry: '0x8263BdD4eB4862395Cb4ef5dA5d637F4b047Eea1',
              tokenNetwork: '0xa79C3b1dbcEA00a6d84735a134395D8eF6D6a478',
              tokenAddress: '0x49beE1Bca5d15Fb0963117923403F9498119a9Ce',
              decimals: 6,
            },
          ],
          routes: [{ prefix: 'g.toon.hs', price: '0' }],
          peerCarriages: [],
        })
      );
    });
    await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve));
    originPort = (origin.address() as AddressInfo).port;
    proxy = await startFakeSocks5(new Map([[HS_HOST, originPort]]));
  });

  afterAll(async () => {
    await proxy.close();
    await new Promise<void>((resolve) => origin.close(() => resolve()));
  });

  it('reads the node self-description over the proxy, resolving nothing locally', async () => {
    const client = await ToonClient.create({
      connector: `http://${HS_HOST}`,
      mnemonic: MNEMONIC,
      socksProxy: proxy.url,
      channelStore: ':memory:',
    });

    try {
      const description = await client.describe();
      expect(description.ilpAddresses).toContain('g.toon.hs');
      expect(originRequests.length).toBeGreaterThan(0);

      // Every hop went to the proxy as a NAME. A single `ipv4` destination here
      // would mean the client resolved a hidden service locally — which fails,
      // but only after putting the address in a plaintext DNS query.
      expect(proxy.requests.length).toBeGreaterThan(0);
      for (const request of proxy.requests) {
        expect(request).toMatchObject({ host: HS_HOST, kind: 'domain' });
      }
    } finally {
      await client.close();
    }
  });

  it('refuses to build at all when the proxy is missing, before anything leaks', async () => {
    const originSeen = originRequests.length;
    const proxySeen = proxy.requests.length;

    await expect(
      ToonClient.create({
        connector: `http://${HS_HOST}`,
        mnemonic: MNEMONIC,
        channelStore: ':memory:',
      })
    ).rejects.toThrow(/only through a SOCKS5h proxy/);

    // And it failed before dialling: neither the origin nor the proxy saw a
    // thing. The address never left the process, which is the whole point.
    expect(originRequests.length).toBe(originSeen);
    expect(proxy.requests.length).toBe(proxySeen);
  });

  it('refuses to build when the named proxy port has nothing listening', async () => {
    // A daemon the payer forgot to start is a message naming it, not a timeout
    // deep in the send path — and it costs no signed claim.
    const dead = await new Promise<number>((resolve) => {
      const probe = http.createServer();
      probe.listen(0, '127.0.0.1', () => {
        const port = (probe.address() as AddressInfo).port;
        probe.close(() => resolve(port));
      });
    });

    const originSeen = originRequests.length;
    await expect(
      ToonClient.create({
        connector: `http://${HS_HOST}`,
        mnemonic: MNEMONIC,
        socksProxy: `socks5h://127.0.0.1:${dead}`,
        channelStore: ':memory:',
      })
    ).rejects.toThrow(/No SOCKS5 proxy at 127\.0\.0\.1/);
    expect(originRequests.length).toBe(originSeen);
  });

  it('lets an explicitly injected fetch win over the proxy-bound one', async () => {
    // A caller who supplied their own transport has said something specific
    // about how bytes leave this process; the proxy must not silently replace it.
    const proxySeen = proxy.requests.length;
    const seenByInjected: string[] = [];
    const injected: typeof fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      seenByInjected.push(url.toString());
      // The injected transport knows where the origin really is; the proxy is
      // never asked, and that is what this test is watching for.
      url.protocol = 'http:';
      url.host = `127.0.0.1:${originPort}`;
      return fetch(url, init);
    };

    const client = await ToonClient.create({
      connector: `http://${HS_HOST}`,
      mnemonic: MNEMONIC,
      socksProxy: proxy.url,
      fetch: injected,
      channelStore: ':memory:',
    });

    try {
      expect((await client.describe()).ilpAddresses).toContain('g.toon.hs');
      expect(seenByInjected.length).toBeGreaterThan(0);
      expect(proxy.requests.length).toBe(proxySeen);
    } finally {
      await client.close();
    }
  });
});

const LIVE_HS = process.env['TOON_HS_CONNECTOR'];
const LIVE_SOCKS = process.env['TOON_SOCKS'];
const LIVE_MNEMONIC = process.env['TOON_MNEMONIC'];

describe.skipIf(!LIVE_HS || !LIVE_SOCKS || !LIVE_MNEMONIC)(
  'against a deployed hidden-service connector',
  () => {
    it('describes a real .anyone node through a real anon daemon', async () => {
      const client = await ToonClient.create({
        connector: LIVE_HS as string,
        mnemonic: LIVE_MNEMONIC as string,
        socksProxy: LIVE_SOCKS as string,
        channelStore: ':memory:',
      });
      try {
        const description = await client.describe();
        expect(description.ilpAddresses.length).toBeGreaterThan(0);
        expect(description.edgeIdentity).toBeDefined();
      } finally {
        await client.close();
      }
    }, 180_000);
  }
);
