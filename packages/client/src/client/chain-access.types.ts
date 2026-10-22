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
import type { BatchSettlementPayerConfig } from '../channel/batch-settlement/payer.js';
import { getLamports } from '../channel/solana/payment-channel.js';
import { rpcTransport, type ChainRpcRoute } from '../transport/rpc.js';
import type { ChannelFacadeDeps } from './channel-facade.js';

declare const url: string;
declare const account: Parameters<typeof evmWalletAccess>[0]['account'];
declare const payerConfig: BatchSettlementPayerConfig;
declare const facade: ChannelFacadeDeps;

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

  // The channel facade's EVM and Solana access.
  if (facade.evm !== undefined) {
    const route: ChainRpcRoute = facade.evm.rpc;
    void route;
    // @ts-expect-error the route is required
    const missing: typeof facade.evm = { privateKey: facade.evm.privateKey };
    void missing;
  }

  // The payer's own fetch, which serves the facilitator and the sponsor
  // endpoint, is required.
  const { fetch: _fetch, ...withoutFetch } = payerConfig;
  // @ts-expect-error the payer cannot be configured without a fetch
  const noFetch: BatchSettlementPayerConfig = withoutFetch;
  void noFetch;
}
