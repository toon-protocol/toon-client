/**
 * The x402 "payment required" greeting a connector answers an unpaid request
 * to a priced route with (`client-edge-spec.md` §1.4).
 *
 * `POST /ilp` answers `402` with an x402 v2 `PaymentRequired` JSON document —
 * repeated byte-for-byte, base64-encoded, in a `Payment-Required` response
 * header — and the BTP carriage answers the same bytes as a `payment-required`
 * protocolData entry beside an `F06` REJECT. One parser serves both, because
 * the document is identical on either carriage.
 *
 * Since connector ADR 0075 the document is **x402-valid throughout**:
 *
 *   - `accepts[]` holds only `batch-settlement` entries, one per chain the
 *     node settles on — what a deposit or sponsored open is built from;
 *   - TOON's own facts — the destination, the charge, the endpoint, the price —
 *     ride in x402 v2's extension slot, `extensions.toon.info`.
 *
 * A reader that finds no `accepts[]` entry must not treat the route as free.
 *
 * Everything here reads defensively: a malformed body yields an empty parse
 * rather than throwing, so a caller can fall back to reporting the plain 402.
 */

import {
  parseBatchSettlementOffer,
  type BatchSettlementOffer,
} from '../channel/batch-settlement/offers.js';
import type { PaymentTerms } from '../client/types.js';

/**
 * `extensions.toon.info`: TOON's own terms for the greeted request
 * (`connector_domain::x402::X402ToonTerms`), preserved as-is so a field this
 * package does not yet name survives the round trip (issue #506).
 */
export interface ToonTermsInfo {
  ilpAddress?: string;
  amount?: string;
  endpoint?: string;
  price?: string;
  pricePerKib?: string;
  ilpAddresses?: string[];
  btpEndpoint?: string;
  requiredTransport?: string;
  /**
   * The connector's session lease TTL in milliseconds
   * (`connector_client_edge::session_registry::SESSION_LEASE_BACKSTOP_TTL`),
   * published so a consumer reads it instead of hardcoding a guess.
   */
  sessionLeaseTtlMs?: number;
  [key: string]: unknown;
}

/** The greeting's TOON terms, read out of `extensions.toon.info`. */
export interface ToonGreeting {
  /** The ILP destination to pay — the connector route fronting the URL. */
  destination: string;
  /** What this request costs, base units. */
  amount: bigint;
  /** The connector's `POST /ilp` URL, resolved against the answering origin. */
  httpEndpoint: string;
  /**
   * The carriage this route requires, when the greeting is the wrong-transport
   * refusal (`client-edge-spec.md` §1.4 "Transport policy", issue #701).
   * Present **only** on that refusal, so its presence is the signal.
   */
  requiredTransport?: 'http' | 'btp';
  /** `extensions.toon.info`, preserved verbatim. */
  info: ToonTermsInfo;
}

/** The parsed x402 402 body. */
export interface ParsedX402Challenge {
  x402Version?: number;
  /** TOON's own terms, or `undefined` for a greeting from something that is not a TOON connector. */
  toon?: ToonGreeting;
  /** Every well-formed `batch-settlement` entry of `accepts[]`, one per chain. */
  batchSettlements: BatchSettlementOffer[];
}

// ─── x402 challenge parsing (defensive) ─────────────────────────────────────

/** First defined string among the given keys on `obj`. */
function readString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  }
  return undefined;
}

/** A parseable bigint (string | number), or `undefined`. */
function readAmount(value: unknown): bigint | undefined {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return BigInt(value.trim());
  return undefined;
}

/**
 * Turn an `endpoint` into something fetchable. The connector publishes a
 * RELATIVE one (`"/ilp"`), describing an endpoint on the origin that
 * answered; resolved against that origin it becomes the absolute `POST /ilp`
 * URL. An absolute one is returned unchanged.
 */
function resolveEndpoint(endpoint: string | undefined, baseUrl: string | undefined): string | undefined {
  if (!endpoint || !baseUrl) return endpoint;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(endpoint)) return endpoint;
  try {
    return new URL(endpoint, baseUrl).toString();
  } catch {
    return endpoint;
  }
}

