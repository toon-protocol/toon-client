/**
 * Type-level proof that a chain RPC call site cannot omit its fetch.
 *
 * This is not a `.test.ts` on purpose: `pnpm typecheck` excludes those, and
 * these assertions only mean something if `tsc` reads them. Each
 * `@ts-expect-error` fails the build the moment the thing it forbids compiles
 * again — an optional `fetch`, a bare URL, or a global fallback (ADR 0005).
 * Nothing here runs, and nothing imports it.
 */
import { evmWalletAccess } from '../channel/batch-settlement/deposit-gas.js';
import type { EvmSettlementNetworkConfig } from '../channel/batch-settlement/evm-network.js';
import type { SolanaSettlementNetworkConfig } from '../channel/batch-settlement/solana-network.js';
import { getLamports } from '../channel/solana/payment-channel.js';
import { rpcTransport } from '../transport/rpc.js';

declare const url: string;
declare const account: Parameters<typeof evmWalletAccess>[0]['account'];
declare const evmNetwork: EvmSettlementNetworkConfig;
declare const solanaNetwork: SolanaSettlementNetworkConfig;

export function chainRpcNeedsAFetch(): void {
  // The Solana JSON-RPC entry point.
  // @ts-expect-error a bare URL is not a route
  void getLamports(url, 'pubkey');
  // @ts-expect-error a route without a fetch
  void getLamports({ url }, 'pubkey');
  // @ts-expect-error the old optional name does not satisfy the required one
  void getLamports({ url, fetchImpl: fetch }, 'pubkey');

  // The EVM transport builder.
  // @ts-expect-error a bare URL is not a route
  rpcTransport(url);
  // @ts-expect-error a route without a fetch
  rpcTransport({ url });

  // The payer's EVM wallet access.
  // @ts-expect-error a route without a fetch
  evmWalletAccess({ rpc: { url }, account });

  // Each settlement network's own fetch, which serves the facilitator or the
  // sponsor endpoint, is required, as is the Solana network's RPC route.
  const { fetch: _evmFetch, ...evmWithoutFetch } = evmNetwork;
  // @ts-expect-error the EVM network cannot be configured without a fetch
  const noEvmFetch: EvmSettlementNetworkConfig = evmWithoutFetch;
  void noEvmFetch;
  const { fetch: _solanaFetch, ...solanaWithoutFetch } = solanaNetwork;
  // @ts-expect-error the Solana network cannot be configured without a fetch
  const noSolanaFetch: SolanaSettlementNetworkConfig = solanaWithoutFetch;
  void noSolanaFetch;
  // @ts-expect-error the Solana network's RPC route needs a fetch
  const noRpcFetch: SolanaSettlementNetworkConfig = { ...solanaNetwork, rpc: { url } };
  void noRpcFetch;
}
