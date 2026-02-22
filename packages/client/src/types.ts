import type { IlpPeerInfo } from '@crosstown/core';
import type { NostrEvent } from 'nostr-tools/pure';

/**
 * Configuration for CrosstownClient.
 *
 * This story implements HTTP mode only. Embedded mode will be added in a future epic.
 *
 * @example HTTP Mode (implemented)
 * ```typescript
 * const client = new CrosstownClient({
 *   connectorUrl: 'http://localhost:8080',
 *   secretKey,
 *   ilpInfo: { ilpAddress, btpEndpoint, pubkey },
 *   toonEncoder: encodeEvent,
 *   toonDecoder: decodeEvent,
 * });
 * ```
 *
 * @example Embedded Mode (not yet implemented)
 * ```typescript
 * const client = new CrosstownClient({
 *   connector: embeddedConnectorInstance,  // Will throw error: "Embedded mode not yet implemented"
 *   secretKey,
 *   ilpInfo,
 *   toonEncoder,
 *   toonDecoder,
 * });
 * ```
 */
export interface CrosstownClientConfig {
  // ============================================================================
  // CONNECTOR (required for HTTP mode)
  // ============================================================================

  /**
   * HTTP URL of external connector service.
   * Required for HTTP mode.
   * Example: 'http://localhost:8080'
   */
  connectorUrl?: string;

  /**
   * Embedded connector instance - NOT IMPLEMENTED in this story.
   * Will throw error: "Embedded mode not yet implemented in CrosstownClient."
   * Reserved for future implementation.
   */
  connector?: unknown;

  // ============================================================================
  // IDENTITY (required)
  // ============================================================================

  /** 32-byte Nostr private key (hex or Uint8Array) */
  secretKey: Uint8Array;

  /** ILP peer information for this client */
  ilpInfo: IlpPeerInfo;

  // ============================================================================
  // TOON ENCODING (required)
  // ============================================================================

  /** Function to encode Nostr events to TOON binary format */
  toonEncoder: (event: NostrEvent) => Uint8Array;

  /** Function to decode TOON binary format to Nostr events */
  toonDecoder: (bytes: Uint8Array) => NostrEvent;

  // ============================================================================
  // NETWORK (optional with defaults)
  // ============================================================================

  /** Nostr relay URL for peer discovery. Default: 'ws://localhost:7100' */
  relayUrl?: string;

  // ============================================================================
  // TIMEOUTS & RETRIES (optional with defaults)
  // ============================================================================

  /** Query timeout in milliseconds. Default: 30000 */
  queryTimeout?: number;

  /** Maximum number of retries for failed operations. Default: 3 */
  maxRetries?: number;

  /** Delay between retries in milliseconds. Default: 1000 */
  retryDelay?: number;
}

/**
 * Result returned by CrosstownClient.start()
 */
export interface CrosstownStartResult {
  /** Number of peers discovered during bootstrap */
  peersDiscovered: number;

  /** Mode the client is running in */
  mode: 'http' | 'embedded';
}

/**
 * Result returned by CrosstownClient.publishEvent()
 */
export interface PublishEventResult {
  /** Whether the event was successfully published */
  success: boolean;

  /** ID of the published event */
  eventId?: string;

  /** ILP fulfillment from the relay (proof of payment) */
  fulfillment?: string;

  /** Error message if success is false */
  error?: string;
}
