import { SimplePool } from 'nostr-tools/pool';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';
import type { BootstrapService, RelayMonitor, IlpSendResult, AgentRuntimeClient } from '@crosstown/core';
import { validateConfig, applyDefaults } from './config.js';
import type { ResolvedConfig } from './config.js';
import { initializeHttpMode } from './modes/http.js';
import { CrosstownClientError } from './errors.js';
import { EvmSigner } from './signing/evm-signer.js';
import { ChannelManager } from './channel/ChannelManager.js';
import type { BtpRuntimeClient } from './adapters/BtpRuntimeClient.js';
import type {
  CrosstownClientConfig,
  CrosstownStartResult,
  PublishEventResult,
  SignedBalanceProof,
} from './types.js';

/**
 * Internal state for CrosstownClient after initialization.
 */
interface CrosstownClientState {
  bootstrapService: BootstrapService;
  relayMonitor: RelayMonitor;
  subscription: any; // Subscription from relayMonitor.start()
  runtimeClient: AgentRuntimeClient;
  peersDiscovered: number;
  btpClient?: BtpRuntimeClient;
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
  private readonly config: ResolvedConfig;
  private readonly pool: SimplePool;
  private state: CrosstownClientState | null = null;
  private readonly evmSigner?: EvmSigner;
  private channelManager?: ChannelManager;

  /**
   * Creates a new CrosstownClient instance.
   *
   * @param config - Client configuration
   * @throws {ValidationError} If configuration is invalid
   */
  constructor(config: CrosstownClientConfig) {
    // Validate config (will reject embedded mode, require connectorUrl)
    validateConfig(config);

    // Apply defaults to optional fields (auto-generates secretKey if needed)
    this.config = applyDefaults(config);

    // Create shared SimplePool instance
    this.pool = new SimplePool();

    // Create EVM signer if private key provided
    if (this.config.evmPrivateKey) {
      this.evmSigner = new EvmSigner(this.config.evmPrivateKey);
    }
  }

  /**
   * Generates a new Nostr keypair.
   *
   * @returns Object with secretKey (Uint8Array) and pubkey (hex string)
   */
  static generateKeypair(): { secretKey: Uint8Array; pubkey: string } {
    const secretKey = generateSecretKey();
    const pubkey = getPublicKey(secretKey);
    return { secretKey, pubkey };
  }

  /**
   * Gets the Nostr public key derived from the secret key.
   * Works before start() is called.
   */
  getPublicKey(): string {
    return getPublicKey(this.config.secretKey);
  }

