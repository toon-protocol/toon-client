import { SimplePool } from 'nostr-tools/pool';
import type { NostrEvent } from 'nostr-tools/pure';
import type { BootstrapService, RelayMonitor } from '@crosstown/core';
import { validateConfig, applyDefaults } from './config.js';
import { initializeHttpMode } from './modes/http.js';
import { CrosstownClientError } from './errors.js';
import type {
  CrosstownClientConfig,
  CrosstownStartResult,
  PublishEventResult,
} from './types.js';
import type { HttpRuntimeClient } from './adapters/HttpRuntimeClient.js';
import type { HttpConnectorAdmin } from './adapters/HttpConnectorAdmin.js';

/**
 * Internal state for CrosstownClient after initialization.
 */
interface CrosstownClientState {
  bootstrapService: BootstrapService;
  relayMonitor: RelayMonitor;
  subscription: any; // Subscription from relayMonitor.start()
  runtimeClient: HttpRuntimeClient;
  adminClient: HttpConnectorAdmin;
  channelClient: null; // HTTP mode only for now
  peersDiscovered: number; // Track peers discovered during bootstrap
}

/**
 * CrosstownClient - High-level client for interacting with Crosstown network.
 *
 * This story implements HTTP mode only. Embedded mode will be added in a future epic.
 *
 * @example HTTP Mode
 * ```typescript
 * import { CrosstownClient } from '@crosstown/client';
 * import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
 * import { encodeEvent, decodeEvent } from '@crosstown/relay';
 *
 * const secretKey = generateSecretKey();
 * const pubkey = getPublicKey(secretKey);
 *
 * const client = new CrosstownClient({
 *   connectorUrl: 'http://localhost:8080',
 *   secretKey,
 *   ilpInfo: {
 *     pubkey,
 *     ilpAddress: `g.crosstown.${pubkey.slice(0, 8)}`,
 *     btpEndpoint: 'ws://localhost:3000',
 *   },
 *   toonEncoder: encodeEvent,
 *   toonDecoder: decodeEvent,
 * });
 *
 * await client.start(); // Bootstrap peers, start monitoring
 * await client.publishEvent(signedEvent); // Publish to relay via ILP
 * await client.stop(); // Cleanup
 * ```
 */
export class CrosstownClient {
  private readonly config: Required<Omit<CrosstownClientConfig, 'connector'>> & {
    connector?: unknown;
  };
  private readonly pool: SimplePool;
  private state: CrosstownClientState | null = null;

  /**
   * Creates a new CrosstownClient instance.
   *
   * @param config - Client configuration
   * @throws {ValidationError} If configuration is invalid
   */
  constructor(config: CrosstownClientConfig) {
    // Validate config (will reject embedded mode, require connectorUrl)
    validateConfig(config);

    // Apply defaults to optional fields
    this.config = applyDefaults(config);

    // Create shared SimplePool instance
    this.pool = new SimplePool();
  }

  /**
   * Starts the CrosstownClient.
   *
   * This will:
   * 1. Initialize HTTP mode components (runtime client, admin client, bootstrap, monitor)
   * 2. Bootstrap the network (discover and handshake with peers)
   * 3. Start monitoring relay for new peers (kind:10032 events)
   *
   * @returns Result with number of peers discovered and mode
   * @throws {CrosstownClientError} If client is already started
   * @throws {CrosstownClientError} If initialization fails
   */
  async start(): Promise<CrosstownStartResult> {
    if (this.state !== null) {
      throw new CrosstownClientError('Client already started', 'INVALID_STATE');
    }

    try {
      // Initialize HTTP mode components
      // Note: validateConfig already ensured connector is not provided and connectorUrl is valid
      const initialization = await initializeHttpMode(this.config, this.pool);

      const { bootstrapService, relayMonitor, runtimeClient, adminClient, channelClient } =
        initialization;

      // Start bootstrap process (discover peers, handshake, announce)
      const bootstrapResults = await bootstrapService.bootstrap();

      // Start relay monitoring (watch for new kind:10032 events)
      const subscription = relayMonitor.start();

      // Store state
      this.state = {
        bootstrapService,
        relayMonitor,
        subscription,
        runtimeClient,
        adminClient,
        channelClient,
        peersDiscovered: bootstrapResults.length,
      };

      return {
        peersDiscovered: bootstrapResults.length,
        mode: 'http',
      };
    } catch (error) {
      throw new CrosstownClientError(
        'Failed to start client',
        'INITIALIZATION_ERROR',
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Publishes a Nostr event to the relay via ILP payment.
   *
   * The event must already be finalized (signed with id, pubkey, sig).
   *
   * @param event - Signed Nostr event to publish
   * @returns Result with success status, event ID, and fulfillment
   * @throws {CrosstownClientError} If client is not started
   * @throws {CrosstownClientError} If event publishing fails
   */
  async publishEvent(event: NostrEvent): Promise<PublishEventResult> {
    if (!this.state) {
      throw new CrosstownClientError(
        'Client not started. Call start() first.',
        'INVALID_STATE'
      );
    }

    try {
      // Encode event to TOON format
      const toonData = this.config.toonEncoder(event);

      // Send ILP packet via HTTP runtime client
      // Note: In HTTP mode, the connector routes the packet to the relay BLS
      const response = await this.state.runtimeClient.sendIlpPacket({
        destination: 'g.crosstown.relay', // Replace with actual relay ILP address
        amount: '1000', // Replace with pricing calculation
        data: Buffer.from(toonData).toString('base64'),
      });

      if (!response.accepted) {
        return {
          success: false,
          error: `Event rejected: ${response.code} - ${response.message}`,
        };
      }

      return {
        success: true,
        eventId: event.id,
        fulfillment: response.fulfillment,
      };
    } catch (error) {
      throw new CrosstownClientError(
        'Failed to publish event',
        'PUBLISH_ERROR',
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Stops the CrosstownClient and cleans up resources.
   *
   * This will:
   * 1. Stop relay monitoring
   * 2. Close SimplePool connections
   * 3. Clear internal state
   *
   * @throws {CrosstownClientError} If client is not started
   */
  async stop(): Promise<void> {
    if (!this.state) {
      throw new CrosstownClientError('Client not started', 'INVALID_STATE');
    }

    try {
      // Stop relay monitoring subscription
      if (this.state.subscription) {
        this.state.subscription.close?.();
      }

      // Close SimplePool connections
      this.pool.close(Object.keys(this.pool));

      // Clear state
      this.state = null;
    } catch (error) {
      throw new CrosstownClientError(
        'Failed to stop client',
        'STOP_ERROR',
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Returns true if the client is currently started.
   */
  isStarted(): boolean {
    return this.state !== null;
  }

  /**
   * Gets the number of peers discovered during bootstrap.
   *
   * @returns Number of peers discovered
   * @throws {CrosstownClientError} If client is not started
   */
  getPeersCount(): number {
    if (!this.state) {
      throw new CrosstownClientError(
        'Client not started. Call start() first.',
        'INVALID_STATE'
      );
    }

    return this.state.peersDiscovered;
  }

  /**
   * Gets the list of peers discovered by the relay monitor.
   *
   * @returns Array of discovered peer objects
   * @throws {CrosstownClientError} If client is not started
   */
  getDiscoveredPeers() {
    if (!this.state) {
      throw new CrosstownClientError(
        'Client not started. Call start() first.',
        'INVALID_STATE'
      );
    }

    return this.state.relayMonitor.getDiscoveredPeers();
  }
}
