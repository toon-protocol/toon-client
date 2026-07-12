/**
 * ILP-over-HTTP (RFC-0035) transport for the TOON client.
 *
 * The connector now serves ILP-over-HTTP on the SAME port as BTP (connector
 * PR #181). This adapter lets a client do stateless one-shot writes over HTTP
 * (`POST /ilp`) and upgrade to a duplex BTP session when it needs to receive
 * server-initiated packets or act as a peer.
 *
 * Wire contract (targets connector PR #181's `/ilp`):
 *  - One-shot write: `POST /ilp`
 *      body:    OER-encoded ILP PREPARE (`application/octet-stream`)
 *      header:  `ILP-Payment-Channel-Claim: base64(JSON of the claim)` — the
 *               SAME claim JSON the BTP path attaches as the
 *               `payment-channel-claim` protocolData entry.
 *      optional: `ILP-Peer-Id` + `Authorization: Bearer <secret>` identity.
 *      response: `200 OK` with an OER FULFILL or REJECT body. HTTP non-2xx is
 *                reserved for TRANSPORT errors (400/401/413/5xx); ILP-level
 *                rejects come back as a 200 + REJECT body.
 *  - Upgrade to BTP: standard HTTP `Upgrade` with `Sec-WebSocket-Protocol: btp`
 *      plus the same `ILP-Peer-Id` + `Authorization` headers. The connector
 *      pre-authenticates the BTP session from those headers (continuity), so
 *      after `101` we send BTP frames WITHOUT a separate in-band auth frame.
 *      Omitting the auth headers falls back to the normal BTP auth-frame flow.
 *
 * Reuses `serializeIlpPrepare`/`deserializeIlpPacket` from `btp/protocol.ts` —
 * the SAME OER codec the BTP path uses. Claim signing/construction is owned by
 * the caller (BootstrapService); this transport never builds or signs claims.
 */

import type { IlpClient, IlpSendResult } from '@toon-protocol/core';
import type WSModule from 'ws';
import {
  ILPPacketType,
  serializeIlpPrepare,
  deserializeIlpPacket,
} from '../btp/protocol.js';
import { BtpRuntimeClient } from './BtpRuntimeClient.js';
import { NetworkError, ConnectorError } from '../errors.js';
import { withRetry } from '../utils/retry.js';
import { toBase64, fromBase64, encodeUtf8 } from '../utils/binary.js';
import { mapIlpResponse, type IlpSendParams } from './ilp-send.js';
import { assertValidCondition, isZeroCondition } from '../utils/condition.js';

/** Header carrying the base64(JSON) payment-channel claim. */
export const ILP_CLAIM_HEADER = 'ILP-Payment-Channel-Claim';
/** Header carrying a NIP-59 wrapped (gift-wrapped) claim. */
export const ILP_CLAIM_WRAPPED_HEADER = 'ILP-Payment-Channel-Claim-Wrapped';
/** Header carrying the peer identity. */
export const ILP_PEER_ID_HEADER = 'ILP-Peer-Id';

export interface HttpIlpClientConfig {
  /** The peer's `POST /ilp` URL (the `httpEndpoint` from discovery). */
  httpEndpoint: string;
  /**
   * Optional peer identity. With no `peerId`/`authToken` the connector treats
   * the request as an anonymous no-auth peer (permissionless default) and
   * derives an ephemeral id from the claim signer.
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
  /**
   * Custom WebSocket constructor for the BTP upgrade path (for testing /
   * custom transports). Forwarded to the underlying BtpRuntimeClient.
   */
  createWebSocket?: (url: string) => WebSocket;
}

/**
 * Stateless ILP-over-HTTP transport implementing `IlpClient`.
 *
 * Use this for pure one-shot consumers (publish-and-forget writes). When the
 * client needs a duplex session — to receive server-initiated packets or to act
 * as a peer — call {@link upgradeToBtp} to obtain a connected BtpRuntimeClient
 * that reuses the existing BTP code path.
 */
