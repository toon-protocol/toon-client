import type { IlpClient, IlpSendResult } from '@toon-protocol/core';
import { NetworkError, ConnectorError, ValidationError } from '../errors.js';
import { withRetry } from '../utils/retry.js';
import { isBase64 } from '../utils/binary.js';
import { resolveExecutionCondition, type IlpSendParams } from './ilp-send.js';
import { isZeroCondition } from '../utils/condition.js';

/**
 * Configuration options for HttpRuntimeClient.
 */
export interface HttpRuntimeClientConfig {
  /** Connector runtime API base URL (e.g., 'http://localhost:8080') */
  connectorUrl: string;
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Maximum retry attempts for network failures (default: 3) */
  maxRetries?: number;
  /** Initial retry delay in milliseconds (default: 1000) */
  retryDelay?: number;
  /** HTTP client implementation (for testing) */
  httpClient?: typeof fetch;
}

/**
 * Message for a sealed packet handed to a transport that cannot carry its seal.
 */
export const SEALED_PACKET_UNSUPPORTED_MESSAGE =
  'HttpRuntimeClient cannot carry a sender-chosen executionCondition: its ' +
  'wire is the connector-admin JSON body {destination, amount, data}, which ' +
  'has no field for the condition, and its response carries no fulfillment to ' +
  'verify one against. Sending anyway would downgrade a sealed packet to the ' +
  'legacy unverified class without telling anyone. Configure `proxyUrl` (or ' +
  '`connectorHttpEndpoint`) to use HttpIlpClient, or `btpUrl` to use ' +
  'BtpRuntimeClient — both put the condition on the PREPARE and verify the ' +
  'FULFILL preimage against it.';

/**
 * Message for an explicit expiry handed to a transport that cannot carry it.
 */
export const EXPLICIT_EXPIRY_UNSUPPORTED_MESSAGE =
  'HttpRuntimeClient cannot carry an explicit expiresAt: the connector-admin ' +
  'endpoint mints the PREPARE itself and derives its own expiry, so a ' +
  'sender-chosen one (rolling-swap spec R7) would be silently discarded. Use ' +
  'HttpIlpClient (`proxyUrl`) or BtpRuntimeClient (`btpUrl`), which serialize ' +
  'the PREPARE — and its expiry — on this side of the wire.';

/**
 * True when `params.executionCondition` is the LEGACY class — an all-zero
 * condition, which every transport already puts on the wire as "unverified"
 * and which therefore loses nothing here. An undecodable base64 condition is
 * NOT legacy: a caller who meant "no condition" writes no condition at all.
 */
function isLegacyCondition(params: IlpSendParams): boolean {
  try {
    const condition = resolveExecutionCondition(params.executionCondition);
    return condition !== undefined && isZeroCondition(condition);
  } catch {
    return false;
  }
}

/**
 * HTTP client for sending ILP packets to an external connector runtime API.
 *
 * Implements the IlpClient interface for use with TOON agents
 * that need to send ILP packets without embedding a full connector.
 *
 * Features:
 * - Request validation (destination, amount, data)
 * - Retry logic with exponential backoff for transient network failures
 * - Typed error handling (NetworkError, ConnectorError, ValidationError)
 * - Connection pooling and keep-alive (via Node.js fetch)
 *
 * SEALED PACKETS ARE REFUSED, NOT STRIPPED (toon-client#581). This transport
 * does not serialize a PREPARE at all: it POSTs `{destination, amount, data}`
 * as JSON to the connector's `/admin/ilp/send`, and the connector mints the
 * PREPARE on the far side. There is therefore no field on this wire for a
 * sender-chosen `executionCondition` or an explicit `expiresAt`.
 *
 * The parameters used to be omitted from the signature entirely. TypeScript's
 * method-parameter bivariance let that satisfy `IlpClient` anyway, so a sealed,
 * condition-bearing packet routed here compiled cleanly and was put on the wire
 * with its condition dropped — a swap leg that believes it is hash-locked and
 * is not, visible only at runtime. The parameters are now named in the
 * signature (via the shared {@link IlpSendParams}) and a packet that requires
 * them is refused with a {@link ValidationError} before any request is made.
 *
 * Carrying them was considered and rejected: even if the admin body grew the
 * fields, this endpoint's response is `{accepted, data, code, message}` with no
 * `fulfillment`, so the check that MAKES a sender-chosen condition meaningful —
 * `sha256(fulfillment) == condition`, which `mapIlpResponse` runs on both real
 * transports — could never run here. "Carried" would still mean "unverified",
 * i.e. the same lie with more code. Failing loudly is the honest option.
 *
 * An absent or all-zero condition is the legacy unverified class and is
 * unaffected: ordinary publish/upload writes behave byte-for-byte as before.
 *
 * @example
 * ```typescript
 * const client = new HttpRuntimeClient({
 *   connectorUrl: 'http://localhost:8080'
 * });
 *
 * const result = await client.sendIlpPacket({
 *   destination: 'g.toon.alice',
 *   amount: '1000',
 *   data: 'base64EncodedToonData==',
 * });
 *
 * if (result.accepted) {
 *   console.log('Payment accepted');
 * } else {
 *   console.error('Payment rejected:', result.code, result.message);
 * }
 * ```
 */
