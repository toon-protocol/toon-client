/**
 * ILP-over-HTTP (RFC-0035) transport for the TOON client — the `POST /ilp`
 * carriage of `client-edge-spec.md` §1.1.
 *
 * The connector serves this and BTP on the same port. This adapter does
 * stateless one-shot writes over HTTP and can upgrade to a duplex BTP session
 * when a client needs to receive server-initiated packets.
 *
 * Wire contract:
 *  - One-shot write: `POST /ilp`
 *      body:    OER-encoded ILP PREPARE (`application/octet-stream`), in
 *               TOON's own dialect (ADR 0063), not RFC-0027's bytes.
 *      header:  `ILP-Payment-Channel-Claim: base64(JSON of the claim)` — the
 *               SAME claim JSON the BTP path attaches as the
 *               `payment-channel-claim` protocolData entry, raw (§1.3, §1.9).
 *      optional: `ILP-Peer-Id` + `Authorization: Bearer <secret>` identity —
 *                sent as a PAIR or not at all (issue #565), since the connector
 *                401s a presented id it cannot authenticate.
 *      response: `200 OK` with an OER FULFILL or REJECT body — an ILP-level
 *                outcome is ALWAYS 200. A non-2xx is a transport-level failure
 *                and never carries an OER body: 400 undecodable, 401 a
 *                presented identity that failed to authenticate, 402 terms
 *                instead of work, 413 over 2 MiB.
 *      beside the packet: `toon-accumulated-cost`, `toon-claim-ack` and
 *                `payment-required` response headers — see
 *                {@link readResponseMeta}, and `../ilp/response-meta.js` for
 *                why they are not part of the packet encoding.
 *  - Upgrade to BTP: standard HTTP `Upgrade` with `Sec-WebSocket-Protocol: btp`
 *      plus the same `ILP-Peer-Id` + `Authorization` headers. The connector
 *      pre-authenticates the BTP session from those headers (continuity), so
 *      after `101` we send BTP frames WITHOUT a separate in-band auth frame.
 *      Omitting the auth headers falls back to the normal BTP auth-frame flow.
 *
 * Reuses `serializeIlpPrepare`/`deserializeIlpPacket` from `btp/protocol.ts` —
 * the SAME OER codec the BTP path uses. Claim signing/construction is owned by
 * the caller; this transport never builds or signs claims.
 *
 * **What this no longer does.** Up to 0.x a `401` or a `requiredTransport`
 * `402` was caught here and re-thrown as "retry this over BTP", because the
 * only way to learn a route's carriage was to be refused over the wrong one.
 * 1.0 reads the node's own self-description first and picks a carriage from it
 * (`../btp/transport-select.js`), so that fallback is gone: a `401` is an
 * ordinary transport error again, and a `402` is terms — returned as a refusal
 * carrying the raw document in `paymentRequired`, which the carriage reads as a
 * greeting.
 */

import type { IlpSendResult } from '../ilp/types.js';
import {
  ILPPacketType,
  serializeIlpPrepare,
  deserializeIlpPacket,
} from '../btp/protocol.js';
import {
  NetworkError,
  describeEndpoint,
  type EndpointSource,
  ConnectorError,
} from '../client/errors.js';
import { parsePaymentTerms } from '../connector/x402.js';
import {
  ACCUMULATED_COST_HEADER,
  CLAIM_ACK_HEADER,
  PAYMENT_REQUIRED_HEADER,
  buildResponseMeta,
  decodeAccumulatedCost,
  decodeBase64Text,
  decodeClaimAck,
  decodePaymentRequired,
  type IlpResponseMeta,
} from '../ilp/response-meta.js';
import { withRetry } from '../utils/retry.js';
import { toBase64, fromBase64, encodeUtf8 } from '../utils/binary.js';
import {
  mapIlpResponse,
  resolveExpectedFulfillment,
  resolveExpiresAt,
  type IlpSendParams,
} from '../ilp/ilp-send.js';
import { assertValidFulfillment } from '../utils/fulfillment.js';

