/**
 * SOCKS5 transport helpers for Node.js environments.
 *
 * This module is dynamically imported only when `transport.type === 'socks5'`
 * is configured, keeping `ws` and `socks-proxy-agent` out of browser bundles.
 */

import { createConnection } from 'node:net';
import { createRequire } from 'node:module';
import type SocksProxyAgentModule from 'socks-proxy-agent';
import type WSModule from 'ws';
import type httpModule from 'node:http';
import type httpsModule from 'node:https';

// ESM-safe require. This module builds as ESM (tsup `format: ['esm']`) with
// `socks-proxy-agent`/`ws` external, so a bare `require(...)` would be rewritten
// by esbuild into a `__require` shim that throws
// `Dynamic require of "socks-proxy-agent" is not supported` for any pure-ESM
// consumer — breaking the SOCKS5/ATOR transport entirely (the npm-consumer
// toon-client image surfaced this). Building a real require off `import.meta.url`
// (the same pattern as docker/esbuild.config.mjs's banner) keeps the
// synchronous, browser-guarded `require(...)` calls below working in the
// published ESM bundle while leaving the deps external. Browser bundlers never
// reach this code: the module is dynamically imported only when
// `transport.type === 'socks5'`, which is Node-only.
const require = createRequire(import.meta.url);

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
    throw new Error(`SOCKS5 proxy port out of range (0–65535): ${parsed.port}`);
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

  // Resolved via the module-scoped ESM-safe `require` (createRequire) above.
  const { SocksProxyAgent } =
    require('socks-proxy-agent') as typeof SocksProxyAgentModule;
  const WS = require('ws') as typeof WSModule;

  // 120s timeout: the socks library's default is 30s, which is too short for
  // the ATOR network to build circuits to fresh hidden services from certain
  // network paths (e.g., Akash datacenter → public ATOR proxy → local HS).
  // 120s gives the proxy time to find a working introduction-point circuit.
  const agent = new SocksProxyAgent(socksProxy, { timeout: 120_000 });

  // CJS/ESM interop: `require('ws')` can return any of three shapes depending on
  // the bundler/loader: the class directly (pure CJS); `{ default: WSClass, ... }`
  // (esModuleInterop=true / synthetic default); or `{ WebSocket: WSClass, ... }`
  // (named export, no default). Walk the ladder so this factory works in all
  // three environments. Pass 2 code review 2026-05-18: previous `(WS as any).default ?? WS`
  // would accept a namespace object as a "constructor" and throw cryptically.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ws = WS as any;
  const WSClass = (typeof ws === 'function'
    ? ws
    : typeof ws.default === 'function'
      ? ws.default
      : typeof ws.WebSocket === 'function'
        ? ws.WebSocket
        : null) as unknown as typeof WSModule.prototype.constructor;
  if (WSClass === null) {
    throw new Error(
      "createSocks5WebSocketFactory: require('ws') did not yield a constructor on .default, .WebSocket, or the module root."
    );
  }

  return (url: string) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    new (WSClass as any)(url, { agent }) as unknown as WebSocket;
}

/**
 * Creates a fetch wrapper that routes HTTP requests through a SOCKS5 proxy.
 * Uses `socks-proxy-agent` with Node.js `http`/`https` modules (not native
 * fetch, which uses undici and doesn't support SocksProxyAgent's dispatcher).
 */
export function createSocks5Fetch(socksProxy: string): typeof fetch {
  validateSocks5hUrl(socksProxy);

  // Resolved via the module-scoped ESM-safe `require` (createRequire) above.
  const { SocksProxyAgent } =
    require('socks-proxy-agent') as typeof SocksProxyAgentModule;
  const http = require('node:http') as typeof httpModule;
  const https = require('node:https') as typeof httpsModule;

  const agent = new SocksProxyAgent(socksProxy);

  return (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === 'https:';
    const transport = isHttps ? https : http;

    return new Promise<Response>((resolve, reject) => {
      const method = init?.method ?? 'GET';
      const headers = init?.headers
        ? Object.fromEntries(
            init.headers instanceof Headers
              ? init.headers.entries()
              : Array.isArray(init.headers)
                ? init.headers
                : Object.entries(init.headers)
          )
        : {};

      const req = transport.request(
        url,
        { method, headers, agent, timeout: 30_000 },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const body = Buffer.concat(chunks);
            const responseHeaders = new Headers();
            for (const [key, val] of Object.entries(res.headers)) {
              if (val)
                responseHeaders.set(
                  key,
                  Array.isArray(val) ? val.join(', ') : val
                );
            }
            resolve(
              new Response(body, {
                status: res.statusCode ?? 200,
                statusText: res.statusMessage ?? '',
                headers: responseHeaders,
              })
            );
          });
        }
      );

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('SOCKS5 proxied request timeout'));
      });

      if (init?.signal) {
        init.signal.addEventListener('abort', () => {
          req.destroy();
          reject(new Error('Aborted'));
        });
      }

      if (init?.body) {
        req.write(typeof init.body === 'string' ? init.body : init.body);
      }
      req.end();
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
