import type { AgentRuntimeClient, IlpSendResult } from '@crosstown/core';
import { NetworkError, ConnectorError, ValidationError } from '../errors.js';
import { withRetry } from '../utils/retry.js';

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
 * HTTP client for sending ILP packets to an external connector runtime API.
 *
 * Implements the AgentRuntimeClient interface for use with Crosstown agents
 * that need to send ILP packets without embedding a full connector.
 *
 * Features:
 * - Request validation (destination, amount, data)
 * - Retry logic with exponential backoff for transient network failures
 * - Typed error handling (NetworkError, ConnectorError, ValidationError)
 * - Connection pooling and keep-alive (via Node.js fetch)
 *
 * @example
 * ```typescript
 * const client = new HttpRuntimeClient({
 *   connectorUrl: 'http://localhost:8080'
 * });
 *
 * const result = await client.sendIlpPacket({
 *   destination: 'g.crosstown.alice',
 *   amount: '1000',
 *   data: 'base64EncodedToonData==',
 * });
 *
 * if (result.accepted) {
 *   console.log('Payment accepted:', result.fulfillment);
 * } else {
 *   console.error('Payment rejected:', result.code, result.message);
 * }
 * ```
 */
export class HttpRuntimeClient implements AgentRuntimeClient {
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
   * @throws {ValidationError} If request parameters are invalid
   * @throws {NetworkError} If network connection fails after retries
   * @throws {ConnectorError} If connector returns 5xx server error
   */
  async sendIlpPacket(params: {
    destination: string;
    amount: string;
    data: string;
    timeout?: number;
  }): Promise<IlpSendResult> {
    // Validate request parameters
    this.validateRequest(params);

    // Wrap HTTP request with retry logic
    return withRetry(
      async () => this.sendHttpRequest(params),
      {
        maxRetries: this.retryConfig.maxRetries,
        retryDelay: this.retryConfig.retryDelay,
        exponentialBackoff: true,
        shouldRetry: (error) => {
          // Only retry on network errors (ECONNREFUSED, ETIMEDOUT)
          // Do not retry on validation errors, 4xx, or 5xx errors
          return error instanceof NetworkError;
        },
      }
    );
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
      if (amountBigInt < 0n) {
        throw new ValidationError(
          `Amount must be non-negative: "${params.amount}"`
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
      // Attempt to decode Base64 to validate format
      Buffer.from(params.data, 'base64');
      // Verify it's actually Base64 (not just any string Buffer accepts)
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(params.data)) {
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
      const response = await this.httpClient(`${this.connectorUrl}/admin/ilp/send`, {
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
      });

      clearTimeout(timeoutId);

      // Handle response by status code
      if (response.ok) {
        // 200 OK: Parse response as IlpSendResult
        const result = (await response.json()) as any;
        return {
          accepted: result.accepted ?? false,
          fulfillment: result.fulfillment,
          data: result.data,
          code: result.code,
          message: result.message,
        };
      } else if (response.status >= 400 && response.status < 500) {
        // 4xx: Client error - return as failed ILP response (no retry)
        const errorBody = (await response.json().catch(() => ({}))) as any;
        return {
          accepted: false,
          code: `HTTP_${response.status}`,
          message: errorBody.message ?? errorBody.error ?? response.statusText,
        };
      } else if (response.status >= 500 && response.status < 600) {
        // 5xx: Server error - throw ConnectorError (no retry)
        const errorBody = (await response.json().catch(() => ({}))) as any;
        throw new ConnectorError(
          `Connector server error (${response.status}): ${
            errorBody.message ?? errorBody.error ?? response.statusText
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
