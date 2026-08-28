/**
 * Ask a connector who it is, what it charges, and what a path would cost — the
 * steps that have to happen BEFORE a packet can be formed at all.
 *
 * ADR 0018 makes holding the terminating connector's public key a
 * precondition of forming a packet: `Prepare.data` is sealed to that key, and
 * sealing to the wrong one is a confidentiality failure, not a delivery
 * failure. ADR 0022 says the connector *answers* — it never announces — so
 * every fact here is fetched from the connector's own client edge
 * (`docs/protocol/client-edge-spec.md`), never pushed to this client and never
 * read out of a preset.
 *
 * - `GET /ilp` → the node self-description: addresses, endpoints, sealing key,
 *   per-chain settlement facts, route prices, required carriage. The one
 *   document a stranger needs, and what replaced peer discovery entirely
 *   ({@link describe}).
 * - `GET /ilp/identity` → `{ "keyId": "...", "publicKey": "0x04..." }` — the
 *   uncompressed secp256k1 key, 65 bytes, `0x`-prefixed hex (§1.7). The
 *   self-description carries the same key; this endpoint predates it and is
 *   the fallback for a node whose document omits `edgeIdentity`.
 * - `GET /ilp/routes/price?destination=<ILP address>` →
 *   `{ "destination": "...", "price": 100 }`, or `404` when no configured
 *   route matches (§1.7).
 * - `POST /ilp` with no claim → the x402 greeting for a route ({@link terms},
 *   §1.4). Free by the wire's own contract.
 * - `POST /ilp/probe` → what a path costs, learned without paying for it
 *   ({@link probe}, §1.6). The one call here that needs a claim, and the claim
 *   identifies rather than pays.
 * - `POST /ilp/claim-state` → the credited position of channels this client
 *   controls ({@link getClaimState}, §1.10).
 *
 * All but the last two are unauthenticated, and none of them changes state.
 *
 * ─── What this module refuses to do ────────────────────────────────────────
 * Unlike the 402-challenge parser next door (which degrades gracefully so an
 * unrecognised connector shape falls back to the vanilla 402), an identity is
 * parsed STRICTLY. A key that is the wrong length, not `0x04`-prefixed, or not
 * valid hex is refused with a distinguishable error rather than carried
 * forward: a half-understood key would be sealed to, and the failure would be
 * silent. There is no "best effort" reading of a public key.
 *
 * Pure transport + parsing: no keys are held, nothing is signed, and the only
 * state is the identity cache.
 */

import { NetworkError, ToonClientError, ConnectorError } from '../client/errors.js';
import {
  ILPPacketType,
  deserializeIlpPacket,
  serializeIlpPrepare,
} from '../btp/protocol.js';
import type { X402ChannelExtra } from './x402.js';
import {
  parseSelfDescription,
  type NodeSelfDescription,
} from './self-description.js';
import {
  mapIlpResponse,
  resolveExecutionCondition,
  resolveExpiresAt,
  type IlpSendParams,
} from '../ilp/ilp-send.js';
import type { IlpSendResult } from '../ilp/types.js';
import { readResponseMeta } from '../http/HttpIlpClient.js';
import { toBase64, encodeUtf8, fromBase64 } from '../utils/binary.js';
import { assertValidCondition, isZeroCondition } from '../utils/condition.js';

// ─── Identity ───────────────────────────────────────────────────────────────

/** The terminating connector's own identity, as reported by `GET /ilp/identity`. */
export interface ConnectorIdentity {
  /** The key id identifying the key (opaque to this client). */
  keyId: string;
  /** The uncompressed secp256k1 public key — exactly 65 raw bytes, leading `0x04`. */
  publicKey: Uint8Array;
  /** The key exactly as reported, `0x`-prefixed lowercase hex (65 bytes → 132 chars). */
  publicKeyHex: string;
  /** The normalized client-edge base URL this identity was read from. */
  endpoint: string;
}

/**
 * The channel-opening facts a settling connector carries in its x402
 * greeting (connector #617): everything a buyer needs to OPEN a channel
 * with the node, learned by ASKING (ADR 0022) rather than from a
 * kind:10032 announce the Rust fleet never makes.
 */
export interface ConnectorSettlementTerms {
  /** `evm:<chainId>` — the chain the node's settlement backend runs on. */
  chain: string;
  /** The on-chain counterparty a buyer opens a channel WITH. */
  settlementAddress: string;
  /** The stable TokenNetworkRegistry factory address. */
  tokenNetworkRegistry: string;
  /** The resolved TokenNetwork — the EIP-712 verifyingContract. */
  tokenNetwork: string;
  tokenAddress: string;
  /** Informational; claims are already in base units. */
  decimals: number;
}

/**
 * The Solana twin of {@link ConnectorSettlementTerms} (connector #632): what
 * an unaffiliated buyer needs to open a channel against a Solana settlement
 * backend's deployed `payment-channel` program instance.
 */
export interface ConnectorSolanaSettlementTerms {
  /** Always `'solana'` — unlike EVM there is no chain id to append. */
  chain: string;
  /** The on-chain counterparty a buyer opens a channel WITH, base58. */
  settlementAddress: string;
  /** The deployed `payment-channel` program instance, base58. */
  programId: string;
  /** The SPL mint every channel this backend opens settles in, base58. */
  tokenAddress: string;
  /** Informational; claims are already in base units. */
  decimals: number;
}

/**
 * One chain's entry in the x402 greeting's per-chain `settlements` list
 * (connector #632). `kind` is added by this parser, not present on the wire
 * — the wire is untagged, disambiguated structurally (`tokenNetworkRegistry`
 * names EVM, `programId` names Solana).
 */
export type ConnectorChainSettlementTerms =
  | ({ kind: 'evm' } & ConnectorSettlementTerms)
  | ({ kind: 'solana' } & ConnectorSolanaSettlementTerms);

/**
 * A route's terms as the x402 greeting states them: the price, plus (from a
 * settling node) the channel-opening facts. `settlement` is absent exactly
 * when the node has no settlement backend — the wire's own shape. `settlements`
 * is the additive per-chain list (connector #632): one entry per chain the
 * node settles on, including the same EVM entry `settlement` already carries.
 * Absent — not an empty array — on a node with no settlement backend, or one
 * still answering the pre-#632 greeting shape.
 */