/** Header carrying the base64(JSON) payment-channel claim. */
export const ILP_CLAIM_HEADER = 'ILP-Payment-Channel-Claim';
/** Header carrying the peer identity. */
export const ILP_PEER_ID_HEADER = 'ILP-Peer-Id';

/** Anything a response's headers can be handed over as. */
export type ResponseHeaderSource =
  | Headers
  | Iterable<readonly [string, string]>
  | Record<string, string>;

/**
 * Read the three facts that ride BESIDE the answer packet off an HTTP
 * response's headers (`client-edge-spec.md` §1.6, and connector
 * `connector_btp::CARRIAGE_NAMES` for the header/protocolData pairing).
 *
 * The BTP twin is `BtpRuntimeClient`'s `readResponseMeta(protocolData)`, and
 * the two MUST agree: the connector's vector set pins each value's two
 * spellings as a pair (`peer_carriage.reject_with_cost` carries
 * `toon-accumulated-cost: "4200"` as a header and the same `4200` as a
 * protocolData entry). Both funnel into the one decoder each in
 * `../ilp/response-meta.js`; the only thing this side adds is stripping the
 * base64 layer off the two JSON-valued headers, which is a header artefact and
 * nothing else.
 *
 * Header names are matched case-insensitively (RFC 9110); the canonical
 * lower-case spellings are the ones the vectors pin.
 *
 * Exported because the wire-vector replay reads a vector's `http_headers`
 * array straight into it — the same function the live transport uses, so a
 * vector cannot pass while the transport disagrees with it.
 */
export function readResponseMeta(headers: ResponseHeaderSource): IlpResponseMeta {
  const get = headerReader(headers);

  const costHeader = get(ACCUMULATED_COST_HEADER);
  const ackHeader = get(CLAIM_ACK_HEADER);
  const termsHeader = get(PAYMENT_REQUIRED_HEADER);

  const ackJson = ackHeader !== undefined ? decodeBase64Text(ackHeader) : undefined;
  const termsJson =
    termsHeader !== undefined ? decodeBase64Text(termsHeader) : undefined;

  return buildResponseMeta({
    accumulatedCost:
      costHeader !== undefined ? decodeAccumulatedCost(costHeader) : undefined,
    claimAck: ackJson !== undefined ? decodeClaimAck(ackJson) : undefined,
    paymentRequired:
      termsJson !== undefined ? decodePaymentRequired(termsJson) : undefined,
  });
}

/** A case-insensitive single-value lookup over any of the header shapes above. */
function headerReader(
  headers: ResponseHeaderSource
): (name: string) => string | undefined {
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    return (name) => headers.get(name) ?? undefined;
  }
  const pairs: [string, string][] =
    typeof (headers as Iterable<readonly [string, string]>)[Symbol.iterator] ===
    'function'
      ? [...(headers as Iterable<readonly [string, string]>)].map(([k, v]) => [
          k,
          v,
        ])
      : Object.entries(headers as Record<string, string>);
  return (name) => {
    const wanted = name.toLowerCase();
    for (const [key, value] of pairs) {
      if (key.toLowerCase() === wanted) return value;
    }
    return undefined;
  };
}

export interface HttpIlpClientConfig {
  /** The peer's `POST /ilp` URL (the `httpEndpoint` from discovery). */
  httpEndpoint: string;
  /**
   * Where `httpEndpoint` came from, so a network failure can say so. Omit when
   * the caller supplied it.
   */
  endpointSource?: EndpointSource;
  /**
   * Optional peer identity. With no `peerId`/`authToken` the connector treats
   * the request as an anonymous no-auth peer (permissionless default) and
   * derives an ephemeral id from the claim signer.
   *
   * NOTE (issue #565): this is only PRESENTED on the wire when an `authToken`
   * accompanies it — see {@link HttpIlpClient.authHeaders}.
   */
  peerId?: string;
  /** Bearer secret for `Authorization`. Omit for the no-auth peer path. */
  authToken?: string;
  /** Request timeout in milliseconds (default: 30000). */
  timeout?: number;
  /** Max retry attempts for transport-level network failures (default: 3). */
  maxRetries?: number;
  /** Initial retry delay in milliseconds (default: 1000). */
  retryDelay?: number;
  /** Custom fetch implementation (for testing / custom transports). */
  httpClient?: typeof fetch;
}

