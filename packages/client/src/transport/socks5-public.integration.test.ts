/**
 * Integration Test: SOCKS5 Transport via Public Anyone Protocol Proxies
 *
 * Verifies that the client transport layer can route connections through
 * real Anyone Protocol (ator) SOCKS5 proxies on the live network.
 *
 * Public proxies maintained by the Anyone team:
 *   - 5.78.181.0:9052   (Oregon, USA)
 *   - 157.90.113.23:9052 (Nürnberg, Germany)
 *   - 57.128.249.250:9052 (Warsaw, Poland)
 *
 * Run:
 *   ATOR_PUBLIC=1 pnpm --filter @toon-protocol/client test -- src/transport/socks5-public
 */

import { describe, it, expect } from 'vitest';

import { probeSocks5Proxy, createSocks5Fetch } from './socks5.js';
import { resolveTransport } from './index.js';

const ATOR_PUBLIC = process.env.ATOR_PUBLIC === '1';
const describePublic = ATOR_PUBLIC ? describe : describe.skip;

const ANYONE_PUBLIC_PROXIES = [
  { url: 'socks5h://5.78.181.0:9052', label: 'Oregon' },
  { url: 'socks5h://157.90.113.23:9052', label: 'Nürnberg' },
  { url: 'socks5h://57.128.249.250:9052', label: 'Warsaw' },
];

/**
 * Finds the first reachable public Anyone proxy.
 */
async function findReachableProxy(): Promise<string | null> {
  for (const proxy of ANYONE_PUBLIC_PROXIES) {
    try {
      await probeSocks5Proxy(proxy.url, 5000);
      return proxy.url;
    } catch {
      continue;
    }
  }
  return null;
}

describePublic('SOCKS5 Transport via Public Anyone Proxies (ATOR_PUBLIC=1)', () => {
  let proxyUrl: string | null = null;

  it('finds a reachable public Anyone proxy', async () => {
    proxyUrl = await findReachableProxy();
    expect(proxyUrl).not.toBeNull();
    console.log(`[ator] Using proxy: ${proxyUrl}`);
  }, 30_000);

  it('probeSocks5Proxy succeeds against public proxy', async () => {
    if (!proxyUrl) return;
    // Should not throw
    await probeSocks5Proxy(proxyUrl, 10_000);
  }, 15_000);

  it('resolveTransport returns factories for socks5 type', async () => {
    if (!proxyUrl) return;
    const transport = await resolveTransport(
      { type: 'socks5', socksProxy: proxyUrl },
      'ws://example.com:3000',
      'http://example.com:8080'
    );

    expect(transport.createWebSocket).toBeDefined();
    expect(transport.httpClient).toBeDefined();
    expect(transport.btpUrl).toBeUndefined(); // no URL rewrite in socks5 mode
    expect(transport.connectorUrl).toBeUndefined();
  }, 30_000);

  it('createSocks5Fetch can reach an HTTP endpoint through the proxy', async () => {
    if (!proxyUrl) return;

    const proxiedFetch = createSocks5Fetch(proxyUrl);
    const response = await proxiedFetch('http://api.ipify.org?format=json', {
      signal: AbortSignal.timeout(30_000),
    });

    expect(response.ok).toBe(true);
    const data = (await response.json()) as { ip: string };
    expect(data.ip).toBeDefined();
    // The IP should be the proxy's exit IP, not our real IP
    console.log(`[ator] Exit IP: ${data.ip}`);
  }, 45_000);
});