export interface ConnectorRouteTerms {
  destination: string;
  price: string;
  settlement?: ConnectorSettlementTerms;
  settlements?: ConnectorChainSettlementTerms[];
  /**
   * The `toon-channel` accepts entry's raw `extra` bag, preserved as-is
   * (issue #509 — the same posture #506/#507 established for
   * `Http402Client`'s parser, e.g. `extra.session_lease_ttl_ms`,
   * connector#722). `undefined` when the entry carried no `extra` at all —
   * distinct from an `extra` that merely omits a given key.
   */
  extra?: X402ChannelExtra;
}

/** What a locally-terminated route costs, as reported by `GET /ilp/routes/price`. */
export interface ConnectorRoutePrice {
  /** The ILP destination that was asked about (echoed by the connector). */
  destination: string;
  /** The price in ILP base units of the route `destination` matched. */
  price: bigint;
}

// ─── Claim state (client-edge-spec.md §1.10, connector #693) ──────────────

/**
 * One `POST /ilp/claim-state` request entry: proof of ownership of a channel
 * this client controls, via a signature over a challenge distinct from a
 * real claim's balance-proof (never reusable as one). `signature` is
 * `EvmSigner.signClaimStateChallenge`'s `0x`-prefixed 65-byte hex for `evm`,
 * `SolanaSigner.signClaimStateChallenge`'s base64 64-byte Ed25519 for
 * `solana`.
 */
export type ClaimStateRequestEntry =
  | { blockchain: 'evm'; channelId: string; expires: number; signature: string }
  | {
      blockchain: 'solana';
      channelAccount: string;
      expires: number;
      signature: string;
    };

/**
 * The credited/spendable position of one channel this client asked about —
 * the runway source of truth (toon-meta#261/#262 decision 9). Money fields
 * are decimal strings (never a bare JS number, which cannot represent a
 * value past 2^53 exactly).
 */
export interface ClaimStateOk {
  blockchain: 'evm' | 'solana';
  channelId?: string;
  channelAccount?: string;
  ok: true;
  /** On-chain deposit, or `null` for a channel this connector only DECLARED. */
  depositTotal: string | null;
  /** The channel's watermark; `"0"` if this connector has never accepted a claim. */
  cumulativeClaimed: string;
  /** `depositTotal - cumulativeClaimed`; `null` exactly when `depositTotal` is. */
  available: string | null;
  nonce: number;
  /**
   * Best-effort and non-durable (unlike every other field here): `null`
   * means "unknown", NEVER "never claimed" — see client-edge-spec.md §1.10.
   */
  lastClaimTime: number | null;
}

/**
 * A failed claim-state entry. `error` is deliberately collapsed to two
 * causes (unlike a claim's own refusal taxonomy) so a caller learns nothing
 * about a channel it does not control: `"unverified"` covers "no such
 * channel" and "bad signature" identically.
 */
export interface ClaimStateFailed {
  blockchain: 'evm' | 'solana';
  channelId?: string;
  channelAccount?: string;
  ok: false;
  error: 'expired' | 'unverified';
}

export type ClaimStateResult = ClaimStateOk | ClaimStateFailed;

/**
 * Every distinguishable way asking a connector for its identity or terms can
 * fail. Each code names exactly one cause; there is no catch-all, because the
 * caller's next move differs per cause (retry a transport failure; never
 * retry a malformed key).
 */
export type ConnectorEdgeErrorCode =
  /** Non-2xx from `GET /ilp/identity`. */
  | 'IDENTITY_HTTP_STATUS'
  /** `GET /ilp/identity` answered 2xx with a body that is not the documented object. */
  | 'IDENTITY_MALFORMED'
  /** `publicKey` is present but is not `0x`-prefixed even-length hex. */
  | 'IDENTITY_KEY_NOT_HEX'
  /** `publicKey` decodes, but not to exactly 65 bytes. */
  | 'IDENTITY_KEY_LENGTH'
  /** `publicKey` is 65 bytes but does not start with the SEC1 uncompressed tag `0x04`. */
  | 'IDENTITY_KEY_NOT_UNCOMPRESSED'
  /** Non-2xx, non-404 from `GET /ilp/routes/price` (404 is not an error — see below). */
  | 'ROUTE_PRICE_HTTP_STATUS'
  /** `GET /ilp/routes/price` answered 2xx with a body that is not the documented object. */
  | 'ROUTE_PRICE_MALFORMED'
  /** A destination that cannot be put in a query string was asked about. */
  | 'INVALID_DESTINATION'
  /** A 402 greeting whose body is not the documented x402 shape (or whose
   *  optional `settlement` facts are present but malformed — refused rather
   *  than silently dropped, since they would be opened AGAINST). */
  | 'TERMS_MALFORMED'
  /** Non-2xx from `POST /ilp/claim-state`. */
  | 'CLAIM_STATE_HTTP_STATUS'
  /** `POST /ilp/claim-state` answered 2xx with a body that is not the documented shape. */
  | 'CLAIM_STATE_MALFORMED'
  /** Non-2xx, non-429 from `GET /ilp` (the node self-description). */
  | 'SELF_DESCRIPTION_HTTP_STATUS'
  /** `GET /ilp` answered 2xx with a body that is not JSON at all. */
  | 'SELF_DESCRIPTION_MALFORMED'
  /**
   * `GET /ilp` answered `429`: the node's unresolvable-lookup budget is spent.
   *
   * Its own code, not folded into {@link SELF_DESCRIPTION_HTTP_STATUS},
   * because it is the one self-description failure that is purely temporal —
   * the same request succeeds once the shaper drains. The connector runs this
   * endpoint through the shaper that already guards chain lookups rather than
   * a limiter of its own (connector ADR 0050), so the bucket is shared: a
   * flood of channel resolutions can spend the budget a description request
   * then finds empty. Back off and re-ask; never re-derive the document from
   * a preset.
   */
  | 'SELF_DESCRIPTION_BUDGETED'
  /** `POST /ilp/probe` answered a non-2xx, non-403 status. */
  | 'PROBE_HTTP_STATUS'
  /**
   * `POST /ilp/probe` answered `403`.
   *
   * Deliberately distinct from a `401` (`IDENTITY_*`/transport auth): the
   * sender may be perfectly well authenticated and simply not *authorized to
   * probe* (`client-edge-spec.md` §1.6). It means one of exactly two things —
   * this connector recognizes no payment channel of the sender's, or the
   * sender is over its per-channel probe rate limit — and the remedies differ
   * from an auth failure's entirely: open (or pay on) a channel, or wait.
   */
  | 'PROBE_FORBIDDEN';

