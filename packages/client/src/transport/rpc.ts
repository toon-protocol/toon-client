/**
 * The one place viem is told to send chain RPC through the hidden-service proxy.
 *
 * viem's HTTP transport takes an injected `fetchFn` (viem `^2.37.2`). Handing it
 * the proxied fetch means chain traffic joins the packet traffic inside the
 * overlay (ADR 0002) through the same fetch the canary tests (ADR 0005).
 *
 * Browser-safe: this module imports nothing but viem. The proxied fetch itself is
 * built in `./socks.js`, which is Node-only and dynamically imported.
 */
import { http } from 'viem';

/** Options a caller already wanted, independent of any proxy. */
export interface RpcTransportOptions {
  timeout?: number;
  retryCount?: number;
  retryDelay?: number;
}

/**
 * What a proxied RPC request gets when its caller names nothing else, sized
 * from connector ADR 0073's measurements through `anon` (decisions 4 and 5).
 *
 * - `timeout` 30s, not viem's 10s. The worst call measured that needed a new
 *   circuit took 13s. Under 10s that one would have been reported as a failure,
 *   and retried on another new circuit.
 * - `retryDelay` 500ms, not viem's 150ms. viem already retries 403, 408, 429,
 *   5xx and dropped connections. Exit IPs are shared, so a 429 is the error to
 *   expect, and retrying it at 150ms mostly earns another one.
 * - `retryCount` 3, viem's own.
 */
export const PROXIED_RPC_DEFAULTS = {
  timeout: 30_000,
  retryCount: 3,
  retryDelay: 500,
} as const satisfies Required<RpcTransportOptions>;

/**
 * Where one chain's JSON-RPC goes and what it goes through: the URL, and the
 * `fetch` that dials it. Both are required. A chain RPC call site cannot compile
 * without the fetch it should use, so a hidden payer cannot reach clearnet by
 * leaving one out (ADR 0005).
 *
 * The decision is made once, in the client's chain-access layer. Nothing below
 * it picks a fetch; nothing below it can default to the global one.
 */
export interface ChainRpcRoute {
  url: string;
  fetch: typeof fetch;
  /**
   * The `fetch` rides the hidden-service proxy, so a request gets
   * {@link PROXIED_RPC_DEFAULTS} under anything the caller set explicitly.
   */
  proxied?: boolean;
}

/**
 * The global `fetch`, looked up per call. This is the deliberately direct
 * route: a clearnet client's, a public helper's default, and a hidden payer's
 * with `proxyRpc: false` (ADR 0002). Choose it by name, at the one place that
 * decides.
 */
export const directFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);

/**
 * A viem HTTP transport over `route`.
 *
 * A proxied route also brings {@link PROXIED_RPC_DEFAULTS}, under anything the
 * caller set explicitly.
 */
export function rpcTransport(
  route: ChainRpcRoute,
  options: RpcTransportOptions = {}
): ReturnType<typeof http> {
  const { timeout, retryCount, retryDelay } =
    route.proxied === true ? { ...PROXIED_RPC_DEFAULTS, ...definedOnly(options) } : options;
  return http(route.url, {
    ...(timeout !== undefined ? { timeout } : {}),
    ...(retryCount !== undefined ? { retryCount } : {}),
    ...(retryDelay !== undefined ? { retryDelay } : {}),
    fetchFn: route.fetch,
  });
}

/** `options` without its `undefined` members, so a spread cannot erase a default. */
function definedOnly(options: RpcTransportOptions): RpcTransportOptions {
  return Object.fromEntries(
    Object.entries(options).filter(([, value]) => value !== undefined)
  ) as RpcTransportOptions;
}

/**
 * `fetch` bound to `dispatcher`, for a JSON-RPC path that calls `fetch` itself
 * rather than going through viem — Solana's, in practice.
 */
export function rpcFetch(dispatcher: unknown | undefined, fetchImpl: typeof fetch = globalThis.fetch): typeof fetch {
  if (dispatcher === undefined) return fetchImpl;
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    fetchImpl(input, { ...init, dispatcher } as unknown as RequestInit)) as typeof fetch;
}
