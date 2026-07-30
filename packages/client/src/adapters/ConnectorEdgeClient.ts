/**
 * Ask a terminating connector who it is and what it charges — the step that
 * has to happen BEFORE a packet can be formed at all.
 *
 * ADR 0018 makes holding the terminating connector's public key a
 * precondition of forming a packet: `Prepare.data` is sealed to that key, and
 * sealing to the wrong one is a confidentiality failure, not a delivery
 * failure. ADR 0022 says the connector *answers* — it never announces — so
 * both facts are fetched from the connector's own client edge, on the same
 * origin this client already POSTs `/ilp` to
 * (`docs/protocol/client-edge-spec.md` §1.7):
 *
 * - `GET /ilp/identity` → `{ "keyId": "...", "publicKey": "0x04..." }` — the
 *   uncompressed secp256k1 key, 65 bytes, `0x`-prefixed hex.
 * - `GET /ilp/routes/price?destination=<ILP address>` →
 *   `{ "destination": "...", "price": 100 }`, or `404` when no
 *   locally-terminated route matches.
 *
 * Both are unauthenticated and neither changes state.
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

import { NetworkError, ToonClientError } from '../errors.js';
import { ILPPacketType, serializeIlpPrepare } from '../btp/protocol.js';

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
}

/** What a locally-terminated route costs, as reported by `GET /ilp/routes/price`. */
export interface ConnectorRoutePrice {
  /** The ILP destination that was asked about (echoed by the connector). */
  destination: string;
  /** The price in ILP base units of the route `destination` matched. */
  price: bigint;
}

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
  | 'TERMS_MALFORMED';

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

  constructor(config: ConnectorEdgeClientConfig = {}) {
    this.fetchImpl = config.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * The terminating connector's public key, fetched once per endpoint.
   *
   * @param endpoint any client-edge URL (`https://apex`, `https://apex/ilp`).
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
  async getRouteTerms(
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
  const extra = option['extra'] as
    | { settlement?: unknown; settlements?: unknown }
    | undefined;

  const rawSettlements = extra?.settlements;
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

  const rawSettlement = extra?.settlement;
  if (rawSettlement === undefined) {
    return {
      destination,
      price: option['amount'],
      ...(settlements ? { settlements } : {}),
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
  };
}