/**
 * A refusal to carry a connector's answer forward. Distinct from
 * {@link NetworkError} (which this module throws for a transport failure), so
 * "the connector is unreachable" and "the connector answered something I will
 * not seal to" are never confused.
 */
export class ConnectorEdgeError extends ToonClientError {
  /** Narrowed from `ToonClientError`'s `string`; type-only, no runtime field. */
  declare readonly code: ConnectorEdgeErrorCode;

  constructor(message: string, code: ConnectorEdgeErrorCode, cause?: Error) {
    super(message, code, cause);
    this.name = 'ConnectorEdgeError';
  }
}

// ─── URL handling ───────────────────────────────────────────────────────────

/**
 * Normalize any client-edge URL a caller already holds into the base the
 * `/ilp/*` routes hang off.
 *
 * Callers reach this module holding whatever the x402 offer or their config
 * gave them — `https://apex.example`, `https://apex.example/`, or the
 * `POST /ilp` endpoint `https://apex.example/ilp` itself. All three name the
 * same client edge, so all three normalize to `https://apex.example`.
 */
export function connectorEdgeBaseUrl(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch (error) {
    throw new ConnectorEdgeError(
      `not a valid connector endpoint URL: ${endpoint}`,
      'IDENTITY_MALFORMED',
      error instanceof Error ? error : undefined
    );
  }
  // Drop a trailing `/ilp` (the POST endpoint) and any trailing slashes.
  let path = url.pathname.replace(/\/+$/, '');
  if (path.endsWith('/ilp')) path = path.slice(0, -'/ilp'.length);
  url.pathname = path;
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

// ─── Parsing (pure, exported so the wire shape is testable without a server) ─

const UNCOMPRESSED_KEY_BYTES = 65;
const SEC1_UNCOMPRESSED_TAG = 0x04;

/**
 * Decode a `0x`-prefixed hex public key into its 65 raw bytes, refusing
 * anything that is not exactly one uncompressed secp256k1 key.
 */
export function decodeConnectorPublicKey(publicKeyHex: string): Uint8Array {
  const trimmed = publicKeyHex.trim();
  if (!/^0x[0-9a-fA-F]*$/.test(trimmed) || trimmed.length % 2 !== 0) {
    throw new ConnectorEdgeError(
      `connector publicKey is not 0x-prefixed hex: ${publicKeyHex}`,
      'IDENTITY_KEY_NOT_HEX'
    );
  }
  const hex = trimmed.slice(2);
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  if (bytes.length !== UNCOMPRESSED_KEY_BYTES) {
    throw new ConnectorEdgeError(
      `connector publicKey must be ${UNCOMPRESSED_KEY_BYTES} bytes, got ${bytes.length}`,
      'IDENTITY_KEY_LENGTH'
    );
  }
  const tag = bytes[0] ?? 0;
  if (tag !== SEC1_UNCOMPRESSED_TAG) {
    throw new ConnectorEdgeError(
      `connector publicKey must be SEC1-uncompressed (0x04 prefix), got 0x${tag.toString(16).padStart(2, '0')}`,
      'IDENTITY_KEY_NOT_UNCOMPRESSED'
    );
  }
  return bytes;
}

/**
 * Parse an already-decoded `GET /ilp/identity` body. Exported so the shape the
 * connector actually emits can be pinned without standing up a server.
 */
export function parseConnectorIdentity(
  body: unknown,
  endpoint: string
): ConnectorIdentity {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ConnectorEdgeError(
      'GET /ilp/identity did not answer a JSON object',
      'IDENTITY_MALFORMED'
    );
  }
  const record = body as Record<string, unknown>;
  const keyId = record['keyId'];
  const publicKeyHex = record['publicKey'];
  if (typeof keyId !== 'string' || keyId.length === 0) {
    throw new ConnectorEdgeError(
      'GET /ilp/identity answered without a keyId',
      'IDENTITY_MALFORMED'
    );
  }
  if (typeof publicKeyHex !== 'string' || publicKeyHex.length === 0) {
    throw new ConnectorEdgeError(
      'GET /ilp/identity answered without a publicKey',
      'IDENTITY_MALFORMED'
    );
  }
  return {
    keyId,
    publicKey: decodeConnectorPublicKey(publicKeyHex),
    publicKeyHex: publicKeyHex.trim().toLowerCase(),
    endpoint,
  };
}

/** Parse an already-decoded `GET /ilp/routes/price` 200 body. */
export function parseConnectorRoutePrice(body: unknown): ConnectorRoutePrice {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ConnectorEdgeError(
      'GET /ilp/routes/price did not answer a JSON object',
      'ROUTE_PRICE_MALFORMED'
    );
  }
  const record = body as Record<string, unknown>;
  const destination = record['destination'];
  const price = record['price'];
  if (typeof destination !== 'string' || destination.length === 0) {
    throw new ConnectorEdgeError(
      'GET /ilp/routes/price answered without a destination',
      'ROUTE_PRICE_MALFORMED'
    );
  }
  if (
    typeof price !== 'number' ||
    !Number.isFinite(price) ||
    !Number.isInteger(price) ||
    price < 0
  ) {
    throw new ConnectorEdgeError(
      `GET /ilp/routes/price answered a non-integer price: ${String(price)}`,
      'ROUTE_PRICE_MALFORMED'
    );
  }
  return { destination, price: BigInt(price) };
}

