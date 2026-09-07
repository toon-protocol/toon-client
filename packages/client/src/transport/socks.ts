/**
 * The hidden-service carriage: one SOCKS5h proxy, everything that must ride it.
 *
 * A connector deployed as a hidden service is reachable only through a running
 * `anon` daemon's SOCKS5 port. Three separate things in this client have to go
 * through that port, and — annoyingly — each needs a different object to do it:
 *
 * - **The client edge** (`GET /ilp`, `POST /ilp`) goes through `fetch`, which in
 *   Node is undici and takes a **dispatcher**. It does not take an `http.Agent`,
 *   which is why the `socks-proxy-agent` this package used to depend on cannot
 *   serve this path at all.
 * - **Chain RPC** goes through viem, which calls the *global* `fetch` and accepts
 *   no injected one. Its only opening is `http(url, { fetchOptions })`, so it
 *   needs the same dispatcher handed to it as a fetch option (ADR 0002).
 * - **The BTP carriage** goes through `ws`, which is `node:http` underneath and
 *   therefore takes an `http.Agent` and nothing else.
 *
 * So this module builds one SOCKS connection primitive and wraps it three ways.
 * The SOCKS5 handshake itself is `socks`'s job; all we supply is the socket.
 *
 * `undici` is an optional dependency for exactly this reason: Node bundles undici
 * internally but exposes it under no specifier (`require('undici')` is
 * `MODULE_NOT_FOUND`, `node:undici` is `ERR_UNKNOWN_BUILTIN_MODULE`), so a
 * dispatcher cannot be constructed without the package. A dispatcher built by the
 * userland copy *is* honoured by Node's global `fetch` — verified against Node
 * 26.7 / undici 8.10, where the custom `connect` hook fires.
 *
 * NODE ONLY. This module is imported dynamically, never statically, from the
 * paths that need it; every Node built-in is pulled in through an ESM-safe
 * `require` built off `import.meta.url`, because this package builds as ESM with
 * these deps external and esbuild rewrites a bare `require` into a `__require`
 * shim that throws. A browser cannot reach a `.anyone` address by any means, so
 * a browser bundler must never follow an edge into this file.
 */

import { createRequire } from 'node:module';
import { validateSocks5hUrl } from './socks-url.js';
import type * as netModule from 'node:net';
import type * as streamModule from 'node:stream';
import type * as tlsModule from 'node:tls';
import type * as httpModule from 'node:http';
import type * as httpsModule from 'node:https';
import type * as socksModule from 'socks';
import type * as undiciModule from 'undici';
import type WSModule from 'ws';

// ESM-safe require: this file builds as ESM with `undici`/`socks`/`ws` external,
// so a bare `require(...)` would become a throwing `__require` shim in the
// published bundle. Building a real require off `import.meta.url` keeps the
// synchronous lookups below working. (The same pattern the deleted `socks5.ts`
// carried, for the same reason — it was found in production.)
const nodeRequire = createRequire(import.meta.url);

/**
 * How long to wait for the proxy to build a circuit to the hidden service.
 *
 * `socks` defaults to 30s, which is too short: an introduction-point circuit to
 * a cold hidden service routinely takes longer, and a too-short connect timeout
 * turns "slow" into "unreachable".
 */
export const DEFAULT_HS_CONNECT_TIMEOUT_MS = 120_000;

/** Options for {@link createHiddenServiceTransport}. */
export interface HiddenServiceTransportOptions {
  /** Circuit-build timeout, ms. Default {@link DEFAULT_HS_CONNECT_TIMEOUT_MS}. */
  connectTimeoutMs?: number;
}

/**
 * The three shapes of one proxy, plus the handle that shuts it down.
 *
 * Spread `fetch` and `createWebSocket` into a {@link ../client/types.js!ToonClientConfig}
 * to route a client by hand; pass `socksProxy` instead to have the client build
 * this itself.
 */
export interface HiddenServiceTransport {
  /** `fetch`, bound to the proxy. Returns ordinary global `Response` objects. */
  fetch: typeof fetch;
  /** A `ws` factory bound to the proxy, for the BTP carriage. */
  createWebSocket: (url: string) => unknown;
  /**
   * The undici dispatcher behind `fetch`, for handing to something that insists
   * on calling the global `fetch` itself — viem's HTTP transport, in practice
   * (`http(url, { fetchOptions: { dispatcher } })`).
   */
  dispatcher: unknown;
  /** Close the dispatcher's pool and the websocket agents' sockets. */
  close(): Promise<void>;
}

