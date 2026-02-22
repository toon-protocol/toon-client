import type { ConnectorAdminClient } from '@crosstown/core';
import {
  ValidationError,
  NetworkError,
  ConnectorError,
  UnauthorizedError,
  PeerNotFoundError,
  PeerAlreadyExistsError,
} from '../errors.js';
import { withRetry } from '../utils/retry.js';

/**
 * Configuration for HttpConnectorAdmin.
 */
export interface HttpConnectorAdminConfig {
  /** Admin API base URL (e.g., 'http://localhost:8081') */
  adminUrl: string;
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Maximum retry attempts for network failures (default: 3) */
  maxRetries?: number;
  /** Initial retry delay in milliseconds (default: 1000) */
  retryDelay?: number;
  /** HTTP client for testing (default: global fetch) */
  httpClient?: typeof fetch;
}

/**
 * Result of a bulk peer operation.
 */
export interface PeerOperationResult {
  /** Peer ID that was operated on */
  peerId: string;
  /** Whether the operation succeeded */
  success: boolean;
  /** Error that occurred (if failed) */
  error?: Error;
}

/**
 * HTTP-based connector admin client for managing ILP peers via REST API.
 *
 * Implements the ConnectorAdminClient interface using HTTP requests to the
 * connector's admin API (typically port 8081).
 *
 * @example
 * ```typescript
 * // Embedded mode (DirectConnectorAdmin)
 * const adminClient = new DirectConnectorAdmin(connectorNode);
 *
 * // HTTP mode (HttpConnectorAdmin)
 * const adminClient = new HttpConnectorAdmin({
 *   adminUrl: 'http://localhost:8081'
 * });
 *
 * // Add peer
 * await adminClient.addPeer({
 *   id: 'nostr-abc123',
 *   url: 'btp+ws://alice.example.com:3000',
 *   authToken: 'secret-token',
 *   routes: [{ prefix: 'g.crosstown.alice' }]
 * });
 *
 * // Remove peer
 * await adminClient.removePeer('nostr-abc123');
 * ```
 *
 * @throws {ValidationError} Input validation failed (before HTTP request)
 * @throws {NetworkError} Connection failed (ECONNREFUSED, ETIMEDOUT)
 * @throws {UnauthorizedError} Admin API returned 401 (missing/invalid auth)
 * @throws {PeerAlreadyExistsError} Admin API returned 409 (duplicate peer)
 * @throws {PeerNotFoundError} Admin API returned 404 (peer not found)
 * @throws {ConnectorError} Admin API returned 5xx (server error)
 */
export class HttpConnectorAdmin implements ConnectorAdminClient {
  private readonly adminUrl: string;
  private readonly timeout: number;
  private readonly retryConfig: { maxRetries: number; retryDelay: number };
  private readonly httpClient: typeof fetch;

  constructor(config: HttpConnectorAdminConfig) {
    this.adminUrl = config.adminUrl.replace(/\/$/, ''); // Remove trailing slash
    this.timeout = config.timeout ?? 30000;
    this.retryConfig = {
      maxRetries: config.maxRetries ?? 3,
      retryDelay: config.retryDelay ?? 1000,
    };
    this.httpClient = config.httpClient ?? fetch;
  }