export class HttpIlpClient implements IlpClient {
  private readonly httpEndpoint: string;
  private readonly peerId: string | undefined;
  private readonly authToken: string | undefined;
  private readonly timeout: number;
  private readonly retryConfig: { maxRetries: number; retryDelay: number };
  private readonly httpClient: typeof fetch;
  private readonly createWebSocket: ((url: string) => WebSocket) | undefined;

  constructor(config: HttpIlpClientConfig) {
    this.httpEndpoint = config.httpEndpoint;
    this.peerId = config.peerId;
    this.authToken = config.authToken;
    this.timeout = config.timeout ?? 30000;
    this.retryConfig = {
      maxRetries: config.maxRetries ?? 3,
      retryDelay: config.retryDelay ?? 1000,
    };
    this.httpClient = config.httpClient ?? fetch;
    this.createWebSocket = config.createWebSocket;
  }

  /**
   * Send an ILP PREPARE via `POST /ilp` WITHOUT a claim. The connector accepts
   * this only on free/zero-amount routes; paid writes must use
   * {@link sendIlpPacketWithClaim}. Satisfies the IlpClient interface.
   *
   * `params` may carry a sender-chosen `executionCondition` and an explicit
   * `expiresAt` (toon-client#350); omitting both is the legacy zero-condition
   * path, unchanged. With a non-zero condition the FULFILL preimage is
   * verified (`sha256(fulfillment) == condition`) and a mismatch is surfaced
   * as a failed result — see {@link mapIlpResponse}.
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
   * Sender-chosen `executionCondition` / explicit `expiresAt` semantics are
   * identical to {@link sendIlpPacket}.
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

  /**
   * Upgrade to a duplex BTP session over the SAME endpoint.
   *
   * Derives the `ws(s)://` URL from `httpEndpoint`, opens a WebSocket with
   * `Sec-WebSocket-Protocol: btp` and the same `ILP-Peer-Id` + `Authorization`
   * headers, and returns a connected {@link BtpRuntimeClient}. When auth headers
   * are present the connector pre-authenticates the session (no in-band auth
   * frame); without them the BtpRuntimeClient falls back to the normal BTP
   * auth-frame flow.
   *
   * NOTE: passing per-connection headers + a subprotocol to a WebSocket is
   * Node-only (the `ws` package). Browsers cannot set arbitrary request headers
   * on a WebSocket handshake, so a browser consumer must use the gateway
   * transport or BTP-with-auth-frame instead.
   */
  async upgradeToBtp(): Promise<BtpRuntimeClient> {
    const btpUrl = httpEndpointToBtpUrl(this.httpEndpoint);

    // Default WS factory negotiates `btp` + carries the auth headers so the
    // connector pre-authenticates. Built lazily (Node-only) — browsers must
    // pass an explicit `createWebSocket` (they can't set handshake headers).
    const createWebSocket =
      this.createWebSocket ?? (await makeBtpWebSocketFactory(this.authHeaders()));

    const client = new BtpRuntimeClient({
      btpUrl,
      // BtpRuntimeClient sends an auth frame using these; when the connector
      // pre-authenticated via Upgrade headers it accepts the (redundant) frame.
      peerId: this.peerId ?? 'client',
      authToken: this.authToken ?? '',
      createWebSocket,
    });
    await client.connect();
    return client;
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.peerId) headers[ILP_PEER_ID_HEADER] = this.peerId;
    if (this.authToken) headers['Authorization'] = `Bearer ${this.authToken}`;
    return headers;
  }

  /**
   * Single attempt: serialize the PREPARE, POST it, and map the response.
   * @throws {NetworkError} On connection/timeout failures (retried).
   * @throws {ConnectorError} On non-retryable transport errors (5xx / unexpected).
   */
  private async postPrepare(
    params: IlpSendParams,
    claim?: unknown
  ): Promise<IlpSendResult> {
    const requestTimeout = params.timeout ?? this.timeout;

    // Sender-chosen condition (toon-client#350): validate length up front so
    // the OER serializer can never silently zero-fill a malformed condition
    // and downgrade the packet to the legacy unverified class.
    const condition = params.executionCondition;
    if (condition !== undefined && !isZeroCondition(condition)) {
      assertValidCondition(condition);
    }

    const prepare = serializeIlpPrepare({
      type: ILPPacketType.PREPARE,
      amount: BigInt(params.amount),
      destination: params.destination,
      executionCondition: condition ?? new Uint8Array(32),
      expiresAt: params.expiresAt ?? new Date(Date.now() + requestTimeout),
      data: fromBase64(params.data),
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
      ...this.authHeaders(),
    };
    if (claim !== undefined) {
      headers[ILP_CLAIM_HEADER] = toBase64(
        encodeUtf8(JSON.stringify(claim))
      );
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
      return await this.mapResponse(response, condition);
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
   * When `sentCondition` is non-zero the FULFILL preimage is verified against
   * it; a mismatch yields `accepted: false` (shared `mapIlpResponse` logic,
   * identical to the BTP path).
   */
  private async mapResponse(
    response: Response,
    sentCondition?: Uint8Array
  ): Promise<IlpSendResult> {
    if (response.ok) {
      const buf = new Uint8Array(await response.arrayBuffer());
      if (buf.length === 0) {
        throw new ConnectorError('Empty 200 body from /ilp (expected OER ILP response)');
      }
      return mapIlpResponse(deserializeIlpPacket(buf), sentCondition);
    }

    // Transport-level error (400 malformed, 401 auth, 413 too large, 5xx).
    const body = await response.text().catch(() => '');
    const detail = body ? `: ${body}` : '';
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
    if (error instanceof ConnectorError || error instanceof NetworkError) {
      return error;
    }
    if (error instanceof Error && error.name === 'AbortError') {
      return new NetworkError(`Request timeout after ${requestTimeout}ms`, error);
    }
    if (
      error instanceof TypeError &&
      (error.message.includes('fetch failed') ||
        error.message.includes('ECONNREFUSED') ||
        error.message.includes('ECONNRESET') ||
        error.message.includes('ETIMEDOUT') ||
        error.message.includes('network'))
    ) {
      return new NetworkError(`Network connection failed: ${error.message}`, error);
    }
    return new ConnectorError(
      `Unexpected error during ILP-over-HTTP request: ${
        error instanceof Error ? error.message : String(error)
      }`,
      error instanceof Error ? error : undefined
    );
  }
}

/**
 * Derive the BTP WebSocket URL from a `POST /ilp` HTTP endpoint. The connector
 * serves BTP on the SAME path, so we only swap the scheme (http→ws, https→wss).
 */
export function httpEndpointToBtpUrl(httpEndpoint: string): string {
  return httpEndpoint
    .replace(/^https:\/\//i, 'wss://')
    .replace(/^http:\/\//i, 'ws://');
}

/**
 * Build a WebSocket factory that opens the BTP upgrade with a `btp` subprotocol
 * and the given handshake headers. Node-only — lazily loads the `ws` package via
 * a dynamically-imported `createRequire` so the node-only `node:module`/`ws`
 * deps never enter a browser bundle (per-connection headers aren't settable on
 * the browser WebSocket anyway).
 */
async function makeBtpWebSocketFactory(
  headers: Record<string, string>
): Promise<(url: string) => WebSocket> {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const WS = require('ws') as typeof WSModule;

  // CJS/ESM interop: walk the constructor ladder (class / .default / .WebSocket)
  // so this works under any loader.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ws = WS as any;
  const WSClass = (typeof ws === 'function'
    ? ws
    : typeof ws.default === 'function'
      ? ws.default
      : typeof ws.WebSocket === 'function'
        ? ws.WebSocket
        : null) as unknown as typeof WSModule.prototype.constructor;
  if (WSClass === null) {
    throw new Error(
      "makeBtpWebSocketFactory: require('ws') did not yield a constructor on .default, .WebSocket, or the module root."
    );
  }

  // `ws` accepts (url, protocols, options); the connector negotiates `btp` and
  // pre-authenticates the session from the `ILP-Peer-Id`/`Authorization` headers.
  return (url: string): WebSocket =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    new (WSClass as any)(url, 'btp', { headers }) as unknown as WebSocket;
}
