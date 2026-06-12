/**
 * Transport resolution — resolves ClientTransportConfig into concrete
 * factories and URL rewrites for use by BTP and HTTP clients.
 *
 * Called during `initializeHttpMode()` before any connections are created.
 */

import type { ClientTransportConfig } from '../types.js';

/**
 * Resolved transport artifacts ready for client wiring.
 */
export interface ResolvedTransport {
  /** Custom WebSocket factory for SOCKS5 mode (Node.js only). */
  createWebSocket?: (url: string) => WebSocket;
  /** Custom fetch implementation for SOCKS5 mode (Node.js only). */
  httpClient?: typeof fetch;
  /** Rewritten BTP URL for gateway mode. */
  btpUrl?: string;
  /** Rewritten connector URL for gateway mode. */
  connectorUrl?: string;
  /**
   * Teardown handle for a proxy this resolver STARTED (managed `anon` daemon).
   * Present only when `resolveTransport` auto-launched a managed proxy for a
   * `.anyone` host. `ToonClient.stop()` invokes it. Undefined for all
   * explicit-proxy / direct / gateway paths (the caller owns their own proxy).
   */
  stopManagedProxy?: () => Promise<void>;
}

/**
 * Returns true when `url`'s host ends in the `.anyone` TLD (ATOR hidden
 * service). Tolerant of `ws://`/`wss://` and a missing scheme.
 */
function isAnyoneHost(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const withScheme = /:\/\//.test(url) ? url : `ws://${url}`;
    const host = new URL(withScheme).hostname.toLowerCase();
    return host.endsWith('.anyone');
  } catch {
    return false;
  }
}

/**
 * Managed-proxy auto-start knob. `managedAnonProxy` defaults to `true`
 * (auto-start for `.anyone` hosts when no explicit proxy is configured).
 */
export interface ManagedProxyResolveOptions {
  /**
   * Opt-out switch. When explicitly `false`, the managed `anon` proxy is never
   * auto-started even for a `.anyone` host (the caller must supply their own
   * `transport.socksProxy` or `ANYONE_PROXY_URLS`). Default: auto (true).
   */
  managedAnonProxy?: boolean;
  /** Override the SOCKS port the managed daemon binds. Default 9050. */
  managedAnonSocksPort?: number;
}

/**
 * Resolves a transport config into concrete connection artifacts.
 *
 * - `direct` (or undefined): returns empty object (use defaults) — UNLESS the
 *   btpUrl host ends in `.anyone` and no explicit proxy is configured, in which
 *   case a managed `anon` SOCKS5h proxy is auto-started (zero-setup ATOR).
 * - `socks5`: dynamically imports Node.js SOCKS5 helpers, probes proxy
 *   reachability (fail-closed), returns WebSocket factory + fetch wrapper.
 * - `gateway`: rewrites URLs to route through the gateway.
 *
 * @throws If SOCKS5 proxy is unreachable or URL is invalid.
 */
export async function resolveTransport(
  transport: ClientTransportConfig | undefined,
  originalBtpUrl?: string,
  originalConnectorUrl?: string,
  managedProxyOptions?: ManagedProxyResolveOptions
): Promise<ResolvedTransport> {
  // Auto-managed ATOR: a `.anyone` btpUrl with no explicit proxy configured.
  // Triggers only when the caller did NOT supply an explicit socks5/gateway
  // transport, did NOT opt out (managedAnonProxy !== false), and the
  // ANYONE_PROXY_URLS escape hatch is unset. Browser bundles never reach the
  // node-only `anon-proxy` module — it is dynamically imported here, on the
  // Node-only `.anyone` path.
  const hasExplicitProxy =
    !!transport &&
    (transport.type === 'socks5' || transport.type === 'gateway');
  const envProxy = process.env['ANYONE_PROXY_URLS'];
  if (
    !hasExplicitProxy &&
    managedProxyOptions?.managedAnonProxy !== false &&
    !envProxy &&
    isAnyoneHost(originalBtpUrl)
  ) {
    const { startManagedAnonProxy } = await import('./anon-proxy.js');
    const { createSocks5WebSocketFactory, createSocks5Fetch } =
      await import('./socks5.js');

    const proxy = await startManagedAnonProxy({
      ...(managedProxyOptions?.managedAnonSocksPort !== undefined
        ? { socksPort: managedProxyOptions.managedAnonSocksPort }
        : {}),
    });

    try {
      return {
        createWebSocket: createSocks5WebSocketFactory(proxy.socksProxy),
        httpClient: createSocks5Fetch(proxy.socksProxy),
        stopManagedProxy: proxy.stop,
      };
    } catch (err) {
      // Wiring failed after the daemon started — tear it down so we don't leak.
      await proxy.stop();
      throw err;
    }
  }

  if (!transport || transport.type === 'direct') {
    return {};
  }

  if (transport.type === 'socks5') {
    const {
      createSocks5WebSocketFactory,
      createSocks5Fetch,
      probeSocks5Proxy,
    } = await import('./socks5.js');

    // Fail-closed: abort if proxy is unreachable
    await probeSocks5Proxy(transport.socksProxy);

    return {
      createWebSocket: createSocks5WebSocketFactory(transport.socksProxy),
      httpClient: createSocks5Fetch(transport.socksProxy),
    };
  }

  if (transport.type === 'gateway') {
    const { rewriteUrlsForGateway } = await import('./gateway.js');
    const rewritten = rewriteUrlsForGateway(
      transport.gatewayUrl,
      originalBtpUrl,
      originalConnectorUrl
    );
    return {
      btpUrl: rewritten.btpUrl,
      connectorUrl: rewritten.connectorUrl,
    };
  }

  // Exhaustiveness guard
  throw new Error(
    `Unknown transport type: "${(transport as { type: string }).type}"`
  );
}