/** A required-string reader, refusing a missing/wrong-typed field by name. */
function claimStr(
  e: Record<string, unknown>,
  key: string,
  entryIndex: number
): string {
  const value = e[key];
  if (typeof value !== 'string') {
    throw new ConnectorEdgeError(
      `claim-state channel entry ${entryIndex} lacks a string '${key}'`,
      'CLAIM_STATE_MALFORMED'
    );
  }
  return value;
}

/** A nullable-string reader: `null` passes through, anything else must be a string. */
function claimNullableStr(
  e: Record<string, unknown>,
  key: string,
  entryIndex: number
): string | null {
  const value = e[key];
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new ConnectorEdgeError(
      `claim-state channel entry ${entryIndex}'s '${key}' is neither a string nor null`,
      'CLAIM_STATE_MALFORMED'
    );
  }
  return value;
}

/** Parse one already-object-checked claim-state response entry. */
function parseClaimStateEntry(raw: unknown, entryIndex: number): ClaimStateResult {
  if (typeof raw !== 'object' || raw === null) {
    throw new ConnectorEdgeError(
      `claim-state channel entry ${entryIndex} is not an object`,
      'CLAIM_STATE_MALFORMED'
    );
  }
  const e = raw as Record<string, unknown>;
  const blockchain = e['blockchain'];
  if (blockchain !== 'evm' && blockchain !== 'solana') {
    throw new ConnectorEdgeError(
      `claim-state channel entry ${entryIndex} names neither 'evm' nor 'solana'`,
      'CLAIM_STATE_MALFORMED'
    );
  }
  const channelId = typeof e['channelId'] === 'string' ? e['channelId'] : undefined;
  const channelAccount =
    typeof e['channelAccount'] === 'string' ? e['channelAccount'] : undefined;
  const identity = {
    ...(channelId !== undefined ? { channelId } : {}),
    ...(channelAccount !== undefined ? { channelAccount } : {}),
  };

  if (e['ok'] === false) {
    const error = e['error'];
    if (error !== 'expired' && error !== 'unverified') {
      throw new ConnectorEdgeError(
        `claim-state channel entry ${entryIndex} has an undocumented error: ${String(error)}`,
        'CLAIM_STATE_MALFORMED'
      );
    }
    return { blockchain, ...identity, ok: false, error };
  }
  if (e['ok'] !== true) {
    throw new ConnectorEdgeError(
      `claim-state channel entry ${entryIndex} lacks a boolean 'ok'`,
      'CLAIM_STATE_MALFORMED'
    );
  }

  const nonce = e['nonce'];
  if (typeof nonce !== 'number' || !Number.isInteger(nonce) || nonce < 0) {
    throw new ConnectorEdgeError(
      `claim-state channel entry ${entryIndex} has a non-integer nonce`,
      'CLAIM_STATE_MALFORMED'
    );
  }
  const lastClaimTime = e['lastClaimTime'];
  if (
    lastClaimTime !== null &&
    (typeof lastClaimTime !== 'number' || !Number.isInteger(lastClaimTime))
  ) {
    throw new ConnectorEdgeError(
      `claim-state channel entry ${entryIndex}'s lastClaimTime is neither an integer nor null`,
      'CLAIM_STATE_MALFORMED'
    );
  }

  return {
    blockchain,
    ...identity,
    ok: true,
    depositTotal: claimNullableStr(e, 'depositTotal', entryIndex),
    cumulativeClaimed: claimStr(e, 'cumulativeClaimed', entryIndex),
    available: claimNullableStr(e, 'available', entryIndex),
    nonce,
    lastClaimTime,
  };
}

/**
 * Parse an already-decoded `POST /ilp/claim-state` body. Exported so the wire
 * shape is testable without a server. Refuses a body that is not the
 * documented `{ channels: [...] }` object, or any entry within it that is
 * not the documented ok/failed shape — a half-understood credited balance
 * would misreport an agent's runway, which is the one thing this endpoint
 * exists to get right (toon-meta#262 decision 9).
 */
export function parseClaimStateResponse(body: unknown): ClaimStateResult[] {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ConnectorEdgeError(
      'POST /ilp/claim-state did not answer a JSON object',
      'CLAIM_STATE_MALFORMED'
    );
  }
  const channels = (body as Record<string, unknown>)['channels'];
  if (!Array.isArray(channels)) {
    throw new ConnectorEdgeError(
      "POST /ilp/claim-state answered without a 'channels' array",
      'CLAIM_STATE_MALFORMED'
    );
  }
  return channels.map((entry, i) => parseClaimStateEntry(entry, i));
}

// ─── Client ─────────────────────────────────────────────────────────────────

export interface ConnectorEdgeClientConfig {
  /** HTTP fetch implementation. Default: global `fetch`. Injectable for tests. */
  fetch?: typeof fetch;
  /** Per-request timeout in milliseconds. Default 10_000. */
  timeout?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Separator between a client-edge base URL and an ILP destination in a price
 * cache key. NUL can appear in neither, so no pair can be spelled two ways
 * and no two pairs can collide.
 */
const PRICE_KEY_SEPARATOR = '\u0000';

/** Cache key for one (client edge, destination) pair. */
function priceCacheKey(base: string, destination: string): string {
  return `${base}${PRICE_KEY_SEPARATOR}${destination}`;
}

/**
 * The prefix every key for `base` shares — `priceCacheKey`'s own output for
 * an empty destination, so the two cannot drift into disagreeing about the
 * separator. They once did, and the endpoint-wide invalidation below then
 * silently matched nothing.
 */
function priceCacheKeyPrefix(base: string): string {
  return priceCacheKey(base, '');
}

/**
 * Asks connectors for their identity and their terms, caching each identity
 * per client-edge endpoint and each route price per (endpoint, destination).
 *
 * The cache is per endpoint rather than per client instance because a sender
 * routinely speaks to several connectors, and re-fetching a key per packet
 * would put a network round trip in front of every send. Nothing here expires
 * on a timer: an operator key rotation, or a route being repriced, is a
 * deliberate event, so {@link invalidateIdentity} / {@link invalidateRoutePrice}
 * are how a stale answer is dropped.
 *
 * A price is cached the same way and for the same reason (toon-client#452):
 * under ADR 0020 a route's price is FLAT — one handler, one price — so it does
 * not vary with what is being sent, and asking again per packet would buy
 * nothing but latency.
 */
export class ConnectorEdgeClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeout: number;
  private readonly identities = new Map<string, Promise<ConnectorIdentity>>();
  private readonly prices = new Map<
    string,
    Promise<ConnectorRoutePrice | null>
  >();
  private readonly descriptions = new Map<
    string,
    Promise<NodeSelfDescription>
  >();