  /**
   * Add a peer to the connector via the admin API.
   *
   * Validates peer config parameters and sends HTTP POST to /admin/peers.
   *
   * @param config - Peer configuration
   * @param config.id - Unique peer identifier (non-empty string)
   * @param config.url - BTP WebSocket URL (must start with 'btp+ws://' or 'btp+wss://')
   * @param config.authToken - Authentication token (non-empty string)
   * @param config.routes - Optional routing table entries
   * @param config.settlement - Optional settlement configuration
   *
   * @throws {ValidationError} Invalid peer config (missing id, invalid url, etc.)
   * @throws {PeerAlreadyExistsError} Peer with same ID already exists (409 Conflict)
   * @throws {UnauthorizedError} Admin API authentication failed (401)
   * @throws {NetworkError} Connection to admin API failed
   * @throws {ConnectorError} Admin API server error (5xx)
   */
  async addPeer(config: {
    id: string;
    url: string;
    authToken: string;
    routes?: { prefix: string; priority?: number }[];
    settlement?: {
      preference: string;
      evmAddress?: string;
      tokenAddress?: string;
      tokenNetworkAddress?: string;
      chainId?: number;
      channelId?: string;
      initialDeposit?: string;
    };
  }): Promise<void> {
    // Validate required fields
    if (!config.id || typeof config.id !== 'string' || config.id.trim() === '') {
      throw new ValidationError('Peer id must be a non-empty string');
    }

    if (!config.url || typeof config.url !== 'string' || config.url.trim() === '') {
      throw new ValidationError('Peer url must be a non-empty string');
    }

    // Validate BTP URL format (accept both ws:// and btp+ws:// formats)
    const hasWsPrefix = config.url.startsWith('ws://') || config.url.startsWith('wss://');
    const hasBtpPrefix = config.url.startsWith('btp+ws://') || config.url.startsWith('btp+wss://');

    if (!hasWsPrefix && !hasBtpPrefix) {
      throw new ValidationError(
        `Invalid BTP URL format: "${config.url}". Must start with 'ws://', 'wss://', 'btp+ws://', or 'btp+wss://'`
      );
    }

    // authToken can be empty string for BTP (doesn't require authentication)
    if (config.authToken === undefined || config.authToken === null || typeof config.authToken !== 'string') {
      throw new ValidationError('Peer authToken must be a string (can be empty for no auth)');
    }

    // Validate routes (if provided)
    if (config.routes !== undefined) {
      if (!Array.isArray(config.routes)) {
        throw new ValidationError('Peer routes must be an array');
      }

      for (const route of config.routes) {
        if (!route.prefix || typeof route.prefix !== 'string' || route.prefix.trim() === '') {
          throw new ValidationError('Route prefix must be a non-empty string');
        }
        if (route.priority !== undefined && typeof route.priority !== 'number') {
          throw new ValidationError('Route priority must be a number');
        }
      }
    }

    // Validate settlement (if provided)
    if (config.settlement !== undefined) {
      if (typeof config.settlement !== 'object' || config.settlement === null) {
        throw new ValidationError('Peer settlement must be an object');
      }

      if (!config.settlement.preference || typeof config.settlement.preference !== 'string') {
        throw new ValidationError('Settlement preference must be a non-empty string');
      }
    }

    // Send HTTP POST request with retry logic
    const url = `${this.adminUrl}/admin/peers`;

    await withRetry(
      async () => this.sendAddPeerRequest(url, config),
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
   * Remove a peer from the connector via the admin API.
   *
   * Sends HTTP DELETE to /admin/peers/:id.
   *
   * @param peerId - Unique peer identifier to remove (non-empty string)
   *
   * @throws {ValidationError} Invalid peerId (empty string)
   * @throws {PeerNotFoundError} Peer does not exist (404 Not Found)
   * @throws {UnauthorizedError} Admin API authentication failed (401)
   * @throws {NetworkError} Connection to admin API failed
   * @throws {ConnectorError} Admin API server error (5xx)
   */
  async removePeer(peerId: string): Promise<void> {
    // Validate peerId
    if (!peerId || typeof peerId !== 'string' || peerId.trim() === '') {
      throw new ValidationError('peerId must be a non-empty string');
    }

    // Send HTTP DELETE request with retry logic
    const url = `${this.adminUrl}/admin/peers/${encodeURIComponent(peerId)}`;

    await withRetry(
      async () => this.sendRemovePeerRequest(url, peerId),
      {
        maxRetries: this.retryConfig.maxRetries,
        retryDelay: this.retryConfig.retryDelay,
        exponentialBackoff: true,
        shouldRetry: (error) => {
          // Only retry on network errors
          return error instanceof NetworkError;
        },
      }
    );
  }

  /**
   * Add multiple peers in parallel for efficient bootstrapping.
   *
   * Uses Promise.allSettled() to execute peer additions concurrently,
   * returning results for each operation regardless of individual failures.
   *
   * @param configs - Array of peer configurations to add
   * @returns Array of results indicating success/failure for each peer
   *
   * @example
   * ```typescript
   * const results = await admin.addPeers([
   *   { id: 'peer1', url: 'btp+ws://...', authToken: 'token1' },
   *   { id: 'peer2', url: 'btp+ws://...', authToken: 'token2' },
   * ]);
   *
   * results.forEach(result => {
   *   if (result.success) {
   *     console.log(`Added peer: ${result.peerId}`);
   *   } else {
   *     console.error(`Failed to add ${result.peerId}:`, result.error);
   *   }
   * });
   * ```
   */
  async addPeers(
    configs: {
      id: string;
      url: string;
      authToken: string;
      routes?: { prefix: string; priority?: number }[];
      settlement?: {
        preference: string;
        evmAddress?: string;
        tokenAddress?: string;
        tokenNetworkAddress?: string;
        chainId?: number;
        channelId?: string;
        initialDeposit?: string;
      };
    }[]
  ): Promise<PeerOperationResult[]> {
    const results = await Promise.allSettled(
      configs.map((config) => this.addPeer(config))
    );

    return results.map((result, index) => ({
      peerId: configs[index]!.id,
      success: result.status === 'fulfilled',
      error: result.status === 'rejected' ? result.reason : undefined,
    }));
  }

  /**
   * Remove multiple peers in parallel.
   *
   * Uses Promise.allSettled() to execute peer removals concurrently,
   * returning results for each operation regardless of individual failures.
   *
   * @param peerIds - Array of peer IDs to remove
   * @returns Array of results indicating success/failure for each peer
   *
   * @example
   * ```typescript
   * const results = await admin.removePeers(['peer1', 'peer2', 'peer3']);
   *
   * const succeeded = results.filter(r => r.success).length;
   * console.log(`Removed ${succeeded}/${results.length} peers`);
   * ```
   */
  async removePeers(peerIds: string[]): Promise<PeerOperationResult[]> {
    const results = await Promise.allSettled(
      peerIds.map((peerId) => this.removePeer(peerId))
    );

    return results.map((result, index) => ({
      peerId: peerIds[index]!,
      success: result.status === 'fulfilled',
      error: result.status === 'rejected' ? result.reason : undefined,
    }));
  }

  /**
   * Send HTTP POST request to add a peer.
   * Separated for retry logic wrapping.
   */
  private async sendAddPeerRequest(
    url: string,
    config: {
      id: string;
      url: string;
      authToken: string;
      routes?: { prefix: string; priority?: number }[];
      settlement?: {
        preference: string;
        evmAddress?: string;
        tokenAddress?: string;
        tokenNetworkAddress?: string;
        chainId?: number;
        channelId?: string;
        initialDeposit?: string;
      };
    }
  ): Promise<void> {
    // Normalize URL for connector API (expects ws:// or wss://)
    // Strip btp+ prefix if present, or use as-is if already plain ws://
    let connectorUrl = config.url;
    if (connectorUrl.startsWith('btp+')) {
      connectorUrl = connectorUrl.replace(/^btp\+/, '');
    }

    try {
      const response = await this.httpClient(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ...config,
          url: connectorUrl,
        }),
        signal: AbortSignal.timeout(this.timeout),
      });

      if (response.ok) {
        return; // Success (201 Created)
      }

      // Handle error responses
      await this.handleErrorResponse(response, `POST ${url}`, config.id);
    } catch (error) {
      this.handleNetworkError(error, url, 'addPeer');
    }
  }

  /**
   * Send HTTP DELETE request to remove a peer.
   * Separated for retry logic wrapping.
   */
  private async sendRemovePeerRequest(url: string, peerId: string): Promise<void> {
    try {
      const response = await this.httpClient(url, {
        method: 'DELETE',
        signal: AbortSignal.timeout(this.timeout),
      });

      if (response.ok) {
        return; // Success (204 No Content)
      }

      // Handle error responses
      await this.handleErrorResponse(response, `DELETE ${url}`, peerId);
    } catch (error) {
      this.handleNetworkError(error, url, 'removePeer');
    }
  }

  /**
   * Handle network errors from HTTP requests.
   *
   * Converts connection failures, timeouts, and unknown errors to NetworkError.
   * Re-throws existing CrosstownClientError instances.
   *
   * @param error - Error thrown by HTTP client
   * @param url - Request URL (for error messages)
   * @param operation - Operation name (for error messages)
   * @throws {NetworkError} Network connection or timeout error
   */
  private handleNetworkError(error: unknown, url: string, operation: string): never {
    // Timeout errors (AbortSignal)
    if (error instanceof Error && error.name === 'AbortError') {
      throw new NetworkError(
        `Request to ${url} timed out after ${this.timeout}ms`,
        error
      );
    }

    // Connection errors (ECONNREFUSED, ETIMEDOUT, DNS failures)
    if (error instanceof Error &&
        (error.message.includes('ECONNREFUSED') ||
         error.message.includes('ETIMEDOUT') ||
         error.message.includes('ENOTFOUND'))) {
      throw new NetworkError(
        `Failed to connect to connector admin API at ${url}: ${error.message}`,
        error
      );
    }

    // Re-throw if already a CrosstownClientError
    if (error instanceof ValidationError ||
        error instanceof PeerAlreadyExistsError ||
        error instanceof PeerNotFoundError ||
        error instanceof UnauthorizedError ||
        error instanceof ConnectorError) {
      throw error;
    }

    // Unknown error - wrap in NetworkError
    throw new NetworkError(
      `Unexpected error during ${operation}: ${error instanceof Error ? error.message : String(error)}`,
      error instanceof Error ? error : undefined
    );
  }

  /**
   * Handle HTTP error responses from the admin API.
   *
   * Converts HTTP status codes to appropriate error types.
   *
   * @param response - HTTP response from admin API
   * @param endpoint - Endpoint being called (for error messages)
   * @param peerId - Peer ID (for error messages)
   * @throws {UnauthorizedError} 401 Unauthorized
   * @throws {PeerNotFoundError} 404 Not Found
   * @throws {PeerAlreadyExistsError} 409 Conflict
   * @throws {ConnectorError} 5xx Server Error
   */
  private async handleErrorResponse(
    response: Response,
    endpoint: string,
    peerId: string
  ): Promise<never> {
    const status = response.status;
    const statusText = response.statusText;

    // Try to extract error message from response body
    let errorMessage = '';
    try {
      const body = await response.text();
      if (body) {
        errorMessage = ` - ${body}`;
      }
    } catch {
      // Ignore body parsing errors
    }

    switch (status) {
      case 401:
        throw new UnauthorizedError(
          `Admin API authentication failed for ${endpoint}: ${statusText}${errorMessage}`
        );

      case 404:
        throw new PeerNotFoundError(
          `Peer not found: "${peerId}" (${endpoint}): ${statusText}${errorMessage}`
        );

      case 409:
        throw new PeerAlreadyExistsError(
          `Peer already exists: "${peerId}" (${endpoint}): ${statusText}${errorMessage}`
        );

      default:
        if (status >= 500) {
          throw new ConnectorError(
            `Connector admin API error (${endpoint}): ${status} ${statusText}${errorMessage}`
          );
        }

        // Other 4xx errors (400, 403, etc.)
        throw new ConnectorError(
          `Admin API error (${endpoint}): ${status} ${statusText}${errorMessage}`
        );
    }
  }
}
