/**
 * SOCKS5 transport helpers for Node.js environments.
 *
 * This module is dynamically imported only when `transport.type === 'socks5'`
 * is configured, keeping `ws` and `socks-proxy-agent` out of browser bundles.
 */

import { createConnection } from 'node:net';

/**
 * Parses and validates a `socks5h://` URL.
 * Enforces `socks5h://` scheme (not `socks5://`) to prevent DNS leaks —
 * `.anon` hostnames must be resolved by the proxy, not locally.
 *
 * Mirrors the connector's `transport/socks-url.ts` validation logic.
 */
export function validateSocks5hUrl(socksProxy: string): {
  host: string;
  port: number;
} {
  if (!socksProxy.startsWith('socks5h://')) {
    throw new Error(
      `SOCKS5 proxy URL must use socks5h:// scheme (got "${socksProxy.split('://')[0]}://"). ` +
        'The "h" suffix ensures DNS resolution happens at the proxy, preventing leaks of .anon hostnames.'
    );
  }

  // Parse by converting to http:// for URL constructor compatibility
  const httpUrl = socksProxy.replace(/^socks5h:\/\//, 'http://');
  let parsed: URL;
  try {
    parsed = new URL(httpUrl);
  } catch {
    throw new Error(`Malformed SOCKS5 proxy URL: "${socksProxy}"`);
  }

  const host = parsed.hostname;
  const port = parsed.port ? parseInt(parsed.port, 10) : 1080;

  if (!host) {
    throw new Error(`SOCKS5 proxy URL missing host: "${socksProxy}"`);
  }
  if (port < 0 || port > 65535 || !Number.isFinite(port)) {
    throw new Error(
      `SOCKS5 proxy port out of range (0–65535): ${parsed.port}`
    );
  }

  return { host, port };
}

/**
 * Creates a WebSocket factory that routes connections through a SOCKS5 proxy.
 * Uses the `ws` npm package (Node.js only) which accepts an `agent` option.
 */
export function createSocks5WebSocketFactory(
  socksProxy: string
): (url: string) => WebSocket {
  validateSocks5hUrl(socksProxy);

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { SocksProxyAgent } = require('socks-proxy-agent') as typeof import('socks-proxy-agent');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const WS = require('ws') as typeof import('ws');

  const agent = new SocksProxyAgent(socksProxy);

  return (url: string) => new WS.default(url, { agent }) as unknown as WebSocket;
}

/**
 * Creates a fetch wrapper that routes HTTP requests through a SOCKS5 proxy.
 * Uses `socks-proxy-agent` with Node.js native `fetch` via undici dispatcher.
 */
export function createSocks5Fetch(socksProxy: string): typeof fetch {
  validateSocks5hUrl(socksProxy);

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { SocksProxyAgent } = require('socks-proxy-agent') as typeof import('socks-proxy-agent');
  const agent = new SocksProxyAgent(socksProxy);

  return (input: string | URL | Request, init?: RequestInit) => {
    // Node.js fetch (undici) supports custom dispatcher via agent
    return globalThis.fetch(input, {
      ...init,
      // @ts-expect-error -- Node.js fetch accepts dispatcher option not in lib.dom.d.ts
      dispatcher: agent,
    });
  };
}

/**
 * Probes SOCKS5 proxy reachability with a TCP connection test.
 * Fail-closed: throws if the proxy is unreachable within the timeout.
 *
 * @param socksProxy - `socks5h://host:port` URL
 * @param timeoutMs - Connection timeout in milliseconds (default: 2000)
 */
export async function probeSocks5Proxy(
  socksProxy: string,
  timeoutMs = 2000
): Promise<void> {
  const { host, port } = validateSocks5hUrl(socksProxy);

  return new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host, port }, () => {
      socket.destroy();
      resolve();
    });

    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      reject(
        new Error(
          `SOCKS5 proxy at ${host}:${port} unreachable (timeout ${timeoutMs}ms). ` +
            'Refusing to start without privacy transport (fail-closed).'
        )
      );
    });

    socket.on('error', (err) => {
      socket.destroy();
      reject(
        new Error(
          `SOCKS5 proxy at ${host}:${port} unreachable: ${err.message}. ` +
            'Refusing to start without privacy transport (fail-closed).'
        )
      );
    });
  });
}