  constructor(config: ConnectorEdgeClientConfig = {}) {
    this.fetchImpl = config.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * The terminating connector's public key, fetched once per endpoint.
   *
   * `endpoint` MUST already be the TERMINATING connector's client edge, not
   * merely whatever origin a caller is about to POST an ILP packet to —
   * those are the same machine for most routes today, but never for a
   * forwarded prefix (ADR 0022, toon-client#526). This method trusts
   * `endpoint` and fetches exactly that origin's `/ilp/identity`; resolving
   * a destination address to its terminator first is the caller's job.
   *
   * @param endpoint the TERMINATING connector's client-edge URL
   *   (`https://apex`, `https://apex/ilp`) — already resolved from the
   *   destination, never assumed to be the posting edge.
   * @param options `forceRefresh` bypasses (and replaces) the cache entry.
   */
  async getIdentity(
    endpoint: string,
    options: { forceRefresh?: boolean } = {}
  ): Promise<ConnectorIdentity> {
    const base = connectorEdgeBaseUrl(endpoint);
    if (options.forceRefresh) this.identities.delete(base);

    const cached = this.identities.get(base);
    if (cached) return cached;

    // Cache the in-flight promise so concurrent senders share one round trip;
    // drop it again on failure so a transient error is not cached forever.
    const inFlight = this.fetchIdentity(base).catch((error: unknown) => {
      this.identities.delete(base);
      throw error;
    });
    this.identities.set(base, inFlight);
    return inFlight;
  }

  /**
   * Drop a cached identity — one endpoint's, or every endpoint's when
   * `endpoint` is omitted. The way to react to a key rotation.
   */
  invalidateIdentity(endpoint?: string): void {
    if (endpoint === undefined) {
      this.identities.clear();
      return;
    }
    this.identities.delete(connectorEdgeBaseUrl(endpoint));
  }

  /** Whether an identity for `endpoint` is already held (no request is made). */
  hasCachedIdentity(endpoint: string): boolean {
    return this.identities.has(connectorEdgeBaseUrl(endpoint));
  }

  /**
   * The node's own self-description — `GET /ilp`, the one free, unauthenticated
   * document that carries every fact needed to transact with it
   * (`client-edge-spec.md` §1.7's siblings, connector ADR 0050): the addresses
   * it answers to, the endpoints it answers on, the key a packet is sealed to,
   * the per-chain channel-opening facts, its route prices, and — when its own
   * routes agree on one — the carriage it requires.
   *
   * This is what replaced peer discovery. A 1.0 client asks the connector it
   * is configured against instead of subscribing to a relay for announcements
   * the Rust fleet never makes (ADR 0022: a connector answers, it never
   * announces; ADR 0046 removed the announce).
   *
   * Cached per client-edge endpoint for the same reason an identity is: a
   * sender speaks to a connector many times per session and the document
   * changes only on an operator action. It is generated from live state on
   * every request the connector serves, though — a route written through the
   * operator surface shows up in the next answer — so a caller that has reason
   * to believe the node changed passes `forceRefresh`, and
   * {@link invalidateDescription} drops a cached one outright.
   *
   * @param endpoint the connector's client-edge URL (`https://apex`,
   *   `https://apex/ilp` — both normalize to the same base).
   * @param options `forceRefresh` bypasses (and replaces) the cache entry.
   * @throws {NetworkError} the connector could not be reached.
   * @throws {ConnectorEdgeError} `SELF_DESCRIPTION_BUDGETED` when the node's
   *   lookup budget is spent (`429` — retry later), `SELF_DESCRIPTION_HTTP_STATUS`
   *   for any other non-2xx, `SELF_DESCRIPTION_MALFORMED` for a non-JSON body.
   */
  async describe(
    endpoint: string,
    options: { forceRefresh?: boolean } = {}
  ): Promise<NodeSelfDescription> {
    const base = connectorEdgeBaseUrl(endpoint);
    if (options.forceRefresh) this.descriptions.delete(base);

    const cached = this.descriptions.get(base);
    if (cached) return cached;

    // Cache the in-flight promise so concurrent callers share one round trip;
    // drop it again on failure so neither a transport error nor an exhausted
    // lookup budget — the most transient failure this endpoint has — is
    // cached as though it were the node's answer.
    const inFlight = this.fetchDescription(base).catch((error: unknown) => {
      this.descriptions.delete(base);
      throw error;
    });
    this.descriptions.set(base, inFlight);
    return inFlight;
  }

  /**
   * Drop a cached self-description — one endpoint's, or every endpoint's when
   * `endpoint` is omitted. The way to react to an operator changing a node.
   */
  invalidateDescription(endpoint?: string): void {
    if (endpoint === undefined) {
      this.descriptions.clear();
      return;
    }
    this.descriptions.delete(connectorEdgeBaseUrl(endpoint));
  }

  /** Whether a self-description for `endpoint` is already held (no request is made). */
  hasCachedDescription(endpoint: string): boolean {
    return this.descriptions.has(connectorEdgeBaseUrl(endpoint));
  }

  /**
   * Learn what a path costs without paying for it: `POST /ilp/probe`
   * (`client-edge-spec.md` §1.6, connector ADR 0011).
   *
   * Request body and response framing are `POST /ilp`'s exactly — the same OER
   * PREPARE in, the same `200` + OER FULFILL/REJECT out — and the answer is
   * read through the same {@link mapIlpResponse} the paying carriages use, so
   * a probe's outcome and a write's outcome cannot be shaped differently. What
   * differs is the gate in front and that nothing is charged.
   *
   * The `claim` **identifies rather than pays**. It runs §1.3's gate in full
   * against a price of `0`, so possession of the channel is proven and a
   * replay is still refused, but no value need advance: a sender probes by
   * reissuing at the same cumulative amount with a fresh nonce. Passing a
   * claim that DOES advance value is legal and simply spends a nonce for
   * nothing.
   *
   * The whole point is the answer's `accumulatedCost`: a destination this
   * connector terminates is answered `F03` carrying that route's price rather
   * than being delivered (free traversal is all a probe buys — it does not
   * also buy the work behind a priced route), and a destination beyond it is
   * routed normally, so what comes back is one figure covering every hop's fee
   * plus the terminating route's price.
   *
   * @throws {NetworkError} the connector could not be reached.
   * @throws {ConnectorEdgeError} `PROBE_FORBIDDEN` on `403` — no channel this
   *   connector recognizes, or over the probe rate limit; never confuse it
   *   with a `401`, which is a failure to authenticate rather than a refusal
   *   to authorize.
   */
  async probe(
    endpoint: string,
    params: IlpSendParams,
    claim: Record<string, unknown>
  ): Promise<IlpSendResult> {
    const base = connectorEdgeBaseUrl(endpoint);
    const url = `${base}/ilp/probe`;

    // Same condition discipline as the paying transports: a non-zero
    // condition must be exactly 32 bytes, or the OER serializer would
    // silently zero-fill it and downgrade the packet to the unverified class.
    const condition = resolveExecutionCondition(params.executionCondition);
    if (condition !== undefined && !isZeroCondition(condition)) {
      assertValidCondition(condition);
    }
    const timeout = params.timeout ?? this.timeout;
    const prepare = serializeIlpPrepare({
      type: ILPPacketType.PREPARE,
      amount: BigInt(params.amount),
      destination: params.destination,
      executionCondition: condition ?? new Uint8Array(32),
      expiresAt: resolveExpiresAt(params.expiresAt, timeout),
      data: fromBase64(params.data),
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          // The plaintext claim header, base64(JSON) — the HTTP spelling of
          // the same object BTP sends as raw UTF-8 (§1.3 vs §1.9 step 2).
          'ILP-Payment-Channel-Claim': toBase64(
            encodeUtf8(JSON.stringify(claim))
          ),
        },
        body: prepare.slice(),
        signal: controller.signal,
      });
    } catch (error) {
      throw new NetworkError(
        `could not reach the connector client edge at ${url}`,
        error instanceof Error ? error : undefined
      );
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 403) {
      throw new ConnectorEdgeError(
        `POST /ilp/probe answered 403: ${await response
          .text()
          .catch(() => 'not authorized to probe')}`,
        'PROBE_FORBIDDEN'
      );
    }
    if (!response.ok) {
      throw new ConnectorEdgeError(
        `POST /ilp/probe answered ${response.status}`,
        'PROBE_HTTP_STATUS'
      );
    }

    const body = new Uint8Array(await response.arrayBuffer());
    if (body.length === 0) {
      throw new ConnectorError(
        'Empty 200 body from /ilp/probe (expected an OER ILP response)'
      );
    }
    // `toon-accumulated-cost` rides beside the packet, never inside it
    // (§1.6) — reading it is the whole reason to probe.
    return {
      ...mapIlpResponse(deserializeIlpPacket(body), condition),
      ...readResponseMeta(response.headers),
    };
  }

