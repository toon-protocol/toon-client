/**
 * Which fetch each chain's JSON-RPC dials through, decided once, and the
 * settlement network each chain is reached through, built once over it.
 *
 * This is the only module that reads {@link ResolvedConfig.chainRpc}. Each route
 * it decides goes to exactly one place: the constructor of that chain's
 * settlement network, which requires a route with a `fetch`. Everything else
 * that reaches a chain (the payer, the channel facade, the wallet) asks the
 * network for its RPC client, so no call site can default to the global `fetch`
 * and announce its wallet on clearnet (ADR 0002, ADR 0005).
 */
import { privateKeyToAccount } from 'viem/accounts';
import { toHex } from 'viem';
import type { ChainKind } from './types.js';
import { directFetch, type ChainRpcRoute } from '../transport/rpc.js';
import type { ResolvedConfig } from './config.js';
import { evmSettlementNetwork } from '../channel/batch-settlement/evm-network.js';
import { SolanaSettlementNetwork } from '../channel/batch-settlement/solana-network.js';
import type { SettlementNetwork } from '../channel/batch-settlement/settlement-network.js';
import { base58Decode } from '../utils/base58.js';

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

/**
 * The settlement networks this client pays on and leaves its channels through:
 * one per chain it holds a key for, each built once from that key and the RPC
 * route {@link chainRoutes} decided for its chain.
 */
export function settlementNetworks(config: ResolvedConfig): SettlementNetwork[] {
  const routes = chainRoutes(config);
  const evmKey = config.identity.evm?.privateKey;
  const solanaKey = config.identity.solana;
  return [
    ...(evmKey !== undefined
      ? [
          evmSettlementNetwork({
            account: privateKeyToAccount(toHex(evmKey)),
            rpc: routes.evm,
            fetch: config.fetch,
            ...(config.facilitatorUrl !== undefined
              ? { facilitatorUrl: config.facilitatorUrl }
              : {}),
            ...(config.depositMethod !== undefined
              ? { depositMethod: config.depositMethod }
              : {}),
            depositGas: config.depositGas,
          }),
        ]
      : []),
    ...(solanaKey !== undefined
      ? [
          new SolanaSettlementNetwork({
            signer: {
              privateKey: solanaKey.secretKey.slice(0, 32),
              publicKey: base58Decode(solanaKey.publicKey),
            },
            rpc: routes.solana,
            fetch: config.fetch,
            connector: config.connector,
          }),
        ]
      : []),
  ];
}