/** Parse a 402 `Response` body into a {@link ParsedX402Challenge}. */
export async function parseX402Challenge(response: Response): Promise<ParsedX402Challenge> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { batchSettlements: [] };
  }
  // `response.url` is the resource that answered 402 — the base a relative
  // endpoint has to be resolved against.
  return parseX402Body(body, response.url || undefined);
}

/**
 * Pure parser over an already-decoded x402 body.
 *
 * `baseUrl`, when given, is the absolute URL of the resource that answered
 * `402`; a relative endpoint is resolved against it.
 */
export function parseX402Body(body: unknown, baseUrl?: string): ParsedX402Challenge {
  if (typeof body !== 'object' || body === null) return { batchSettlements: [] };
  const b = body as Record<string, unknown>;
  const version = typeof b['x402Version'] === 'number' ? (b['x402Version'] as number) : undefined;

  const accepts = Array.isArray(b['accepts']) ? (b['accepts'] as unknown[]) : [];
  const batchSettlements = accepts
    .map(parseBatchSettlementOffer)
    .filter((o): o is BatchSettlementOffer => o !== undefined);

  const toon = readToonGreeting(b, baseUrl);
  return {
    ...(version !== undefined ? { x402Version: version } : {}),
    ...(toon !== undefined ? { toon } : {}),
    batchSettlements,
  };
}

/** `extensions.toon.info`, when it names at least where to pay, how much, and how to reach it. */
function readToonGreeting(
  body: Record<string, unknown>,
  baseUrl: string | undefined
): ToonGreeting | undefined {
  const extensions = body['extensions'];
  if (typeof extensions !== 'object' || extensions === null) return undefined;
  const toon = (extensions as Record<string, unknown>)['toon'];
  if (typeof toon !== 'object' || toon === null) return undefined;
  const info = (toon as Record<string, unknown>)['info'];
  if (typeof info !== 'object' || info === null) return undefined;
  const record = info as ToonTermsInfo;

  const destination = readString(record, ['ilpAddress']);
  const amount = readAmount(record['amount']) ?? readAmount(record['price']);
  const httpEndpoint = resolveEndpoint(readString(record, ['endpoint', 'httpEndpoint']), baseUrl);
  if (destination === undefined || amount === undefined || httpEndpoint === undefined) {
    return undefined;
  }
  const required = readString(record, ['requiredTransport']);
  return {
    destination,
    amount,
    httpEndpoint,
    ...(required === 'http' || required === 'btp' ? { requiredTransport: required } : {}),
    info: record,
  };
}

/**
 * Project a greeting onto {@link PaymentTerms} — the shape the client surface
 * reports a refusal with.
 *
 * The connector builds this document from the same `NodeFacts` its `GET /ilp`
 * self-description is built from, so the two can never disagree
 * (`self-description-spec.md` ND-11): `batchSettlements` here are the same
 * per-chain terms, priced for this request.
 *
 * `undefined` when the body carries no TOON terms at all — a vanilla x402
 * challenge from something that is not a TOON connector.
 */
export function parsePaymentTerms(body: unknown, baseUrl?: string): PaymentTerms | undefined {
  const parsed = parseX402Body(body, baseUrl);
  const toon = parsed.toon;
  if (!toon) return undefined;
  const btpEndpoint = readString(toon.info, ['btpEndpoint']);
  const ttl = toon.info.sessionLeaseTtlMs;
  return {
    destination: toon.destination,
    price: toon.amount,
    httpEndpoint: toon.httpEndpoint,
    ...(btpEndpoint !== undefined ? { btpEndpoint } : {}),
    ...(toon.requiredTransport !== undefined ? { requiredTransport: toon.requiredTransport } : {}),
    batchSettlements: parsed.batchSettlements,
    ...(typeof ttl === 'number' ? { sessionLeaseTtlMs: ttl } : {}),
    raw: body,
  };
}
