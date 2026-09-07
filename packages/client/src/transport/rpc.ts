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
}

/**
 * A viem HTTP transport for `url`, bound to `dispatcher` when there is one.
 *
 * `undefined` dispatcher means clearnet, and produces exactly the transport this
 * package built before hidden services existed.
 */
export function rpcTransport(
  url: string,
  dispatcher: unknown | undefined,
  options: RpcTransportOptions = {}
): ReturnType<typeof http> {
  const { timeout, retryCount } = options;
  return http(url, {
    ...(timeout !== undefined ? { timeout } : {}),
    ...(retryCount !== undefined ? { retryCount } : {}),
    ...(dispatcher !== undefined ? { fetchOptions: { dispatcher } as RequestInit } : {}),
  });
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
