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
 * Everything here reads defensively: a malformed body yields an empty parse
 * rather than throwing, so a caller can fall back to reporting the plain 402.
 *
 * Carved out of the retired `Http402Client` (the h402 paid-fetch engine),
 * which is the only part of it 1.0 keeps.
 */

import type { PaymentTerms } from '../client/types.js';
import type { ConnectorChainSettlementTerms } from './ConnectorEdgeClient.js';
import { parseSettlementEntry } from './self-description.js';

// ─── x402 challenge types (documented wire contract above) ──────────────────

/**
 * The `extra` bag of an `accepts` entry — an open set of terms from the peer,
 * not a fixed contract. `session_lease_ttl_ms` (connector#722,
 * `session_registry::SESSION_LEASE_BACKSTOP_TTL`) is the one member this
 * client currently reads by name; everything else is preserved untouched
 * (issue #506) rather than stripped by a narrower type, so a future field
 * survives the round trip even before this package knows its name.
 */
export interface X402ChannelExtra {
  /**
   * The connector's session lease TTL in milliseconds — the value
   * `connector_client_edge::session_registry::SESSION_LEASE_BACKSTOP_TTL`
   * enforces, published so a consumer reads it instead of hardcoding a guess
   * (client-edge-spec §1.4). The connector spells it `sessionLeaseTtlMs`;
   * `session_lease_ttl_ms` is accepted too because this client asked for that
   * spelling for a while and a fixture may still carry it.
   */
  sessionLeaseTtlMs?: number;
  /** @deprecated snake_case alias — the wire spelling is `sessionLeaseTtlMs`. */
  session_lease_ttl_ms?: number;
  [key: string]: unknown;
}

/** A single parsed `accepts` entry that offers the `toon-channel` scheme. */
export interface ToonChannelAccept {
  /** Always `'toon-channel'` for a matched entry. */
  scheme: 'toon-channel';
  /** Optional chain key, e.g. `evm:base:8453` — informational. */
  network?: string;
  /** ILP destination address to pay (the connector route fronting the URL). */
  destination: string;
  /** Price in ILP base units. */
  amount: bigint;
  /** The connector's `POST /ilp` URL. */
  httpEndpoint: string;
  /** Whether the host accepts the BTP upgrade over the HTTP endpoint. */
  supportsUpgrade: boolean;
  /**
   * The carriage this route actually requires, when the greeting is the
   * wrong-transport refusal (`extra.requiredTransport`, `client-edge-spec.md`
   * §1.4 "Transport policy", issue #701).
   *
   * Present **only** on that refusal: a route whose transport policy is the
   * default `both` never sets it, and neither does an ordinary unpaid-request
   * greeting. So its presence is the signal — "the route exists, you reached
   * it over the wrong carriage" — and its absence is not a default of `http`.
   * The BTP mirror (an `F02` REJECT with the same terms as `payment-required`
   * protocolData, §1.9 step 3) carries the identical field.
   */
  requiredTransport?: 'http' | 'btp';
  /**
   * The entry's raw `extra` bag, preserved as-is. `undefined` when the entry
   * carried no `extra` at all — distinct from an `extra` that merely omits a
   * given key (issue #506).
   */
  extra?: X402ChannelExtra;
}

/** The parsed x402 402 body, with the selected `toon-channel` entry (if any). */
export interface ParsedX402Challenge {
  x402Version?: number;
  /** The first usable `toon-channel` accepts entry, or `undefined`. */
  toonChannel?: ToonChannelAccept;
}

// ─── x402 challenge parsing (defensive) ─────────────────────────────────────

/** First defined string among the given keys on `obj`. */
function readString(
  obj: Record<string, unknown>,
  keys: string[]
): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  }
  return undefined;
}

/** First parseable bigint among the given keys (string|number) on `obj`. */
function readAmount(
  obj: Record<string, unknown>,
  keys: string[]
): bigint | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'bigint') return v;
    if (typeof v === 'number' && Number.isFinite(v))
      return BigInt(Math.trunc(v));
    if (typeof v === 'string' && /^\d+$/.test(v.trim()))
      return BigInt(v.trim());
  }
  return undefined;
}

/**
 * Turn an `httpEndpoint` into something fetchable.
 *
 * The Rust connector emits a RELATIVE endpoint (`"/ilp"`), because the terms
 * describe an endpoint on the origin that answered. Resolved against the
 * resource URL it becomes the absolute `POST /ilp` URL this adapter needs. An
 * already-absolute endpoint is returned unchanged; a relative one with no base
 * to resolve against is passed through as before, so nothing that worked
 * previously stops working.
 */
function resolveEndpoint(
  endpoint: string | undefined,
  baseUrl: string | undefined
): string | undefined {
  if (!endpoint || !baseUrl) return endpoint;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(endpoint)) return endpoint;
  try {
    return new URL(endpoint, baseUrl).toString();
  } catch {
    return endpoint;
  }
}

/**
 * Parse a 402 `Response` body into a {@link ParsedX402Challenge}, selecting the
 * first usable `toon-channel` entry. Reads every field defensively; a malformed
 * body, a non-JSON body, or an entry missing its `destination`/`httpEndpoint`
 * yields `{ toonChannel: undefined }` so the caller falls back to the vanilla
 * 402 rather than throwing.
 */
export async function parseX402Challenge(
  response: Response
): Promise<ParsedX402Challenge> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {};
  }
  // `response.url` is the resource that answered 402 — the base a relative
  // `httpEndpoint` (which is what the Rust connector actually emits: `/ilp`)
  // has to be resolved against.
  return parseX402Body(body, response.url || undefined);
}

