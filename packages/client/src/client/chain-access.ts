/**
 * Which fetch each chain's JSON-RPC dials through, decided once.
 *
 * This is the only module that reads {@link ResolvedConfig.chainRpc}. Everything
 * below it takes a finished {@link ChainRpcRoute} whose `fetch` is required, so a
 * hidden payer's call site cannot compile without one, and cannot default to the
 * global `fetch` and announce its wallet on clearnet (ADR 0002, ADR 0005).
 */
import type { ChainKind } from './types.js';
import { directFetch, type ChainRpcRoute } from '../transport/rpc.js';
import type { ResolvedConfig } from './config.js';

/**
 * Each chain's RPC route.
 *
 * - Chain RPC rides the proxy (`socksProxy` with `proxyRpc` on): that chain's
 *   own pinned, proxied fetch, each chain on its own circuit.
 * - A hidden payer with `proxyRpc: false`: the direct fetch, chosen here on
 *   purpose. `config.fetch` is the proxied edge fetch, and is NOT used: a payer
 *   who opted out because their node is on loopback would otherwise still be
 *   dialling it through a circuit that cannot reach loopback at all.
 * - No `socksProxy`: EVM dials directly, as before. Solana uses `config.fetch`,
 *   the caller's own if they injected one, so wallet reads and channel RPC agree.
 */
export function chainRoutes(config: ResolvedConfig): Record<ChainKind, ChainRpcRoute> {
  const { chainRpc, rpcUrls } = config;
  if (chainRpc !== undefined) {
    return {
      evm: { url: rpcUrls.evm, fetch: chainRpc.evm.fetch, proxied: true },
      solana: { url: rpcUrls.solana, fetch: chainRpc.solana.fetch, proxied: true },
    };
  }
  return {
    evm: { url: rpcUrls.evm, fetch: directFetch },
    solana: {
      url: rpcUrls.solana,
      fetch: config.socksProxy === undefined ? config.fetch : directFetch,
    },
  };
}
