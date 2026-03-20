import { createHash } from 'crypto';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';
import type {
  BootstrapService,
  DiscoveryTracker,
  IlpSendResult,
  IlpClient,
} from '@toon-protocol/core';
import { validateConfig, applyDefaults } from './config.js';
import type { ResolvedConfig } from './config.js';
import { initializeHttpMode } from './modes/http.js';
import { ToonClientError } from './errors.js';
import { EvmSigner } from './signing/evm-signer.js';
import { ChannelManager } from './channel/ChannelManager.js';
import { JsonFileChannelStore } from './channel/ChannelStore.js';
import type { BtpRuntimeClient } from './adapters/BtpRuntimeClient.js';
import type {
  ToonClientConfig,
  ToonStartResult,
  PublishEventResult,
  SignedBalanceProof,
} from './types.js';

/**
 * Internal state for ToonClient after initialization.
 */
interface ToonClientState {
  bootstrapService: BootstrapService;
  discoveryTracker: DiscoveryTracker;
  runtimeClient: IlpClient;
  peersDiscovered: number;
  btpClient?: BtpRuntimeClient;
}

/**
 * ToonClient - High-level client for interacting with TOON network.
 *
 * This story implements HTTP mode only. Embedded mode will be added in a future epic.
 *
 * @example HTTP Mode
 * ```typescript
 * import { ToonClient } from '@toon-protocol/client';
 * import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
 * import { encodeEvent, decodeEvent } from '@toon-protocol/relay';
 *
 * const secretKey = generateSecretKey();
 * const pubkey = getPublicKey(secretKey);
 *
 * const client = new ToonClient({
 *   connectorUrl: 'http://localhost:8080',
 *   secretKey,
 *   ilpInfo: {
 *     pubkey,
 *     ilpAddress: `g.toon.${pubkey.slice(0, 8)}`,
 *     btpEndpoint: 'ws://localhost:3000',
 *   },
 *   toonEncoder: encodeEvent,
 *   toonDecoder: decodeEvent,
 * });
 *
 * await client.start(); // Bootstrap peers, start monitoring
 *
 * // Publish to default destination (from config)
 * await client.publishEvent(signedEvent);
 *
 * // Publish to specific destination (multi-hop routing)
 * await client.publishEvent(signedEvent, { destination: 'g.toon.peer1' });
 *
 * await client.stop(); // Cleanup
 * ```
 */
export class ToonClient {
  private readonly config: ResolvedConfig;
  private state: ToonClientState | null = null;
  private readonly evmSigner?: EvmSigner;
  private channelManager?: ChannelManager;

