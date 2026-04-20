/**
 * Gateway transport for browser environments.
 *
 * Rewrites BTP and HTTP URLs to route through an ator gateway that handles
 * SOCKS5 proxying server-side. Browser clients connect to the gateway via
 * standard WebSocket/HTTP — no special transport code needed.
 */

/**
 * Rewrites btpUrl and connectorUrl to route through a gateway.
 *
 * Gateway endpoint conventions:
 *   - WebSocket: `ws(s)://<gateway>/btp` — proxies BTP connections
 *   - HTTP:      `http(s)://<gateway>/api` — proxies connector admin API
 *
 * @param gatewayUrl - Base URL of the ator gateway (http:// or https://)
 * @param btpUrl - Original BTP WebSocket URL (optional)
 * @param connectorUrl - Original connector HTTP URL (optional)
 */
export function rewriteUrlsForGateway(
  gatewayUrl: string,
  btpUrl?: string,
  connectorUrl?: string
): { btpUrl?: string; connectorUrl?: string } {
  const base = gatewayUrl.replace(/\/$/, '');

  // Derive WebSocket scheme from HTTP scheme
  const wsBase = base.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');

  return {
    btpUrl: btpUrl ? `${wsBase}/btp` : undefined,
    connectorUrl: connectorUrl ? `${base}/api` : undefined,
  };
}