/**
 * Stateless ILP-over-HTTP transport: the carriage's HTTP adapter.
 *
 * Use this for pure one-shot consumers (publish-and-forget writes). When the
 * client needs a duplex session — to receive server-initiated packets or to act
 * as a peer — use `BtpRuntimeClient`.
 */
export class HttpIlpClient {
  private readonly httpEndpoint: string;
  private readonly endpointSource: EndpointSource | undefined;
  private readonly peerId: string | undefined;
  private readonly authToken: string | undefined;
  private readonly timeout: number;
  private readonly retryConfig: { maxRetries: number; retryDelay: number };
  private readonly httpClient: typeof fetch;

  constructor(config: HttpIlpClientConfig) {
    this.httpEndpoint = config.httpEndpoint;
    this.endpointSource = config.endpointSource;
    this.peerId = config.peerId;
    this.authToken = config.authToken;
    this.timeout = config.timeout ?? 30000;
    this.retryConfig = {
      maxRetries: config.maxRetries ?? 3,
      retryDelay: config.retryDelay ?? 1000,
    };
    this.httpClient = config.httpClient ?? fetch;
  }

  /**
   * The client edge this transport pays — the origin `GET /ilp/identity` and
   * `GET /ilp/routes/price` hang off (`ConnectorEdgeClient` normalizes the
   * trailing `/ilp` away). Exposed because a sealed write must ask the
   * connector it is ACTUALLY paying for its key, not a configured guess.
   */
  get clientEdgeEndpoint(): string {
    return this.httpEndpoint;
  }

  /**
   * Send an ILP PREPARE via `POST /ilp` WITHOUT a claim. The connector accepts
   * this only on free/zero-amount routes; paid writes must use
   * {@link sendIlpPacketWithClaim}.
   *
   * `params` may carry an `expectedFulfillment` (the sender's end-to-end
   * check, ADR 0069), a `greeting` flag and an explicit `expiresAt`. With an
   * expected fulfilment the FULFILL preimage is compared against it and a
   * mismatch is surfaced as a failed result — see {@link mapIlpResponse}.
   */
  async sendIlpPacket(params: IlpSendParams): Promise<IlpSendResult> {
    return withRetry(() => this.postPrepare(params), {
      maxRetries: this.retryConfig.maxRetries,
      retryDelay: this.retryConfig.retryDelay,
      exponentialBackoff: true,
      shouldRetry: (error) => error instanceof NetworkError,
    });
  }