  /**
   * Gets the EVM address if an EVM private key was configured.
   */
  getEvmAddress(): string | undefined {
    return this.evmSigner?.address;
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
      // Create channel manager FIRST (before bootstrap) so it can sign claims during handshake
      if (this.evmSigner) {
        this.channelManager = new ChannelManager(this.evmSigner);
      }

      // Initialize HTTP mode components
      const initialization = await initializeHttpMode(this.config, this.pool);

      const { bootstrapService, relayMonitor, runtimeClient, btpClient } = initialization;

      // Wire claim signer to bootstrap service if we have channel manager
      if (this.channelManager) {
        bootstrapService.setClaimSigner(async (channelId: string, amount: bigint) => {
          // Track the channel if not already tracked
          if (!this.channelManager!.isTracking(channelId)) {
            this.channelManager!.trackChannel(channelId);
          }
          // Sign balance proof and return claim
          return this.channelManager!.signBalanceProof(channelId, amount);
        });
      }

      // Start bootstrap process (discover peers, handshake with signed claims, announce)
      const bootstrapResults = await bootstrapService.bootstrap();

      // Track any additional channels from bootstrap results
      if (this.channelManager) {
        for (const result of bootstrapResults) {
          if (result.channelId && !this.channelManager.isTracking(result.channelId)) {
            this.channelManager.trackChannel(result.channelId);
          }
        }
      }

      // Start relay monitoring (watch for new kind:10032 events)
      const subscription = relayMonitor.start();

      // Store state
      this.state = {
        bootstrapService,
        relayMonitor,
        subscription,
        runtimeClient,
        peersDiscovered: bootstrapResults.length,
        btpClient: btpClient ?? undefined,
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
   * @param options - Optional options including a signed balance proof claim
   * @returns Result with success status, event ID, and fulfillment
   * @throws {CrosstownClientError} If client is not started
   * @throws {CrosstownClientError} If event publishing fails
   */
  async publishEvent(
    event: NostrEvent,
    options?: { claim?: SignedBalanceProof }
  ): Promise<PublishEventResult> {
    if (!this.state) {
      throw new CrosstownClientError(
        'Client not started. Call start() first.',
        'INVALID_STATE'
      );
    }

    try {
      // Encode event to TOON format
      const toonData = this.config.toonEncoder(event);

      // Calculate payment amount: basePricePerByte * encoded size
      const basePricePerByte = 10n;
      const amount = String(BigInt(toonData.length) * basePricePerByte);

      let response: IlpSendResult;

      // If claim provided and BTP client available, send with claim
      if (options?.claim && this.state.btpClient) {
        const claimMessage = EvmSigner.buildClaimMessage(options.claim, this.getPublicKey());
        response = await this.state.btpClient.sendIlpPacketWithClaim(
          {
            destination: 'g.crosstown.relay',
            amount,
            data: Buffer.from(toonData).toString('base64'),
          },
          claimMessage
        );
      } else {
        // Send ILP packet via runtime client
        response = await this.state.runtimeClient.sendIlpPacket({
          destination: 'g.crosstown.relay',
          amount,
          data: Buffer.from(toonData).toString('base64'),
        });
      }

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
   * Signs a balance proof for the given channel with the specified amount.
   * Delegates to ChannelManager which auto-increments nonce and tracks cumulative amount.
   *
   * @param channelId - Payment channel identifier
   * @param amount - Additional amount to add to cumulative transferred amount
   * @returns Signed balance proof
   * @throws {CrosstownClientError} If no EVM signer configured or channel not tracked
   */
  async signBalanceProof(channelId: string, amount: bigint): Promise<SignedBalanceProof> {
    if (!this.channelManager) {
      throw new CrosstownClientError(
        'No EVM signer configured. Provide evmPrivateKey in config.',
        'NO_EVM_SIGNER'
      );
    }
    return this.channelManager.signBalanceProof(channelId, amount);
  }

  /**
   * Gets list of tracked payment channel IDs.
   */
  getTrackedChannels(): string[] {
    return this.channelManager?.getTrackedChannels() ?? [];
  }

  /**
   * Sends an ILP payment, optionally with a balance proof claim via BTP.
   *
   * @param params - Payment parameters
   * @returns ILP send result
   * @throws {CrosstownClientError} If client is not started
   */
  async sendPayment(params: {
    destination: string;
    amount: string;
    data?: string;
    claim?: SignedBalanceProof;
  }): Promise<IlpSendResult> {
    if (!this.state) {
      throw new CrosstownClientError(
        'Client not started. Call start() first.',
        'INVALID_STATE'
      );
    }

    const ilpParams = {
      destination: params.destination,
      amount: params.amount,
      data: params.data ?? '',
    };

    if (params.claim && this.state.btpClient) {
      const claimMessage = EvmSigner.buildClaimMessage(params.claim, this.getPublicKey());
      return this.state.btpClient.sendIlpPacketWithClaim(ilpParams, claimMessage);
    }

    return this.state.runtimeClient.sendIlpPacket(ilpParams);
  }

  /**
   * Stops the CrosstownClient and cleans up resources.
   *
   * This will:
   * 1. Disconnect BTP client if connected
   * 2. Stop relay monitoring
   * 3. Close SimplePool connections
   * 4. Clear internal state
   *
   * @throws {CrosstownClientError} If client is not started
   */
  async stop(): Promise<void> {
    if (!this.state) {
      throw new CrosstownClientError('Client not started', 'INVALID_STATE');
    }

    try {
      // Disconnect BTP client if connected
      if (this.state.btpClient) {
        await this.state.btpClient.disconnect();
      }

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
