/**
 * Reading a connector's x402 `batch-settlement` offers, and choosing one
 * (connector ADR 0074 decision 8; connector #1345, #1357).
 *
 * A node that has opted in to a chain publishes the same facts twice, as two
 * projections of one list (ND-11):
 *
 *   - the greeting's `accepts[]` gains one x402-valid entry per chain, beside
 *     `toon-channel` — a full x402 `PaymentRequirements`, route price included;
 *   - `GET /ilp` carries them under `batchSettlements`, flat and unpriced,
 *     because a price belongs to a route and not to a chain.
 *
 * Either one yields a {@link BatchSettlementOffer}: the greeting directly, the
 * self-description through {@link offerFromTerms} once the route's charge is
 * known.
 *
 * An x402 channel is one-way, client to connector. A client that expects a
 * payout (ADR 0026 netting) has to stay on `toon-channel`, so choosing this
 * scheme is always the caller's opt-in, never a default.
 *
 * These offers are also where the Solana sponsor key comes from: the key
 * `buildSponsoredOpen` insists on must be read off the RECEIVING connector's own
 * document, never taken from a caller.
 */

import type { BatchSettlementEvmOffer } from './evm.js';
import type { BatchSettlementSvmOffer } from './svm.js';

/** A priced offer, on the chain its network names. */
export type BatchSettlementOffer =
  | { chain: 'evm'; offer: BatchSettlementEvmOffer }
  | { chain: 'solana'; offer: BatchSettlementSvmOffer };

/** One `batchSettlements` entry of `GET /ilp`: an offer's facts, without a price. */
export type BatchSettlementTerms =
  | {
      chain: 'evm';
      network: string;
      asset: string;
      payTo: string;
      extra: BatchSettlementEvmOffer['extra'];
    }
  | {
      chain: 'solana';
      network: string;
      asset: string;
      payTo: string;
      extra: BatchSettlementSvmOffer['extra'];
    };

/**
 * The `maxTimeoutSeconds` a connector puts on every greeting entry
 * (`connector_domain::x402::X402_MAX_TIMEOUT_SECONDS`). It bounds how long a
 * deposit authorization stays valid, so an offer priced from `GET /ilp` carries
 * the same one the greeting would have.
 */
export const CONNECTOR_MAX_TIMEOUT_SECONDS = 60;

/**
 * One greeting `accepts[]` entry, when it is a well-formed `batch-settlement`
 * offer on a chain this client pays from; `undefined` for anything else,
 * `toon-channel` included.
 */
export function parseBatchSettlementOffer(
  raw: unknown
): BatchSettlementOffer | undefined {
  const entry = asRecord(raw);
  if (!entry || entry['scheme'] !== 'batch-settlement') return undefined;
  const amount = entry['amount'];
  const maxTimeoutSeconds = entry['maxTimeoutSeconds'];
  if (typeof amount !== 'string' || !/^\d+$/.test(amount)) return undefined;
  if (!isPositiveInteger(maxTimeoutSeconds)) return undefined;

  const terms = parseBatchSettlementTerms({
    ...entry,
    ...(asRecord(entry['extra']) ?? {}),
  });
  return terms && offerFromTerms(terms, BigInt(amount), maxTimeoutSeconds);
}

/**
 * One `batchSettlements` entry of `GET /ilp`. The chain is the network's CAIP-2
 * namespace; every field that chain's open or deposit needs must be present.
 */
export function parseBatchSettlementTerms(
  raw: unknown
): BatchSettlementTerms | undefined {
  const r = asRecord(raw);
  if (!r) return undefined;
  const network = str(r['network']);
  const asset = str(r['asset']);
  const payTo = str(r['payTo']);
  const withdrawDelay = r['withdrawDelay'];
  if (!network || !asset || !payTo || !isPositiveInteger(withdrawDelay))
    return undefined;

  if (network.startsWith('eip155:')) {
    const receiverAuthorizer = str(r['receiverAuthorizer']);
    if (!receiverAuthorizer) return undefined;
    const name = str(r['name']);
    const version = str(r['version']);
    return {
      chain: 'evm',
      network,
      asset,
      payTo,
      extra: {
        receiverAuthorizer,
        withdrawDelay,
        ...(name !== undefined ? { name } : {}),
        ...(version !== undefined ? { version } : {}),
      },
    };
  }

  if (network.startsWith('solana:')) {
    const feePayer = str(r['feePayer']);
    const tokenProgram = str(r['tokenProgram']);
    const sponsorEndpoint = str(r['sponsorEndpoint']);
    const minDeposit = r['minDeposit'];
    if (!feePayer || !tokenProgram || !sponsorEndpoint) return undefined;
    if (typeof minDeposit !== 'string' || !/^\d+$/.test(minDeposit))
      return undefined;
    return {
      chain: 'solana',
      network,
      asset,
      payTo,
      extra: {
        feePayer,
        withdrawDelay,
        tokenProgram,
        minDeposit,
        sponsorEndpoint,
      },
    };
  }

  return undefined;
}

/** Price `terms` into the offer the greeting would carry for a route charging `amount`. */
export function offerFromTerms(
  terms: BatchSettlementTerms,
  amount: bigint,
  maxTimeoutSeconds: number = CONNECTOR_MAX_TIMEOUT_SECONDS
): BatchSettlementOffer {
  const common = {
    scheme: 'batch-settlement' as const,
    network: terms.network,
    amount: amount.toString(),
    asset: terms.asset,
    payTo: terms.payTo,
    maxTimeoutSeconds,
  };
  return terms.chain === 'evm'
    ? { chain: 'evm', offer: { ...common, extra: { ...terms.extra } } }
    : { chain: 'solana', offer: { ...common, extra: { ...terms.extra } } };
}

/**
 * The node's `batch-settlement` terms on the chain this client pays from — on
 * `network` when the caller names one — or `undefined` when there are none, in
 * which case the client pays over `toon-channel` exactly as it always has.
 */
export function chooseBatchSettlement(
  desc: { batchSettlements: BatchSettlementTerms[] },
  chain: 'evm' | 'solana',
  network?: string
): BatchSettlementTerms | undefined {
  return desc.batchSettlements.find(
    (t) => t.chain === chain && (network === undefined || t.network === network)
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}