export { validateSocks5hUrl } from './socks-url.js';

/** The one primitive: a TCP socket to `destination`, dialled through the proxy. */
async function socksConnect(
  proxy: { host: string; port: number },
  destination: { host: string; port: number },
  timeoutMs: number
): Promise<netModule.Socket> {
  const { SocksClient } = nodeRequire('socks') as typeof socksModule;
  const { socket } = await SocksClient.createConnection({
    proxy: { host: proxy.host, port: proxy.port, type: 5 },
    command: 'connect',
    destination,
    timeout: timeoutMs,
  });
  return socket;
}

/** Default port for a scheme, when the URL does not name one. */
function portFor(protocol: string, port: string | number | null | undefined): number {
  if (port !== undefined && port !== null && port !== '' && Number.isFinite(Number(port))) return Number(port);
  return protocol === 'https:' || protocol === 'wss:' ? 443 : 80;
}

/**
 * Builds every proxy-bound object this client needs from one `socks5h://` URL.
 *
 * @throws {Error} if the URL is not `socks5h://`, or if `undici`/`socks` are not
 *   installed — they are optional dependencies, so a consumer who never touches
 *   a hidden service never pays for them.
 */
export function createHiddenServiceTransport(
  socksProxy: string,
  options: HiddenServiceTransportOptions = {}
): HiddenServiceTransport {
  const proxy = validateSocks5hUrl(socksProxy);
  const timeoutMs = options.connectTimeoutMs ?? DEFAULT_HS_CONNECT_TIMEOUT_MS;

  const undici = requireOptional<typeof undiciModule>('undici', socksProxy);
  requireOptional<typeof socksModule>('socks', socksProxy);
  const tls = nodeRequire('node:tls') as typeof tlsModule;

  // The dispatcher. undici hands its `connect` hook the destination it wants a
  // socket to; we dial that through SOCKS instead of `net.connect`, and wrap it
  // in TLS ourselves when the scheme calls for it (undici's default connector
  // would have done that, and we have replaced it).
  const dispatcher = new undici.Agent({
    connect(
      connectOptions: { hostname: string; port?: string | number; protocol?: string; servername?: string },
      callback: (err: Error | null, socket: unknown) => void
    ) {
      const port = portFor(connectOptions.protocol ?? 'http:', connectOptions.port);
      socksConnect(proxy, { host: connectOptions.hostname, port }, timeoutMs).then((socket) => {
        socket.setNoDelay(true);
        if (connectOptions.protocol !== 'https:') return callback(null, socket);
        const secure = tls.connect({
          socket,
          servername: connectOptions.servername ?? connectOptions.hostname,
          ALPNProtocols: ['http/1.1'],
        });
        secure.once('secureConnect', () => callback(null, secure));
        secure.once('error', (err) => callback(err, null));
      }, (err: Error) => callback(err, null));
    },
  } as unknown as undiciModule.Agent.Options);

  // Node's global `fetch` honours a dispatcher built by this userland undici
  // (verified on Node 26.7 / undici 8.10: the `connect` hook above fires), and
  // returns ordinary global `Response` objects — which `undici.fetch` would not,
  // and callers do compare those against the global class.
  // `dispatcher` is not in the standard `RequestInit`, and @types/node carries a
  // second copy of undici's types that does not structurally match the userland
  // one — hence the cast. The runtime behaviour is verified, the types are not
  // able to express it.
  const proxiedFetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    globalThis.fetch(input, { ...init, dispatcher } as unknown as RequestInit)) as typeof fetch;

  const agents = createWebSocketAgents(proxy, timeoutMs);

  return {
    fetch: proxiedFetch,
    createWebSocket: (url: string) => {
      const WSClass = loadWebSocketClass();
      const secure = url.startsWith('wss:') || url.startsWith('https:');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return new (WSClass as any)(url, { agent: secure ? agents.https : agents.http });
    },
    dispatcher,
    async close(): Promise<void> {
      agents.http.destroy();
      agents.https.destroy();
      await dispatcher.close();
    },
  };
}

/**
 * `ws` speaks `node:http`, so it wants an `http.Agent` — one per scheme, since
 * an `https.Agent` is what puts TLS on the socket and an `http.Agent` is what
 * must not.
 */