/**
 * Pure parser over an already-decoded x402 body (testable without a Response).
 *
 * `baseUrl`, when given, is the absolute URL of the resource that answered
 * `402`; a relative `httpEndpoint` is resolved against it. Omitting it keeps
 * the old behaviour of passing the endpoint through verbatim.
 */
export function parseX402Body(
  body: unknown,
  baseUrl?: string
): ParsedX402Challenge {
  if (typeof body !== 'object' || body === null) return {};
  const b = body as Record<string, unknown>;

  const version =
    typeof b['x402Version'] === 'number'
      ? (b['x402Version'] as number)
      : undefined;

  const accepts = Array.isArray(b['accepts'])
    ? (b['accepts'] as unknown[])
    : [];

  for (const raw of accepts) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const scheme = readString(entry, ['scheme']);
    if (scheme !== 'toon-channel') continue;

    // The Rust connector puts the ILP address, the endpoint and the price
    // under `extra` (`crates/connector-client-edge/src/lib.rs`, client-edge-spec
    // §1.4) — NOT at the entry's top level. `extra` is therefore read as a
    // first-class source, not a fallback: reading `payTo` instead only ever
    // worked because that connector happens to set it to the destination too,
    // which is a coincidence of today's code and not part of the contract.
    const rawExtra = entry['extra'];
    // Preserved verbatim on the returned entry below (issue #506) — `extra`
    // stays a first-class read source for the fields this adapter already
    // knows (destination/endpoint/price), via `extraForReads`.
    const extra: X402ChannelExtra | undefined =
      typeof rawExtra === 'object' && rawExtra !== null
        ? (rawExtra as X402ChannelExtra)
        : undefined;
    const extraForReads = extra ?? {};

    const destination =
      readString(extraForReads, ['ilpAddress', 'destination']) ??
      readString(entry, ['destination', 'ilpAddress', 'payTo']);
    const rawEndpoint =
      readString(entry, ['httpEndpoint', 'ilpEndpoint']) ??
      readString(extraForReads, ['httpEndpoint', 'endpoint']) ??
      readString(entry, ['endpoint']);
    const httpEndpoint = resolveEndpoint(rawEndpoint, baseUrl);
    const amount =
      readAmount(extraForReads, ['price', 'amount']) ??
      readAmount(entry, ['amount', 'price', 'maxAmountRequired']);

    // A usable entry MUST carry where to pay, how much, and how to reach /ilp.
    if (!destination || !httpEndpoint || amount === undefined) continue;

    const network = readString(entry, ['network', 'chain']);
    const supportsUpgrade =
      entry['supportsUpgrade'] === true || entry['upgradable'] === true;

    // `extra` is where the connector actually writes it
    // (`connector_domain::x402::X402ChannelExtra::required_transport`); the
    // entry's top level is read as a fallback only, matching how every other
    // field here tolerates the two placements. Anything other than the two
    // documented spellings is dropped rather than carried: a transport this
    // client cannot name is one it cannot select.
    const rawRequired =
      readString(extraForReads, ['requiredTransport']) ??
      readString(entry, ['requiredTransport']);
    const requiredTransport =
      rawRequired === 'http' || rawRequired === 'btp' ? rawRequired : undefined;

    return {
      ...(version !== undefined ? { x402Version: version } : {}),
      toonChannel: {
        scheme: 'toon-channel',
        ...(network !== undefined ? { network } : {}),
        destination,
        amount,
        httpEndpoint,
        supportsUpgrade,
        ...(requiredTransport !== undefined ? { requiredTransport } : {}),
        ...(extra !== undefined ? { extra } : {}),
      },
    };
  }

  return version !== undefined ? { x402Version: version } : {};
}

/**
 * Project a greeting onto {@link PaymentTerms} — the shape the client surface
 * reports a refusal with.
 *
 * The connector builds this document from the same `NodeFacts` its `GET /ilp`
 * self-description is built from (`connector_domain::x402::terms_body` takes
 * the node), so the two can never disagree (`self-description-spec.md` ND-11).
 * That is why `settlements` here is the SAME per-chain list `GET /ilp` carries
 * and is parsed by the same {@link parseSettlementEntry}: a caller that opens a
 * channel off a greeting and one that opens it off the self-description must
 * open the same channel.
 *
 * `undefined` when the body carries no usable `toon-channel` option at all —
 * a vanilla x402 challenge from something that is not a TOON connector.
 *
 * @param body the already-decoded `402` JSON (or the same bytes carried as a
 *   `payment-required` protocolData entry on the BTP carriage).
 * @param baseUrl the URL that answered, for resolving a relative `httpEndpoint`.
 */
export function parsePaymentTerms(
  body: unknown,
  baseUrl?: string
): PaymentTerms | undefined {
  const parsed = parseX402Body(body, baseUrl);
  const option = parsed.toonChannel;
  if (!option) return undefined;

  const extra = option.extra ?? {};
  const btpEndpoint = readString(extra, ['btpEndpoint']);
  const rawSettlements = extra['settlements'];
  const settlements = Array.isArray(rawSettlements)
    ? rawSettlements
        .map(parseSettlementEntry)
        .filter((s): s is ConnectorChainSettlementTerms => s !== undefined)
    : [];
  // The connector spells it `sessionLeaseTtlMs`; the snake_case alias is
  // accepted because this client asked for that spelling for a while.
  const ttl = extra.sessionLeaseTtlMs ?? extra.session_lease_ttl_ms;

  return {
    destination: option.destination,
    price: option.amount,
    httpEndpoint: option.httpEndpoint,
    ...(btpEndpoint !== undefined ? { btpEndpoint } : {}),
    ...(option.requiredTransport !== undefined
      ? { requiredTransport: option.requiredTransport }
      : {}),
    settlements,
    ...(typeof ttl === 'number' ? { sessionLeaseTtlMs: ttl } : {}),
    raw: body,
  };
}