  /**
   * What `destination` costs at this connector, or `null` when the connector
   * answers `404` — no locally-terminated route matches it.
   *
   * `null` is the answer to "you do not terminate this", which is information;
   * a transport failure throws {@link NetworkError} instead, so a caller can
   * always tell "not mine" from "could not ask".
   *
   * Fetched once per (endpoint, destination) and reused. ADR 0020 makes a
   * price flat per handler, so it does not vary with the packet — a route
   * being repriced is an operator event, and {@link invalidateRoutePrice} is
   * how a caller reacts to one.
   *
   * @param options `forceRefresh` bypasses (and replaces) the cache entry.
   */
  async getRoutePrice(
    endpoint: string,
    destination: string,
    options: { forceRefresh?: boolean } = {}
  ): Promise<ConnectorRoutePrice | null> {
    if (typeof destination !== 'string' || destination.trim().length === 0) {
      throw new ConnectorEdgeError(
        'a route price needs a non-empty ILP destination',
        'INVALID_DESTINATION'
      );
    }
    const base = connectorEdgeBaseUrl(endpoint);
    const key = priceCacheKey(base, destination);
    if (options.forceRefresh) this.prices.delete(key);

    const cached = this.prices.get(key);
    if (cached) return cached;

    // Cache the in-flight promise so concurrent senders share one round trip;
    // drop it again on failure so a transient error is not cached forever. A
    // `404` IS cached: "this connector does not terminate that" is an answer.
    const inFlight = this.fetchRoutePrice(base, destination).catch(
      (error: unknown) => {
        this.prices.delete(key);
        throw error;
      }
    );
    this.prices.set(key, inFlight);
    return inFlight;
  }