function createWebSocketAgents(
  proxy: { host: string; port: number },
  timeoutMs: number
): { http: httpModule.Agent; https: httpsModule.Agent } {
  const http = nodeRequire('node:http') as typeof httpModule;
  const https = nodeRequire('node:https') as typeof httpsModule;
  const tls = nodeRequire('node:tls') as typeof tlsModule;

  // `createConnection` is the whole extension point: everything else about
  // pooling, keep-alive and request framing stays the stock agent's business.
  class SocksHttpAgent extends http.Agent {
    override createConnection(
      opts: httpModule.ClientRequestArgs,
      callback?: (err: Error | null, stream: streamModule.Duplex) => void
    ): streamModule.Duplex | null | undefined {
      socksConnect(proxy, { host: String(opts.host), port: portFor('http:', opts.port) }, timeoutMs).then(
        (socket) => callback?.(null, socket),
        (err: Error) => callback?.(err, undefined as unknown as streamModule.Duplex)
      );
      return undefined;
    }
  }

  class SocksHttpsAgent extends https.Agent {
    override createConnection(
      opts: httpsModule.RequestOptions,
      callback?: (err: Error | null, stream: streamModule.Duplex) => void
    ): streamModule.Duplex | null | undefined {
      const fail = (err: Error): void => callback?.(err, undefined as unknown as streamModule.Duplex);
      socksConnect(proxy, { host: String(opts.host), port: portFor('https:', opts.port) }, timeoutMs).then(
        (socket) => {
          const secure = tls.connect({
            socket,
            servername: opts.servername ?? String(opts.host),
          });
          secure.once('secureConnect', () => callback?.(null, secure));
          secure.once('error', fail);
        },
        fail
      );
      return undefined;
    }
  }

  return {
    http: new SocksHttpAgent({ keepAlive: false }),
    https: new SocksHttpsAgent({ keepAlive: false }),
  };
}

/**
 * CJS/ESM interop: `require('ws')` yields the class directly, `{ default }`, or
 * `{ WebSocket }` depending on loader and bundler. Walk the ladder rather than
 * accepting a namespace object as a constructor and throwing cryptically later.
 */
function loadWebSocketClass(): unknown {
  const mod = nodeRequire('ws') as typeof WSModule | { default?: unknown; WebSocket?: unknown };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const candidate = mod as any;
  const WSClass =
    typeof candidate === 'function'
      ? candidate
      : typeof candidate.default === 'function'
        ? candidate.default
        : typeof candidate.WebSocket === 'function'
          ? candidate.WebSocket
          : null;
  if (WSClass === null) {
    throw new Error(
      "The BTP carriage over a hidden service needs the `ws` package, and require('ws') " +
        'did not yield a constructor on .default, .WebSocket, or the module root.'
    );
  }
  return WSClass;
}

/** Loads an optional dependency, or explains what to install and why. */
function requireOptional<T>(name: string, socksProxy: string): T {
  try {
    return nodeRequire(name) as T;
  } catch {
    throw new Error(
      `Reaching a hidden service needs the optional dependency "${name}", which is not installed. ` +
        `Run \`npm install ${name}\`, or drop socksProxy (${socksProxy}) and dial a clearnet connector.`
    );
  }
}

/**
 * Probes the proxy with a plain TCP connect. Fail-closed and fail-early: a
 * client configured for a hidden service must not quietly fall back to clearnet,
 * and finding out at packet time costs a signed claim.
 */
export async function probeSocks5Proxy(socksProxy: string, timeoutMs = 2000): Promise<void> {
  const { host, port } = validateSocks5hUrl(socksProxy);
  const net = nodeRequire('node:net') as typeof netModule;

  return new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ host, port }, () => {
      socket.destroy();
      resolve();
    });
    const fail = (why: string): void => {
      socket.destroy();
      reject(
        new Error(
          `No SOCKS5 proxy at ${host}:${port} (${why}). A hidden-service connector is ` +
            'unreachable without one: start the Anyone Protocol `anon` daemon, or run ' +
            '`toon` which can start one for you.'
        )
      );
    };
    socket.setTimeout(timeoutMs, () => fail(`timed out after ${timeoutMs}ms`));
    socket.on('error', (err) => fail(err.message));
  });
}