  /**
   * Creates a new ToonClient instance.
   *
   * @param config - Client configuration
   * @throws {ValidationError} If configuration is invalid
   */
  constructor(config: ToonClientConfig) {
    // Validate config (will reject embedded mode, require connectorUrl)
    validateConfig(config);

    // Apply defaults to optional fields (auto-generates secretKey if needed)
    this.config = applyDefaults(config);

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
   * Gets the EVM address derived from the Nostr secret key (or explicit evmPrivateKey override).
   */
  getEvmAddress(): string | undefined {
    return this.evmSigner?.address;
  }

  /**
   * Starts the ToonClient.
   *
   * This will:
   * 1. Initialize HTTP mode components (runtime client, admin client, bootstrap, monitor)
   * 2. Bootstrap the network (discover peers, register, and open channels)
   * 3. Start monitoring relay for new peers (kind:10032 events)
   *
   * @returns Result with number of peers discovered and mode
   * @throws {ToonClientError} If client is already started
   * @throws {ToonClientError} If initialization fails
   */
  async start(): Promise<ToonStartResult> {
    if (this.state !== null) {
      throw new ToonClientError('Client already started', 'INVALID_STATE');
    }

    try {
      // Create channel manager FIRST (before bootstrap) so it can sign claims during settlement
      if (this.evmSigner) {
        const store = this.config.channelStorePath
          ? new JsonFileChannelStore(this.config.channelStorePath)
          : undefined;
        this.channelManager = new ChannelManager(this.evmSigner, store);
      }

      // Initialize HTTP mode components
      const initialization = await initializeHttpMode(this.config);

      const { bootstrapService, discoveryTracker, runtimeClient, btpClient } =
        initialization;

      // Wire claim signer to bootstrap service if we have channel manager
      if (this.channelManager) {
        const cm = this.channelManager;
        const nostrPubkey = this.getPublicKey();
        // Derive default chain context from config (first supported chain)
        const defaultChainCtx = this.getDefaultChainContext();
        bootstrapService.setClaimSigner(
          async (channelId: string, amount: bigint) => {
            // Track the channel if not already tracked
            if (!cm.isTracking(channelId)) {
              cm.trackChannel(channelId, defaultChainCtx);
            }
            // Sign balance proof and build full claim message
            const proof = await cm.signBalanceProof(channelId, amount);
            return EvmSigner.buildClaimMessage(proof, nostrPubkey);
          }
        );
      }

      // Start bootstrap process (discover peers, register with settlement, announce)
      const bootstrapResults = await bootstrapService.bootstrap();

      // Track any additional channels from bootstrap results
      if (this.channelManager) {
        for (const result of bootstrapResults) {
          if (
            result.channelId &&
            !this.channelManager.isTracking(result.channelId)
          ) {
            const chainCtx = this.getChainContext(result.negotiatedChain);
            this.channelManager.trackChannel(
              result.channelId,
              chainCtx
            );
          }
        }
      }

      // Store state
      this.state = {
        bootstrapService,
        discoveryTracker,
        runtimeClient,
        peersDiscovered: bootstrapResults.length,
        btpClient: btpClient ?? undefined,
      };

      return {
        peersDiscovered: bootstrapResults.length,
        mode: 'http',
      };
    } catch (error) {
      throw new ToonClientError(
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
   * @param options - Optional options including destination and signed balance proof claim
   * @returns Result with success status, event ID, and fulfillment
   * @throws {ToonClientError} If client is not started
   * @throws {ToonClientError} If event publishing fails
   */
  async publishEvent(
    event: NostrEvent,
    options?: { destination?: string; claim?: SignedBalanceProof }
  ): Promise<PublishEventResult> {
    if (!this.state) {
      throw new ToonClientError(
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

      // Use provided destination or fall back to config default
      const destination =
        options?.destination ?? this.config.destinationAddress;

      // Compute ILP execution condition from raw TOON data bytes.
      // The connector's PaymentHandlerAdapter computes:
      //   fulfillment = SHA-256(raw_toon_bytes)
      // So condition = SHA-256(fulfillment) = SHA-256(SHA-256(raw_toon_bytes)).
      const fulfillment = createHash('sha256').update(Buffer.from(toonData)).digest();
      const executionCondition = createHash('sha256').update(fulfillment).digest();

      // Require claim + BTP — plain sendIlpPacket is only valid for
      // node-to-node forwarding (town.ts), not client-to-node.
      if (!options?.claim) {
        throw new ToonClientError(
          'Signed balance proof required. Call signBalanceProof() first.',
          'MISSING_CLAIM'
        );
      }
      if (!this.state.btpClient) {
        throw new ToonClientError(
          'BTP client required for publishing. Configure btpUrl.',
          'NO_BTP_CLIENT'
        );
      }

      const claimMessage = EvmSigner.buildClaimMessage(
        options.claim,
        this.getPublicKey()
      );
      const response = await this.state.btpClient.sendIlpPacketWithClaim(
        {
          destination,
          amount,
          data: Buffer.from(toonData).toString('base64'),
          executionCondition,
        },
        claimMessage
      );

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
      throw new ToonClientError(
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
   * @throws {ToonClientError} If no EVM signer configured or channel not tracked
   */
  async signBalanceProof(
    channelId: string,
    amount: bigint
  ): Promise<SignedBalanceProof> {
    if (!this.channelManager) {
      throw new ToonClientError(
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
   * Gets the current nonce for a tracked channel.
   */
  getChannelNonce(channelId: string): number {
    if (!this.channelManager) throw new Error('ChannelManager not initialized');
    return this.channelManager.getNonce(channelId);
  }

  /**
   * Gets the cumulative transferred amount for a tracked channel.
   */
  getChannelCumulativeAmount(channelId: string): bigint {
    if (!this.channelManager) throw new Error('ChannelManager not initialized');
    return this.channelManager.getCumulativeAmount(channelId);
  }

  /**
   * Extracts chain context (chainId + tokenNetworkAddress) from a chain key like 'evm:base:421614'.
   */
  private getChainContext(
    negotiatedChain?: string
  ): { chainId: number; tokenNetworkAddress: string; tokenAddress?: string } | undefined {
    if (!negotiatedChain) return undefined;
    const parts = negotiatedChain.split(':');
    const numericChainId = parts.length >= 3 ? parseInt(parts[2]!, 10) : NaN;
    if (isNaN(numericChainId)) return undefined;
    const tokenNetworkAddress =
      this.config.tokenNetworks?.[negotiatedChain];
    if (!tokenNetworkAddress) return undefined;
    const tokenAddress = this.config.preferredTokens?.[negotiatedChain];
    return { chainId: numericChainId, tokenNetworkAddress, tokenAddress };
  }

  /**
   * Gets the default chain context from the first supported chain in config.
   */
  private getDefaultChainContext():
    | { chainId: number; tokenNetworkAddress: string; tokenAddress?: string }
    | undefined {
    const chains = this.config.supportedChains;
    if (!chains?.length) return undefined;
    return this.getChainContext(chains[0]);
  }

  /**
   * Sends an ILP payment, optionally with a balance proof claim via BTP.
   *
   * @param params - Payment parameters
   * @returns ILP send result
   * @throws {ToonClientError} If client is not started
   */
  async sendPayment(params: {
    destination: string;
    amount: string;
    data?: string;
    claim?: SignedBalanceProof;
  }): Promise<IlpSendResult> {
    if (!this.state) {
      throw new ToonClientError(
        'Client not started. Call start() first.',
        'INVALID_STATE'
      );
    }

    const ilpParams = {
      destination: params.destination,
      amount: params.amount,
      data: params.data ?? '',
    };

    // Require claim + BTP — plain sendIlpPacket is only valid for
    // node-to-node forwarding (town.ts), not client-to-node.
    if (!params.claim) {
      throw new ToonClientError(
        'Signed balance proof required. Call signBalanceProof() first.',
        'MISSING_CLAIM'
      );
    }
    if (!this.state.btpClient) {
      throw new ToonClientError(
        'BTP client required for sending payments. Configure btpUrl.',
        'NO_BTP_CLIENT'
      );
    }

    const claimMessage = EvmSigner.buildClaimMessage(
      params.claim,
      this.getPublicKey()
    );
    return this.state.btpClient.sendIlpPacketWithClaim(
      ilpParams,
      claimMessage
    );
  }

  /**
   * Stops the ToonClient and cleans up resources.
   *
   * This will:
   * 1. Disconnect BTP client if connected
   * 2. Clear internal state
   *
   * @throws {ToonClientError} If client is not started
   */
  async stop(): Promise<void> {
    if (!this.state) {
      throw new ToonClientError('Client not started', 'INVALID_STATE');
    }

    try {
      // Disconnect BTP client if connected
      if (this.state.btpClient) {
        await this.state.btpClient.disconnect();
      }

      // Clear state
      this.state = null;
    } catch (error) {
      throw new ToonClientError(
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
   * @throws {ToonClientError} If client is not started
   */
  getPeersCount(): number {
    if (!this.state) {
      throw new ToonClientError(
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
   * @throws {ToonClientError} If client is not started
   */
  getDiscoveredPeers() {
    if (!this.state) {
      throw new ToonClientError(
        'Client not started. Call start() first.',
        'INVALID_STATE'
      );
    }

    return this.state.discoveryTracker.getDiscoveredPeers();
  }
}