export class HttpRuntimeClient implements IlpClient {
  private readonly connectorUrl: string;
  private readonly timeout: number;
  private readonly retryConfig: { maxRetries: number; retryDelay: number };
  private readonly httpClient: typeof fetch;

  constructor(config: HttpRuntimeClientConfig) {
    // Normalize connector URL (remove trailing slash)
    this.connectorUrl = config.connectorUrl.replace(/\/$/, '');
    this.timeout = config.timeout ?? 30000;
    this.retryConfig = {
      maxRetries: config.maxRetries ?? 3,
      retryDelay: config.retryDelay ?? 1000,
    };
    this.httpClient = config.httpClient ?? fetch;
  }

  /**
   * Send an ILP packet to the connector runtime API.
   *
   * @param params - ILP packet parameters
   * @returns ILP packet response with acceptance status
   * @throws {ValidationError} If request parameters are invalid, or if the
   *   packet requires a sender-chosen `executionCondition` / explicit
   *   `expiresAt` this transport cannot put on the wire (toon-client#581).
   * @throws {NetworkError} If network connection fails after retries
   * @throws {ConnectorError} If connector returns 5xx server error
   */
  async sendIlpPacket(params: IlpSendParams): Promise<IlpSendResult> {
    // Validate request parameters
    this.validateRequest(params);
    this.refuseUncarriablePacket(params);

    // Wrap HTTP request with retry logic
    return withRetry(async () => this.sendHttpRequest(params), {
      maxRetries: this.retryConfig.maxRetries,
      retryDelay: this.retryConfig.retryDelay,
      exponentialBackoff: true,
      shouldRetry: (error) => {
        // Only retry on network errors (ECONNREFUSED, ETIMEDOUT)
        // Do not retry on validation errors, 4xx, or 5xx errors
        return error instanceof NetworkError;
      },
    });
  }

  /**
   * Refuse a packet whose correctness depends on fields this transport cannot
   * put on the wire (toon-client#581) — see the class docs for why refusing
   * beats carrying-without-verifying, and why both beat silently dropping.
   *
   * Checked BEFORE any request is made, so a refused packet costs nothing and
   * spends no claim. Only the sender-chosen class is refused: an absent or
   * all-zero condition is the legacy class and passes through untouched.
   *
   * @throws {ValidationError} when a non-zero `executionCondition` or an
   *   explicit `expiresAt` is present.
   */
  private refuseUncarriablePacket(params: IlpSendParams): void {
    if (params.executionCondition !== undefined && !isLegacyCondition(params)) {
      throw new ValidationError(SEALED_PACKET_UNSUPPORTED_MESSAGE);
    }
    if (params.expiresAt !== undefined) {
      throw new ValidationError(EXPLICIT_EXPIRY_UNSUPPORTED_MESSAGE);
    }
  }

