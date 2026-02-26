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

  /**
   * 32-byte Nostr private key (hex or Uint8Array).
   * Optional — if omitted, a keypair is auto-generated in applyDefaults().
   */
  secretKey?: Uint8Array;

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
  // EVM IDENTITY (optional)
  // ============================================================================

  /** EVM private key for signing balance proofs and on-chain transactions */
  evmPrivateKey?: string | Uint8Array;

  // ============================================================================
  // SETTLEMENT PREFERENCES (optional)
  // ============================================================================

  /** Supported settlement chain identifiers (e.g., ["evm:anvil:31337"]) */
  supportedChains?: string[];

  /** Maps chain identifier to EVM settlement address */
  settlementAddresses?: Record<string, string>;

  /** Maps chain identifier to preferred token contract address */
  preferredTokens?: Record<string, string>;

  /** Maps chain identifier to TokenNetwork contract address (EVM only) */
  tokenNetworks?: Record<string, string>;

  // ============================================================================
  // BTP TRANSPORT (optional)
  // ============================================================================

  /** BTP WebSocket URL (e.g., "ws://localhost:3000") */
  btpUrl?: string;

  /** Auth token for BTP handshake */
  btpAuthToken?: string;

  /** Peer ID for BTP connection (used in connector env var BTP_PEER_{ID}_SECRET) */
  btpPeerId?: string;

  // ============================================================================
  // ON-CHAIN INTERACTION (optional)
  // ============================================================================

  /** Maps chain identifier to RPC URL (e.g., {"evm:anvil:31337": "http://localhost:8545"}) */
  chainRpcUrls?: Record<string, string>;

  /** Amount to deposit when opening channel (default: "0") */
  initialDeposit?: string;

  /** Challenge period in seconds (default: 86400) */
  settlementTimeout?: number;

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

/**
 * Parameters for signing a balance proof.
 */
export interface BalanceProofParams {
  /** Payment channel identifier */
  channelId: string;
  /** Monotonically increasing nonce */
  nonce: number;
  /** Cumulative amount transferred */
  transferredAmount: bigint;
  /** Amount locked in pending transfers */
  lockedAmount: bigint;
  /** Merkle root of pending lock hashes */
  locksRoot: string;
}

/**
 * A signed balance proof with EIP-712 signature.
 */
export interface SignedBalanceProof extends BalanceProofParams {
  /** EIP-712 signature */
  signature: string;
  /** Address of the signer */
  signerAddress: string;
}
