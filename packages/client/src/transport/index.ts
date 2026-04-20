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
}

/**
 * Resolves a transport config into concrete connection artifacts.
 *
 * - `direct` (or undefined): returns empty object (use defaults).
 * - `socks5`: dynamically imports Node.js SOCKS5 helpers, probes proxy
 *   reachability (fail-closed), returns WebSocket factory + fetch wrapper.
 * - `gateway`: rewrites URLs to route through the gateway.
 *
 * @throws If SOCKS5 proxy is unreachable or URL is invalid.
 */
export async function resolveTransport(
  transport: ClientTransportConfig | undefined,
  originalBtpUrl?: string,
  originalConnectorUrl?: string
): Promise<ResolvedTransport> {
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