  /**
   * Send an ILP PREPARE via `POST /ilp` with the payment-channel claim attached
   * as the `ILP-Payment-Channel-Claim` header. `claim` is the SAME JSON object
   * the BTP path attaches as the `payment-channel-claim` protocolData entry —
   * we base64(JSON.stringify(claim)) it, byte-for-byte identical to BTP.
   *
   * `expectedFulfillment` / `greeting` / `expiresAt` semantics are identical
   * to {@link sendIlpPacket}.
   */
  async sendIlpPacketWithClaim(
    params: IlpSendParams,
    claim: unknown
  ): Promise<IlpSendResult> {
    return withRetry(() => this.postPrepare(params, claim), {
      maxRetries: this.retryConfig.maxRetries,
      retryDelay: this.retryConfig.retryDelay,
      exponentialBackoff: true,
      shouldRetry: (error) => error instanceof NetworkError,
    });
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  /**
   * The identity headers to present, if any.
   *
   * A peer id and its bearer secret are ONE credential, so both are sent or
   * neither is (issue #565). Presenting a `peerId` this client cannot back
   * with a secret is strictly WORSE than presenting nothing: the connector's
   * client edge resolves a PRESENTED identity first and answers `401` before
   * it ever looks at the route
   * (connector `crates/connector-client-edge/src/lib.rs`, whose own comment
   * reads "A request presenting no `ILP-Peer-Id` is unaffected here — it is
   * anonymous, resolved once the claim (if any) has been admitted"), whereas
   * anonymous + a valid payment-channel claim is the supported permissionless
   * path. The live devnet daemon shipped `ILP-Peer-Id: g.toon.client` with an
   * EMPTY token — an id no connector has a registration for — so every default
   * paid write over `POST /ilp` 401'd before the claim was read at all.
   *
   * An empty-string token is not a credential; `''` is falsy here on purpose.
   *
   * This REMOVES the 401 rather than recovering from it, which is why 1.0 can
   * drop the "a 401 means retry over BTP" fallback entirely: anonymous + a
   * valid claim is the supported permissionless path, so a 401 now means a
   * genuinely misconfigured credential and is surfaced as the transport error
   * it is.
   */
  private authHeaders(): Record<string, string> {
    if (!this.peerId || !this.authToken) return {};
    return {
      [ILP_PEER_ID_HEADER]: this.peerId,
      Authorization: `Bearer ${this.authToken}`,
    };
  }

  /**
   * Single attempt: serialize the PREPARE, POST it, and map the response.
   * @throws {NetworkError} On connection/timeout failures (retried).
   * @throws {ConnectorError} On non-retryable transport errors (5xx / unexpected).
   *   A `402` carrying terms is returned, not thrown.
   */
  private async postPrepare(
    params: IlpSendParams,
    claim?: unknown
  ): Promise<IlpSendResult> {
    const requestTimeout = params.timeout ?? this.timeout;

    // Validate the expected fulfilment's length up front: a wrong-length
    // value can never match a real FULFILL, so every delivery would be
    // counted failed — and paid for — before anyone noticed why.
    const expectedFulfillment = resolveExpectedFulfillment(
      params.expectedFulfillment
    );
    if (expectedFulfillment !== undefined) {
      assertValidFulfillment(expectedFulfillment);
    }

    const prepare = serializeIlpPrepare({
      type: ILPPacketType.PREPARE,
      amount: BigInt(params.amount),
      destination: params.destination,
      greeting: params.greeting ?? false,
      expiresAt: resolveExpiresAt(params.expiresAt, requestTimeout),
      data: fromBase64(params.data),
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
      ...this.authHeaders(),
    };
    if (claim !== undefined) {
      headers[ILP_CLAIM_HEADER] = toBase64(encodeUtf8(JSON.stringify(claim)));
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), requestTimeout);

    try {
      const response = await this.httpClient(this.httpEndpoint, {
        method: 'POST',
        headers,
        // Copy into a fresh ArrayBuffer so fetch sees a clean body, not a view.
        body: prepare.slice(),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      return await this.mapResponse(response, expectedFulfillment);
    } catch (error) {
      clearTimeout(timeoutId);
      throw this.mapTransportError(error, requestTimeout);
    }
  }

  /**
   * Map a `200 OK` body (OER FULFILL/REJECT) to an IlpSendResult; map a non-2xx
   * to a transport error. Per the wire contract, ILP-level rejects arrive as a
   * 200 + REJECT body — only HTTP non-2xx means a transport-layer failure.
   *
   * When `expectedFulfillment` is given the FULFILL preimage is compared
   * against it; a mismatch yields `accepted: false` (shared `mapIlpResponse`
   * logic, identical to the BTP path).
   */
  private async mapResponse(
    response: Response,
    expectedFulfillment?: Uint8Array
  ): Promise<IlpSendResult> {
    if (response.ok) {
      const buf = new Uint8Array(await response.arrayBuffer());
      if (buf.length === 0) {
        throw new ConnectorError(
          'Empty 200 body from /ilp (expected OER ILP response)'
        );
      }
      // The packet's own verdict and everything riding beside it are read
      // independently and merged. They are genuinely independent: a FULFILL
      // can carry a `claimAck` of `rejected` (the connector delivered the
      // work and separately refused the claim that came with it), and a
      // REJECT always carries `accumulatedCost` where a FULFILL never does
      // (§1.6 — "present on every REJECT this edge answers with … absent
      // from a FULFILL"). Inferring either from the other loses money.
      return {
        ...mapIlpResponse(deserializeIlpPacket(buf), expectedFulfillment),
        ...readResponseMeta(response.headers),
      };
    }

    // Transport-level error (400 malformed, 401 auth, 413 too large, 5xx).
    const body = await response.text().catch(() => '');
    const detail = body ? `: ${body}` : '';

    // `402` is not a transport failure at all: the connector answered with
    // TERMS instead of doing the work — an unpaid request to a priced route,
    // or a request that arrived over a carriage this route does not accept
    // (§1.4). Both carry the same x402 v2 document, the second adding
    // `extra.requiredTransport`. Returned as a refusal carrying the raw document
    // in `paymentRequired`, exactly where BTP puts it, so the carriage reads one
    // greeting whichever way it arrived.
    //
    // Pre-1.0 this class caught a 402 (and a bare 401) purely to signal
    // "retry over BTP". That fallback is gone: 1.0 decides its carriage up
    // front from the node's own self-description (`selectTransport`), so
    // reaching a 402 that names a required transport now means the
    // self-description and the route policy disagree — a fact worth
    // surfacing, not a step in the happy path.
    if (response.status === 402) {
      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(body);
      } catch {
        parsedBody = undefined;
      }
      if (parsePaymentTerms(parsedBody, this.httpEndpoint) !== undefined) {
        return { accepted: false, paymentRequired: parsedBody };
      }
      // A 402 this client cannot read as a TOON greeting at all — a vanilla
      // x402 challenge, or a malformed body. Surfaced as the transport error
      // it is rather than as terms nobody can act on.
      throw new ConnectorError(
        `Connector answered 402 with no usable TOON terms${detail}`
      );
    }

    if (response.status >= 500) {
      throw new ConnectorError(
        `Connector transport error (${response.status} ${response.statusText})${detail}`
      );
    }
    // 4xx — non-retryable client/transport error.
    throw new ConnectorError(
      `ILP-over-HTTP request rejected (${response.status} ${response.statusText})${detail}`
    );
  }

  private mapTransportError(error: unknown, requestTimeout: number): Error {
    if (
      error instanceof ConnectorError ||
      error instanceof NetworkError
    ) {
      return error;
    }
    if (error instanceof Error && error.name === 'AbortError') {
      return new NetworkError(
        `Request timeout after ${requestTimeout}ms reaching ${describeEndpoint(this.httpEndpoint, this.endpointSource)}`,
        error,
        this.httpEndpoint
      );
    }
    if (
      error instanceof TypeError &&
      (error.message.includes('fetch failed') ||
        error.message.includes('ECONNREFUSED') ||
        error.message.includes('ECONNRESET') ||
        error.message.includes('ETIMEDOUT') ||
        error.message.includes('network'))
    ) {
      return new NetworkError(
        `Network connection failed reaching ${describeEndpoint(this.httpEndpoint, this.endpointSource)}: ${error.message}`,
        error,
        this.httpEndpoint
      );
    }
    return new ConnectorError(
      `Unexpected error during ILP-over-HTTP request: ${
        error instanceof Error ? error.message : String(error)
      }`,
      error instanceof Error ? error : undefined
    );
  }
}