  /**
   * Ask a route for its full x402 terms — the greeting a claimless PREPARE
   * is answered with (client-edge-spec.md §1.4) — including, from a settling
   * node, the channel-opening facts (connector #617).
   *
   * This is a real `POST /ilp` carrying a minimal PREPARE with no claim
   * header. It is free by the wire's own contract: an unpaid request to a
   * priced route is answered with terms instead of performed, and nothing
   * is charged for asking. `null` when the connector does not price the
   * destination (the request would be routed or refused, not greeted) —
   * mapped from anything other than a 402 answer.
   */
  async terms(
    endpoint: string,
    destination: string
  ): Promise<ConnectorRouteTerms | null> {
    if (typeof destination !== 'string' || destination.trim().length === 0) {
      throw new ConnectorEdgeError(
        'route terms need a non-empty ILP destination',
        'INVALID_DESTINATION'
      );
    }
    const base = connectorEdgeBaseUrl(endpoint);
    // A syntactically complete PREPARE the greeting gate answers before the
    // packet is ever routed: a non-zero condition (an all-zero one is F01),
    // a near-term expiry, no data. Amount is irrelevant to the greeting.
    const condition = new Uint8Array(32);
    condition[0] = 1;
    const prepare = serializeIlpPrepare({
      type: ILPPacketType.PREPARE,
      amount: 0n,
      destination,
      executionCondition: condition,
      expiresAt: new Date(Date.now() + 30_000),
      data: new Uint8Array(0),
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    let response: Response;
    try {
      response = await this.fetchImpl(`${base}/ilp`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: prepare.slice(),
        signal: controller.signal,
      });
    } catch (error) {
      throw new NetworkError(
        `could not reach the connector client edge at ${base}/ilp`,
        error instanceof Error ? error : undefined
      );
    } finally {
      clearTimeout(timer);
    }

    if (response.status !== 402) return null;
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new ConnectorEdgeError(
        'connector answered 402 with a body that is not JSON',
        'TERMS_MALFORMED',
        error instanceof Error ? error : undefined
      );
    }
    return parseConnectorRouteTerms(body);
  }

