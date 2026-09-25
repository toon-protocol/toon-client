/**
 * The one place viem is told to send chain RPC through the hidden-service proxy.
 *
 * viem's HTTP transport calls the **global** `fetch` and accepts no injected one.
 * Its only opening is `fetchOptions`, which it merges into the `fetch` init — and
 * Node's `fetch` reads a `dispatcher` from there. So a dispatcher is how, and the
 * only how, chain traffic joins the packet traffic inside the overlay (ADR 0002).
 *
 * Browser-safe: this module imports nothing but viem. The dispatcher itself is
 * built in `./socks.js`, which is Node-only and dynamically imported; here it is
 * an opaque `unknown` that is either present or not.
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
 * A viem HTTP transport for `url`, bound to `dispatcher` when there is one.
 *
 * `undefined` dispatcher means clearnet, and produces exactly the transport this
 * package built before hidden services existed. A dispatcher also brings
 * {@link PROXIED_RPC_DEFAULTS}, under anything the caller set explicitly.
 */
export function rpcTransport(
  url: string,
  dispatcher: unknown | undefined,
  options: RpcTransportOptions = {}
): ReturnType<typeof http> {
  const { timeout, retryCount, retryDelay } =
    dispatcher === undefined ? options : { ...PROXIED_RPC_DEFAULTS, ...definedOnly(options) };
  return http(url, {
    ...(timeout !== undefined ? { timeout } : {}),
    ...(retryCount !== undefined ? { retryCount } : {}),
    ...(retryDelay !== undefined ? { retryDelay } : {}),
    ...(dispatcher !== undefined ? { fetchOptions: { dispatcher } as RequestInit } : {}),
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
