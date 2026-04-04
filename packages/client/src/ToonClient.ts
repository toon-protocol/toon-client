import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';
import type {
  BootstrapService,
  DiscoveryTracker,
  IlpSendResult,
  IlpClient,
} from '@toon-protocol/core';
import { validateConfig, applyDefaults } from './config.js';
import { toBase64 } from './utils/binary.js';
import type { ResolvedConfig } from './config.js';
import { initializeHttpMode } from './modes/http.js';
import { ToonClientError } from './errors.js';
import { EvmSigner } from './signing/evm-signer.js';
import { ChannelManager, type PeerNegotiation } from './channel/ChannelManager.js';
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
  private readonly peerNegotiations = new Map<string, PeerNegotiation>();

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

      // Store negotiation metadata from bootstrap results for lazy channel opening
      for (const result of bootstrapResults) {
        if (result.negotiatedChain && result.settlementAddress) {
          const chainType = result.negotiatedChain.split(':')[0] ?? 'evm';
          const parts = result.negotiatedChain.split(':');
          const chainId = parts.length >= 3 ? parseInt(parts[2]!, 10) : 0;
          const r = result as typeof result & { tokenAddress?: string; tokenNetwork?: string };
          this.peerNegotiations.set(result.registeredPeerId, {
            chain: result.negotiatedChain,
            chainType,
            chainId: isNaN(chainId) ? 0 : chainId,
            settlementAddress: result.settlementAddress,
            tokenAddress: r.tokenAddress,
            tokenNetwork: r.tokenNetwork,
          });
        } else if (result.registeredPeerId && !this.peerNegotiations.has(result.registeredPeerId)) {
          // Lightweight client fallback: bootstrap discovered the peer but didn't
          // negotiate a chain (no connector admin to register with). Extract the
          // peer's settlement info from their kind:10032 event data and match
          // against our supported chains.
          const peerInfo = result.peerInfo as typeof result.peerInfo & {
            supportedChains?: string[];
            settlementAddresses?: Record<string, string>;
            preferredTokens?: Record<string, string>;
            tokenNetworks?: Record<string, string>;
          };
          const peerChains = peerInfo.supportedChains ?? [];
          const ourChains = this.config.supportedChains ?? [];
          // Find the first chain both sides support
          const matchedChain = ourChains.find(c => peerChains.includes(c)) ?? ourChains[0];
          if (matchedChain) {
            const peerAddr = peerInfo.settlementAddresses?.[matchedChain];
            const parts = matchedChain.split(':');
            const chainId = parts.length >= 3 ? parseInt(parts[2]!, 10) : 0;
            if (peerAddr) {
              this.peerNegotiations.set(result.registeredPeerId, {
                chain: matchedChain,
                chainType: parts[0] ?? 'evm',
                chainId: isNaN(chainId) ? 0 : chainId,
                settlementAddress: peerAddr,
                tokenAddress: peerInfo.preferredTokens?.[matchedChain] ?? this.config.preferredTokens?.[matchedChain],
                tokenNetwork: peerInfo.tokenNetworks?.[matchedChain] ?? this.config.tokenNetworks?.[matchedChain],
              });
            }
          }
        }
        // Track any pre-opened channels (backwards compat)
        if (
          this.channelManager &&
          result.channelId &&
          !this.channelManager.isTracking(result.channelId)
        ) {
          const chainCtx = this.getChainContext(result.negotiatedChain);
          this.channelManager.trackChannel(result.channelId, chainCtx);
        }
      }

      // Wire on-chain channel client into ChannelManager for lazy opens
      if (this.channelManager && initialization.onChainChannelClient) {
        this.channelManager.setChannelClient(initialization.onChainChannelClient);
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
   * @returns Result with success status and event ID
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

      if (!this.state.btpClient) {
        throw new ToonClientError(
          'BTP client required for publishing. Configure btpUrl.',
          'NO_BTP_CLIENT'
        );
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let claimMessage: any;
      if (options?.claim) {
        // EXISTING PATH: Caller provides pre-signed claim (backwards compatible)
        claimMessage = EvmSigner.buildClaimMessage(
          options.claim,
          this.getPublicKey()
        );
      } else if (this.channelManager) {
        // NEW PATH: Auto-open channel + auto-sign claim (lazy channels)
        const peerId = this.resolvePeerId(destination);
        const negotiation = this.peerNegotiations.get(peerId);
        if (!negotiation) {
          throw new ToonClientError(
            `No negotiation metadata for peer "${peerId}" — was bootstrap completed?`,
            'PEER_NOT_NEGOTIATED'
          );
        }
        const channelId = await this.channelManager.ensureChannel(peerId, negotiation);
        const proof = await this.channelManager.signBalanceProof(channelId, BigInt(amount));
        const signer = this.channelManager.getSignerForChannel(channelId);
        claimMessage = signer.buildClaimMessage(proof, this.getPublicKey());
      } else {
        throw new ToonClientError(
          'No claim provided and no channel manager configured',
          'MISSING_CLAIM'
        );
      }

      const response = await this.state.btpClient.sendIlpPacketWithClaim(
        {
          destination,
          amount,
          data: toBase64(toonData instanceof Uint8Array ? toonData : new Uint8Array(toonData)),
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
        data: response.data,
      };
    } catch (error) {
      console.error('[ToonClient.publishEvent] ROOT CAUSE:', String(error), error instanceof Error ? error.stack : '');
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
   * Resolves an ILP destination address to a peer ID.
   * Convention: destination "g.toon.peer1" → peerId "peer1" (last segment).
   * Falls back to first known peer if no match.
   */
  private resolvePeerId(destination: string): string {
    // Check if destination matches a known peer's ILP address pattern
    const segments = destination.split('.');
    const lastSegment = segments[segments.length - 1] ?? '';

    // Direct match against peerNegotiations keys
    if (lastSegment && this.peerNegotiations.has(lastSegment)) {
      return lastSegment;
    }

    // Try "nostr-" prefixed peer IDs (convention: nostr-{pubkey_prefix})
    for (const peerId of this.peerNegotiations.keys()) {
      if (destination.endsWith(`.${peerId}`) || destination.endsWith(`.${peerId.replace('nostr-', '')}`)) {
        return peerId;
      }
    }

    // Fallback: return first peer
    const firstPeerResult = this.peerNegotiations.keys().next();
    if (!firstPeerResult.done && firstPeerResult.value) return firstPeerResult.value;

    throw new ToonClientError(
      `Cannot resolve peer for destination: ${destination}`,
      'PEER_NOT_FOUND'
    );
  }

  /**
   * Extracts chain context (chainId + tokenNetworkAddress) from a chain key like 'evm:base:421614'.
   */
  private getChainContext(
    negotiatedChain?: string
  ):
    | { chainId: number; tokenNetworkAddress: string; tokenAddress?: string }
    | undefined {
    if (!negotiatedChain) return undefined;
    const parts = negotiatedChain.split(':');
    const chainIdPart = parts.length >= 3 ? parts[2] : undefined;
    const numericChainId =
      chainIdPart !== undefined ? parseInt(chainIdPart, 10) : NaN;
    if (isNaN(numericChainId)) return undefined;
    const tokenNetworkAddress = this.config.tokenNetworks?.[negotiatedChain];
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
    return this.state.btpClient.sendIlpPacketWithClaim(ilpParams, claimMessage as unknown as Record<string, unknown>);
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