  /**
   * The credited/spendable position of one or more channels this client
   * controls (`POST /ilp/claim-state`, client-edge-spec.md §1.10) — the
   * runway source of truth (toon-meta#261/#262 decision 9): earnings net
   * off-chain on the same channel a client spends from, so this is also
   * where a credited balance is read. Never cached: unlike identity/price,
   * a claim watermark changes on every accepted claim, on EITHER side.
   *
   * Each entry is independently authenticated (own signature, own
   * blockchain) — a request MAY mix EVM and Solana channels. Returns `[]`
   * without a request when `channels` is empty.
   *
   * @throws {NetworkError} the connector could not be reached.
   * @throws {ConnectorEdgeError} a non-2xx status, or a body that is not the
   *   documented shape.
   */
  async getClaimState(
    endpoint: string,
    channels: ClaimStateRequestEntry[]
  ): Promise<ClaimStateResult[]> {
    if (channels.length === 0) return [];
    const base = connectorEdgeBaseUrl(endpoint);
    const url = `${base}/ilp/claim-state`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ channels }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new NetworkError(
        `could not reach the connector client edge at ${url}`,
        error instanceof Error ? error : undefined
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new ConnectorEdgeError(
        `POST /ilp/claim-state answered ${response.status}`,
        'CLAIM_STATE_HTTP_STATUS'
      );
    }
    return parseClaimStateResponse(
      await this.readJson(response, 'CLAIM_STATE_MALFORMED')
    );
  }

  /**
   * Drop a cached route price — one (endpoint, destination)'s, every
   * destination's at one endpoint when `destination` is omitted, or all of
   * them when both are. The way to react to a route being repriced.
   */
  invalidateRoutePrice(endpoint?: string, destination?: string): void {
    if (endpoint === undefined) {
      this.prices.clear();
      return;
    }
    const base = connectorEdgeBaseUrl(endpoint);
    if (destination !== undefined) {
      this.prices.delete(priceCacheKey(base, destination));
      return;
    }
    const prefix = priceCacheKeyPrefix(base);
    for (const key of this.prices.keys()) {
      if (key.startsWith(prefix)) this.prices.delete(key);
    }
  }

  /**
   * Whether a price for `(endpoint, destination)` is already held (no request
   * is made).
   */
  hasCachedRoutePrice(endpoint: string, destination: string): boolean {
    return this.prices.has(
      priceCacheKey(connectorEdgeBaseUrl(endpoint), destination)
    );
  }

  private async fetchRoutePrice(
    base: string,
    destination: string
  ): Promise<ConnectorRoutePrice | null> {
    const url = `${base}/ilp/routes/price?destination=${encodeURIComponent(destination)}`;
    const response = await this.get(url);

    if (response.status === 404) return null;
    if (!response.ok) {
      throw new ConnectorEdgeError(
        `GET /ilp/routes/price answered ${response.status}`,
        'ROUTE_PRICE_HTTP_STATUS'
      );
    }
    return parseConnectorRoutePrice(
      await this.readJson(response, 'ROUTE_PRICE_MALFORMED')
    );
  }

  private async fetchDescription(base: string): Promise<NodeSelfDescription> {
    const response = await this.get(`${base}/ilp`);
    if (response.status === 429) {
      throw new ConnectorEdgeError(
        `GET /ilp answered 429: the node's lookup budget is spent — back off and re-ask`,
        'SELF_DESCRIPTION_BUDGETED'
      );
    }
    if (!response.ok) {
      throw new ConnectorEdgeError(
        `GET /ilp answered ${response.status}`,
        'SELF_DESCRIPTION_HTTP_STATUS'
      );
    }
    // `parseSelfDescription` never throws on a shape it does not recognise —
    // an unreadable field is dropped and the rest of the document survives —
    // so the only failure left here is a body that is not JSON at all.
    return parseSelfDescription(
      await this.readJson(response, 'SELF_DESCRIPTION_MALFORMED'),
      base
    );
  }

  private async fetchIdentity(base: string): Promise<ConnectorIdentity> {
    const response = await this.get(`${base}/ilp/identity`);
    if (!response.ok) {
      throw new ConnectorEdgeError(
        `GET /ilp/identity answered ${response.status}`,
        'IDENTITY_HTTP_STATUS'
      );
    }
    return parseConnectorIdentity(
      await this.readJson(response, 'IDENTITY_MALFORMED'),
      base
    );
  }

  private async readJson(
    response: Response,
    code: ConnectorEdgeErrorCode
  ): Promise<unknown> {
    try {
      return await response.json();
    } catch (error) {
      throw new ConnectorEdgeError(
        'connector answered a body that is not JSON',
        code,
        error instanceof Error ? error : undefined
      );
    }
  }

  /** GET with a timeout, mapping any transport failure onto {@link NetworkError}. */
  private async get(url: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      return await this.fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
    } catch (error) {
      throw new NetworkError(
        `could not reach the connector client edge at ${url}`,
        error instanceof Error ? error : undefined
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

/** A required-string reader over a raw settlement-facts record, refusing a missing/empty field. */
function settlementStr(s: Record<string, unknown>, key: string): string {
  const value = s[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ConnectorEdgeError(
      `x402 greeting settlement facts lack '${key}'`,
      'TERMS_MALFORMED'
    );
  }
  return value;
}

/** A required-`decimals` reader, shared by every chain's settlement-facts shape. */
function settlementDecimals(s: Record<string, unknown>): number {
  const decimals = s['decimals'];
  if (typeof decimals !== 'number') {
    throw new ConnectorEdgeError(
      "x402 greeting settlement facts lack 'decimals'",
      'TERMS_MALFORMED'
    );
  }
  return decimals;
}

/** Parse one already-object-checked EVM settlement-facts record (legacy `settlement` shape). */
function parseEvmSettlementTerms(
  s: Record<string, unknown>
): ConnectorSettlementTerms {
  return {
    chain: settlementStr(s, 'chain'),
    settlementAddress: settlementStr(s, 'settlementAddress'),
    tokenNetworkRegistry: settlementStr(s, 'tokenNetworkRegistry'),
    tokenNetwork: settlementStr(s, 'tokenNetwork'),
    tokenAddress: settlementStr(s, 'tokenAddress'),
    decimals: settlementDecimals(s),
  };
}

/** Parse one already-object-checked Solana settlement-facts record (connector #632). */
function parseSolanaSettlementTerms(
  s: Record<string, unknown>
): ConnectorSolanaSettlementTerms {
  return {
    chain: settlementStr(s, 'chain'),
    settlementAddress: settlementStr(s, 'settlementAddress'),
    programId: settlementStr(s, 'programId'),
    tokenAddress: settlementStr(s, 'tokenAddress'),
    decimals: settlementDecimals(s),
  };
}

/**
 * Parse one entry of the greeting's `extra.settlements` list (connector
 * #632). The wire is untagged — serde on the connector side, and this parser
 * on the client side, both disambiguate structurally: `programId` names a
 * Solana entry, `tokenNetworkRegistry` names an EVM one. Anything else (both
 * fields present, neither present, or a field of the wrong shape) is refused
 * rather than guessed at.
 */
function parseChainSettlementEntry(
  raw: unknown
): ConnectorChainSettlementTerms {
  if (typeof raw !== 'object' || raw === null) {
    throw new ConnectorEdgeError(
      'x402 greeting settlements entry is not an object',
      'TERMS_MALFORMED'
    );
  }
  const s = raw as Record<string, unknown>;
  if (typeof s['programId'] === 'string') {
    return { kind: 'solana', ...parseSolanaSettlementTerms(s) };
  }
  if (typeof s['tokenNetworkRegistry'] === 'string') {
    return { kind: 'evm', ...parseEvmSettlementTerms(s) };
  }
  throw new ConnectorEdgeError(
    "x402 greeting settlements entry names neither an EVM ('tokenNetworkRegistry') nor a Solana ('programId') chain",
    'TERMS_MALFORMED'
  );
}

/**
 * Parse an x402 v2 greeting body into {@link ConnectorRouteTerms}. Pure and
 * exported so the wire shape is testable without a server. Refuses a body
 * that is not the documented greeting; a malformed OPTIONAL `settlement`
 * object (or `settlements` entry) is also a refusal rather than a silent
 * drop — half-understood channel-opening facts would be opened AGAINST.
 */
export function parseConnectorRouteTerms(body: unknown): ConnectorRouteTerms {
  if (typeof body !== 'object' || body === null) {
    throw new ConnectorEdgeError(
      'x402 greeting is not an object',
      'TERMS_MALFORMED'
    );
  }
  const greeting = body as {
    resource?: { url?: unknown };
    accepts?: unknown;
  };
  const accepts = Array.isArray(greeting.accepts) ? greeting.accepts : [];
  const option = accepts.find(
    (entry): entry is Record<string, unknown> =>
      typeof entry === 'object' &&
      entry !== null &&
      (entry as { scheme?: unknown }).scheme === 'toon-channel'
  );
  if (!option || typeof option['amount'] !== 'string') {
    throw new ConnectorEdgeError(
      'x402 greeting carries no toon-channel option',
      'TERMS_MALFORMED'
    );
  }
  const destination =
    typeof greeting.resource?.url === 'string' ? greeting.resource.url : '';
  const rawExtra = option['extra'];
  // Preserved verbatim on the returned terms below (issue #509, mirroring
  // #506's `Http402Client` posture) — `extraForReads` stays the source for
  // the fields this parser already knows (settlement/settlements) without
  // narrowing the bag a caller sees.
  const extra: X402ChannelExtra | undefined =
    typeof rawExtra === 'object' && rawExtra !== null
      ? (rawExtra as X402ChannelExtra)
      : undefined;
  const extraForReads = extra ?? {};

  const rawSettlements = extraForReads['settlements'];
  let settlements: ConnectorChainSettlementTerms[] | undefined;
  if (rawSettlements !== undefined) {
    if (!Array.isArray(rawSettlements)) {
      throw new ConnectorEdgeError(
        'x402 greeting settlements is not an array',
        'TERMS_MALFORMED'
      );
    }
    settlements = rawSettlements.map(parseChainSettlementEntry);
  }

  const rawSettlement = extraForReads['settlement'];
  if (rawSettlement === undefined) {
    return {
      destination,
      price: option['amount'],
      ...(settlements ? { settlements } : {}),
      ...(extra !== undefined ? { extra } : {}),
    };
  }
  if (typeof rawSettlement !== 'object' || rawSettlement === null) {
    throw new ConnectorEdgeError(
      'x402 greeting settlement facts are malformed',
      'TERMS_MALFORMED'
    );
  }
  return {
    destination,
    price: option['amount'],
    settlement: parseEvmSettlementTerms(
      rawSettlement as Record<string, unknown>
    ),
    ...(settlements ? { settlements } : {}),
    ...(extra !== undefined ? { extra } : {}),
  };
}