  /**
   * Validate ILP packet request parameters.
   *
   * @throws {ValidationError} If any parameter is invalid
   */
  private validateRequest(params: {
    destination: string;
    amount: string;
    data: string;
  }): void {
    // Validate destination: non-empty, valid ILP address format
    if (!params.destination || params.destination.trim() === '') {
      throw new ValidationError('Destination cannot be empty');
    }
    if (!params.destination.startsWith('g.')) {
      throw new ValidationError(
        `Invalid ILP address format: "${params.destination}" (must start with "g.")`
      );
    }

    // Validate amount: non-empty, parseable as bigint, positive
    if (!params.amount || params.amount.trim() === '') {
      throw new ValidationError('Amount cannot be empty');
    }
    try {
      const amountBigInt = BigInt(params.amount);
      if (amountBigInt <= 0n) {
        throw new ValidationError(
          `Amount must be positive: "${params.amount}"`
        );
      }
    } catch (error) {
      if (error instanceof ValidationError) throw error;
      throw new ValidationError(
        `Amount must be a valid integer: "${params.amount}"`,
        error instanceof Error ? error : undefined
      );
    }

    // Validate data: non-empty, valid Base64 encoding
    if (!params.data || params.data.trim() === '') {
      throw new ValidationError('Data cannot be empty');
    }
    try {
      if (!isBase64(params.data)) {
        throw new ValidationError(
          `Data must be valid Base64 encoding: "${params.data}"`
        );
      }
    } catch (error) {
      if (error instanceof ValidationError) throw error;
      throw new ValidationError(
        `Data must be valid Base64 encoding: "${params.data}"`,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Send HTTP POST request to connector runtime API.
   *
   * @throws {NetworkError} On connection failures (ECONNREFUSED, ETIMEDOUT)
   * @throws {ConnectorError} On 5xx server errors
   * @returns IlpSendResult with acceptance status
   */
  private async sendHttpRequest(params: {
    destination: string;
    amount: string;
    data: string;
    timeout?: number;
  }): Promise<IlpSendResult> {
    const requestTimeout = params.timeout ?? this.timeout;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), requestTimeout);

    try {
      // NOTE: Using admin endpoint /admin/ilp/send since connector doesn't have public /ilp endpoint yet
      const response = await this.httpClient(
        `${this.connectorUrl}/admin/ilp/send`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            destination: params.destination,
            amount: params.amount,
            data: params.data,
          }),
          signal: controller.signal,
        }
      );

      clearTimeout(timeoutId);

      // Handle response by status code
      if (response.ok) {
        // 200 OK: Parse response as IlpSendResult
        const result = (await response.json()) as Record<string, unknown>;
        return {
          accepted: (result['accepted'] as boolean) ?? false,
          data: result['data'] as string | undefined,
          code: result['code'] as string | undefined,
          message: result['message'] as string | undefined,
        };
      } else if (response.status >= 400 && response.status < 500) {
        // 4xx: Client error - return as failed ILP response (no retry)
        const errorBody = (await response.json().catch(() => ({}))) as Record<
          string,
          unknown
        >;
        return {
          accepted: false,
          code: `HTTP_${response.status}`,
          message:
            (errorBody['message'] as string) ??
            (errorBody['error'] as string) ??
            response.statusText,
        };
      } else if (response.status >= 500 && response.status < 600) {
        // 5xx: Server error - throw ConnectorError (no retry)
        const errorBody = (await response.json().catch(() => ({}))) as Record<
          string,
          unknown
        >;
        throw new ConnectorError(
          `Connector server error (${response.status}): ${
            (errorBody['message'] as string) ??
            (errorBody['error'] as string) ??
            response.statusText
          }`
        );
      }

      // Unexpected status code (not 2xx, 4xx, or 5xx)
      throw new ConnectorError(
        `Unexpected HTTP status: ${response.status} ${response.statusText}`
      );
    } catch (error) {
      clearTimeout(timeoutId);

      // Handle AbortController timeout
      if (error instanceof Error && error.name === 'AbortError') {
        throw new NetworkError(
          `Request timeout after ${requestTimeout}ms`,
          error
        );
      }

      // Handle network errors (ECONNREFUSED, ETIMEDOUT, etc.)
      if (
        error instanceof TypeError &&
        (error.message.includes('fetch failed') ||
          error.message.includes('ECONNREFUSED') ||
          error.message.includes('ETIMEDOUT') ||
          error.message.includes('network'))
      ) {
        throw new NetworkError(
          `Network connection failed: ${error.message}`,
          error
        );
      }

      // Re-throw known error types
      if (
        error instanceof NetworkError ||
        error instanceof ConnectorError ||
        error instanceof ValidationError
      ) {
        throw error;
      }

      // Unknown error
      throw new ConnectorError(
        `Unexpected error during HTTP request: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined
      );
    }
  }
}
