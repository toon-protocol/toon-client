import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import type { NostrEvent, EventTemplate } from 'nostr-tools/pure';
import type {
  BootstrapService,
  DiscoveryTracker,
  IlpSendResult,
  IlpClient,
} from '@toon-protocol/core';
import type { NetworkFamilyStatus } from '@toon-protocol/core';
import { validateConfig, applyDefaults, getNetworkStatus } from './config.js';
import { toBase64 } from './utils/binary.js';
import { buildStoreWriteEnvelope } from './utils/store-envelope.js';
import { parseFulfillHttp } from './utils/fulfill-http.js';
import type { ResolvedConfig } from './config.js';
import { initializeHttpMode } from './modes/http.js';
import { ToonClientError } from './errors.js';
import { EvmSigner } from './signing/evm-signer.js';
import { SolanaSigner } from './signing/solana-signer.js';
import { MinaSigner } from './signing/mina-signer.js';
import { deriveFullIdentity } from './keys/KeyDerivation.js';
import {
  ChannelManager,
  type PeerNegotiation,
} from './channel/ChannelManager.js';
import { JsonFileChannelStore } from './channel/ChannelStore.js';
import type { OnChainChannelClient } from './channel/OnChainChannelClient.js';
import {
  readEvmTokenBalance,
  readSolanaTokenBalance,
  readMinaBalance,
  readWalletBalances,
  type WalletBalance,
  type WalletBalanceSources,
  type WalletChainBalances,
} from './balance/WalletBalanceReader.js';
import {
  requestBlobStorage,
  type RequestBlobStorageResult,
} from './blob-storage.js';
import type { BtpRuntimeClient } from './adapters/BtpRuntimeClient.js';
import {
  Http402Client,
  type H402FetchOptions,
} from './adapters/Http402Client.js';
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
  private solanaSigner?: SolanaSigner;
  /**
   * Ed25519 signing seed (32 bytes) derived from the mnemonic for the Solana
   * identity. Retained so `start()` can inject it into the on-chain channel
   * client's Solana config (same key as `solanaSigner`).
   */
  private solanaSeed?: Uint8Array;
  private minaSigner?: MinaSigner;
  /**
   * Mina private key (big-endian hex scalar, as `deriveFullIdentity` emits)
   * derived from the mnemonic. Retained so `start()` can inject it into the
   * on-chain channel client's Mina config (same key as `minaSigner`).
   */
  private minaPrivateKey?: string;
  private channelManager?: ChannelManager;
  /** Concrete on-chain client, kept so deposit/withdraw can reach chain methods. */
  private onChainChannelClient?: OnChainChannelClient;
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
   * Sign an unsigned Nostr event template with the client's Nostr secret key,
   * returning a fully-signed event (id + pubkey + sig).
   *
   * This is the key primitive behind the daemon's sign-and-publish path: a UI
   * or agent supplies only `{ kind, content, tags, created_at }` and never holds
   * the private key — signing happens here, inside the key owner.
   */
  signEvent(template: EventTemplate): NostrEvent {
    return finalizeEvent(template, this.config.secretKey);
  }

  /**
   * Upload bytes to Arweave via the kind:5094 blob-storage DVM (single-packet),
   * signing the request with this client's Nostr key and paying through its
   * existing channel. Returns the Arweave tx id on success.
   *
   * Backs the daemon's `upload-media` path: the key and claim/channel plumbing
   * stay inside the client; callers pass only the bytes.
   */
  async uploadBlob(params: {
    blobData: Uint8Array;
    contentType?: string;
    bid?: string;
    destination?: string;
    ilpAmount?: bigint;
  }): Promise<RequestBlobStorageResult> {
    return requestBlobStorage(this, this.config.secretKey, params);
  }

  /**
   * Per-chain settlement readiness for the configured `network` tier, mirroring
   * the relay node's status. Returns `undefined` when no named `network` is
   * set (or `network: 'custom'`), since there is no preset tier to report on.
   */
  getNetworkStatus(): NetworkFamilyStatus | undefined {
    return getNetworkStatus(this.config);
  }

  /**
   * Gets the EVM address derived from the Nostr secret key (or explicit evmPrivateKey override).
   */
  getEvmAddress(): string | undefined {
    return this.evmSigner?.address;
  }

  /**
   * Gets the Solana (base58) address, when the client was constructed from a
   * `mnemonic`. Available only AFTER `start()` (Solana keys are derived
   * asynchronously). Returns undefined otherwise.
   */
  getSolanaAddress(): string | undefined {
    return this.solanaSigner?.signerIdentifier;
  }

  /**
   * Gets the Mina (base58) address, when the client was constructed from a
   * `mnemonic` AND `mina-signer` is installed. Available only AFTER `start()`.
   * Returns undefined otherwise.
   */
  getMinaAddress(): string | undefined {
    return this.minaSigner?.signerIdentifier;
  }

  /**
   * Derive the Solana/Mina keys from the mnemonic and register their signers on
   * the ChannelManager. Mirrors how the EVM signer is wired, but for the
   * non-secp256k1 chains. Skips any chain whose optional dependency is missing.
   */
  private async registerMnemonicChainSigners(
    mnemonic: string,
    accountIndex = 0
  ): Promise<void> {
    if (!this.channelManager) return;
    const identity = await deriveFullIdentity(mnemonic, accountIndex);

    // Solana: @noble/curves Ed25519 expects a 32-byte seed; deriveFullIdentity
    // returns a 64-byte keypair (seed||pubkey).
    if (identity.solana.publicKey) {
      const seed = identity.solana.secretKey.slice(0, 32);
      this.solanaSeed = seed;
      this.solanaSigner = new SolanaSigner(seed, identity.solana.publicKey);
      this.channelManager.registerChainSigner('solana', this.solanaSigner);
    }

    // Mina: only present when mina-signer is installed (optional dep).
    if (identity.mina.publicKey) {
      this.minaPrivateKey = identity.mina.privateKey;
      // Pass the configured GraphQL URL so the signer can read the channel's
      // on-chain `depositTotal` and bind the conserved `balanceB = depositTotal
      // − balanceA` commitment that a funded zkApp requires (connector#133);
      // without it Mina claims use the legacy balanceB=0 form and a funded zkApp
      // rejects them (F06 - Invalid zk-SNARK proof on claim).
      this.minaSigner = new MinaSigner(
        identity.mina.privateKey,
        identity.mina.publicKey,
        this.config.minaChannel?.graphqlUrl
          ? { graphqlUrl: this.config.minaChannel.graphqlUrl }
          : undefined
      );
      this.channelManager.registerChainSigner('mina', this.minaSigner);
    }
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

        // When constructed from a mnemonic, derive the non-secp256k1 keys
        // (Solana Ed25519, Mina Pallas) and register their signers so the
        // client can settle on those chains too. Derivation is async (dynamic
        // imports + optional deps), hence done here rather than in the
        // synchronous constructor. Gracefully skips a chain whose optional dep
        // is absent (e.g. mina-signer) — deriveFullIdentity leaves it empty.
        if (this.config.mnemonic) {
          await this.registerMnemonicChainSigners(
            this.config.mnemonic,
            this.config.mnemonicAccountIndex ?? 0
          );
        }
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
            // Sign balance proof and build full claim message with the
            // chain-appropriate signer (the channel is tracked above, so a
            // non-EVM channel yields its correct envelope, not an EVM claim).
            const proof = await cm.signBalanceProof(channelId, amount);
            const signer = cm.getSignerForChannel(channelId);
            return signer.buildClaimMessage(proof, nostrPubkey);
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
          // Accept 3-part `evm:{network}:{chainId}` and 2-part `evm:{chainId}`.
          const chainId =
            parts.length >= 3
              ? parseInt(parts[2] ?? '0', 10)
              : parts.length >= 2
                ? parseInt(parts[1] ?? '0', 10)
                : 0;
          const r = result as typeof result & {
            tokenAddress?: string;
            tokenNetwork?: string;
          };
          this.peerNegotiations.set(result.registeredPeerId, {
            chain: result.negotiatedChain,
            chainType,
            chainId: isNaN(chainId) ? 0 : chainId,
            settlementAddress: result.settlementAddress,
            tokenAddress: r.tokenAddress,
            tokenNetwork: r.tokenNetwork,
          });
        } else if (
          result.registeredPeerId &&
          !this.peerNegotiations.has(result.registeredPeerId)
        ) {
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
          const matchedChain =
            ourChains.find((c) => peerChains.includes(c)) ?? ourChains[0];
          if (matchedChain) {
            const peerAddr = peerInfo.settlementAddresses?.[matchedChain];
            const parts = matchedChain.split(':');
            const chainId =
              parts.length >= 3
                ? parseInt(parts[2] ?? '0', 10)
                : parts.length >= 2
                  ? parseInt(parts[1] ?? '0', 10)
                  : 0;
            if (peerAddr) {
              this.peerNegotiations.set(result.registeredPeerId, {
                chain: matchedChain,
                chainType: parts[0] ?? 'evm',
                chainId: isNaN(chainId) ? 0 : chainId,
                settlementAddress: peerAddr,
                tokenAddress:
                  peerInfo.preferredTokens?.[matchedChain] ??
                  this.config.preferredTokens?.[matchedChain],
                tokenNetwork:
                  peerInfo.tokenNetworks?.[matchedChain] ??
                  this.config.tokenNetworks?.[matchedChain],
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
        this.onChainChannelClient = initialization.onChainChannelClient;
        this.channelManager.setChannelClient(
          initialization.onChainChannelClient
        );

        // Late-bind the Solana channel config: the program/RPC/token come from
        // config, the Ed25519 keypair from the mnemonic-derived Solana seed.
        // Requires both a Solana seed (mnemonic-derived) and explicit
        // solanaChannel config — otherwise the on-chain Solana opener has no
        // program/RPC and would throw at openChannel time.
        if (this.config.solanaChannel && this.solanaSeed) {
          initialization.onChainChannelClient.setSolanaConfig({
            rpcUrl: this.config.solanaChannel.rpcUrl,
            programId: this.config.solanaChannel.programId,
            tokenMint: this.config.solanaChannel.tokenMint,
            challengeDuration: this.config.solanaChannel.challengeDuration,
            deposit: this.config.solanaChannel.deposit,
            keypair: this.solanaSeed,
          });
        }

        // Late-bind the Mina channel config (parallel to Solana). The
        // graphqlUrl + zkAppAddress come from config; the Mina private key from
        // the mnemonic-derived Mina identity (same key as the registered Mina
        // signer). Requires both a Mina private key (mnemonic-derived, present
        // only when `mina-signer` is installed) and explicit minaChannel config.
        //
        // openMinaChannel now performs a REAL on-chain channel open
        // (initialize + optional deposit) on the deployed zkApp so the
        // connector's getChannelState reports `opened` and the claim verifies +
        // stores (parity with Solana). Full on-chain Mina SETTLE remains gated by
        // the connector-side settlement-executor (same blocker as Solana).
        if (this.config.minaChannel && this.minaPrivateKey) {
          initialization.onChainChannelClient.setMinaConfig({
            graphqlUrl: this.config.minaChannel.graphqlUrl,
            zkAppAddress: this.config.minaChannel.zkAppAddress,
            privateKey: this.minaPrivateKey,
            ...(this.config.minaChannel.challengeDuration !== undefined
              ? { challengeDuration: this.config.minaChannel.challengeDuration }
              : {}),
            ...(this.config.minaChannel.tokenId !== undefined
              ? { tokenId: this.config.minaChannel.tokenId }
              : {}),
            ...(this.config.minaChannel.deposit !== undefined
              ? { deposit: this.config.minaChannel.deposit }
              : {}),
            ...(this.config.minaChannel.networkId !== undefined
              ? { networkId: this.config.minaChannel.networkId }
              : {}),
          });
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
   * @returns Result with success status and event ID
   * @throws {ToonClientError} If client is not started
   * @throws {ToonClientError} If event publishing fails
   */
  async publishEvent(
    event: NostrEvent,
    options?: {
      destination?: string;
      claim?: SignedBalanceProof;
      ilpAmount?: bigint;
      /** HTTP request-target the payment-proxy replays (default '/write', the
       *  relay; use '/store' for the Arweave store/DVM backend). */
      proxyPath?: string;
    }
  ): Promise<PublishEventResult> {
    if (!this.state) {
      throw new ToonClientError(
        'Client not started. Call start() first.',
        'INVALID_STATE'
      );
    }

    try {
      // Encode event to TOON format. This is used ONLY to PRICE the write
      // (basePricePerByte * encoded size); the bytes sent on the wire are the
      // HTTP store-write envelope built below.
      const toonData = this.config.toonEncoder(event);

      // Calculate payment amount: basePricePerByte * encoded size.
      // Callers may override via options.ilpAmount (e.g. 0n for free relays).
      const basePricePerByte = 10n;
      const amount =
        options?.ilpAmount !== undefined
          ? String(options.ilpAmount)
          : String(BigInt(toonData.length) * basePricePerByte);

      // The deployed connector is a payment-proxy: it terminates the paid write
      // as HTTP-in-ILP, decoding the ILP PREPARE `data` as a literal HTTP/1.1
      // request and reverse-proxying it to the relay store's `POST /write`. The
      // wire data must therefore be a full HTTP request envelope carrying the
      // signed event as `{"event": <event object>}` JSON — NOT the bare TOON
      // bytes (those make the proxy reject with F01 - malformed request-line).
      // See utils/store-envelope.ts. `sendSwapPacket` (swap peer swaps) is a separate
      // surface with a raw-TOON contract and is intentionally NOT wrapped here.
      const writeData = buildStoreWriteEnvelope(event, options?.proxyPath);

      // Use provided destination or fall back to config default
      const destination =
        options?.destination ?? this.config.destinationAddress;

      // Resolve the active paid-write transport (proxy ILP-over-HTTP or BTP).
      const transport = this.getClaimTransport();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let claimMessage: any;
      if (options?.claim) {
        // EXISTING PATH: Caller provides pre-signed claim (backwards compatible).
        // Build the envelope with the chain-appropriate signer so a Solana/Mina
        // balance proof is not mis-wrapped as an EVM claim (see F06 root cause).
        claimMessage = this.buildClaimMessageForProof(options.claim);
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
        const channelId = await this.channelManager.ensureChannel(
          peerId,
          negotiation
        );
        const proof = await this.channelManager.signBalanceProof(
          channelId,
          BigInt(amount)
        );
        const signer = this.channelManager.getSignerForChannel(channelId);
        claimMessage = signer.buildClaimMessage(proof, this.getPublicKey());
      } else {
        throw new ToonClientError(
          'No claim provided and no channel manager configured',
          'MISSING_CLAIM'
        );
      }

      const response = await transport.sendIlpPacketWithClaim(
        {
          destination,
          amount,
          data: toBase64(writeData),
        },
        claimMessage
      );

      if (!response.accepted) {
        return {
          success: false,
          error: `Event rejected: ${response.code} - ${response.message}`,
        };
      }

      // The connector is a payment-proxy: an ACCEPTED ILP FULFILL only means
      // the PAYMENT cleared, not that the relay STORE persisted the event. The
      // FULFILL `data` carries the relay's verbatim HTTP/1.1 response, so a
      // write can FAIL (e.g. `HTTP/1.1 404 Not Found`) inside a successful
      // FULFILL. Parse the envelope and fail the publish on a non-2xx status so
      // we never report a fake `eventId` for a write that did not persist.
      //
      // DEFENSIVE: if the FULFILL data is not HTTP-enveloped (legacy / non-proxy
      // relays may return bare data), `isHttp` is false and we preserve the
      // prior behavior (treat an accepted FULFILL as success).
      if (response.data) {
        const httpResult = parseFulfillHttp(response.data);
        if (httpResult.isHttp && (httpResult.status < 200 || httpResult.status >= 300)) {
          const detail = httpResult.body ? ` - ${httpResult.body}` : '';
          return {
            success: false,
            error: `Write failed: relay returned HTTP ${httpResult.status} ${httpResult.statusText}`.trimEnd() + detail,
          };
        }
      }

      return {
        success: true,
        eventId: event.id,
        data: response.data,
      };
    } catch (error) {
      console.error(
        '[ToonClient.publishEvent] ROOT CAUSE:',
        String(error),
        error instanceof Error ? error.stack : ''
      );
      throw new ToonClientError(
        'Failed to publish event',
        'PUBLISH_ERROR',
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Payment-aware HTTP fetch over TOON (issue #50). A `fetch()`-like method that
   * makes paying for an HTTP resource transparent:
   *
   *   1. Issues the HTTP request to `url`.
   *   2. On `402`, parses the x402 `accepts` array and selects the
   *      `toon-channel` entry (see {@link Http402Client} for the wire shape).
   *   3. Opens/reuses a payment channel for the entry's ILP destination (via
   *      ChannelManager), signs a balance proof for the demanded price, and
   *      re-sends the SAME HTTP request as a transparent HTTP-in-ILP packet to
   *      the connector's `POST /ilp` (via {@link HttpIlpClient}), with the claim
   *      in the `ILP-Payment-Channel-Claim` header.
   *   4. Reconstructs and returns a standard Web `Response` from the FULFILL
   *      `data`. The caller never sees ILP.
   *
   * If the origin offers no `toon-channel` entry, the original `402` Response is
   * returned unchanged (the caller sees the vanilla x402 challenge).
   *
   * The channel/claim plumbing is wired to the live ChannelManager + per-chain
   * signer via `resolveClaimForDestination` — identical to `publishEvent`. The
   * `amount` paid comes from the selected x402 entry (the resource's price).
   *
   * @throws {ToonClientError} If the client is not started.
   * @throws {ConnectorError} If the connector rejects the payment or returns no
   *   HTTP payload.
   */
  async h402Fetch(url: string, opts?: H402FetchOptions): Promise<Response> {
    if (!this.state) {
      throw new ToonClientError(
        'Client not started. Call start() first.',
        'INVALID_STATE'
      );
    }

    // Pay only when a channel manager is configured; otherwise the engine still
    // probes and transparently surfaces the vanilla 402 (no resolveClaim hook).
    const client = new Http402Client({
      ...(this.channelManager
        ? {
            resolveClaim: (destination: string, amount: bigint) =>
              this.resolveClaimForDestination(destination, amount),
          }
        : {}),
    });

    return client.fetch(url, opts);
  }

  /**
   * Sends a raw swap ILP packet (Story 12.5) to a swap peer with an attached
   * balance-proof claim. This is a lower-level surface than `publishEvent`:
   * it forwards the raw `IlpSendResult` so the sender (`streamSwap()`) can
   * decode FULFILL metadata itself.
   *
   * Claim resolution mirrors `publishEvent`:
   *   (a) explicit `params.claim` -> use it,
   *   (b) `channelManager` present -> auto-open + auto-sign for the peer
   *       matching `destination`,
   *   (c) neither -> throw MISSING_CLAIM.
   *
   * @throws {ToonClientError} INVALID_STATE / NO_ILP_TRANSPORT / MISSING_CLAIM
   */
  async sendSwapPacket(params: {
    destination: string;
    amount: bigint;
    toonData: Uint8Array;
    timeout?: number;
    claim?: SignedBalanceProof;
  }): Promise<IlpSendResult> {
    if (!this.state) {
      throw new ToonClientError(
        'Client not started. Call start() first.',
        'INVALID_STATE'
      );
    }
    const transport = this.getClaimTransport();

    const claimMessage = await this.resolveClaimForDestination(
      params.destination,
      params.amount,
      params.claim
    );

    return transport.sendIlpPacketWithClaim(
      {
        destination: params.destination,
        amount: String(params.amount),
        data: toBase64(params.toonData),
        timeout: params.timeout ?? 30000,
      },
      claimMessage as unknown as Record<string, unknown>
    );
  }

  /**
   * Build a BTP claim message from a pre-signed balance proof using the
   * CHAIN-APPROPRIATE signer.
   *
   * The explicit-claim path (caller signs the balance proof, then passes
   * `{ claim }`) must wrap the proof with the signer matching the channel's
   * chain. Hardcoding `EvmSigner.buildClaimMessage` here produced an EVM
   * `BTPClaimMessage` for a Solana/Mina balance proof — no `blockchain`
   * discriminator and the base58 channel account placed in the EVM
   * `channelId` field — which the connector's inbound validator classifies
   * as EVM and rejects with F06 (`Invalid channelId format`).
   *
   * When the proof's `channelId` is tracked we use
   * `getSignerForChannel(channelId).buildClaimMessage`, which emits the
   * correct per-chain envelope (e.g. `blockchain:'solana'` + base58
   * `channelAccount`). When it is not tracked we fall back to the EVM signer
   * to preserve prior behavior for lightweight/EVM-only callers.
   *
   * EVM output is byte-identical to the previous hardcoded path (the EVM
   * adapter in `getSignerForChannel` delegates to the same
   * `EvmSigner.buildClaimMessage`).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- claim message is opaque forwarded type
  private buildClaimMessageForProof(claim: SignedBalanceProof): any {
    if (this.channelManager?.isTracking(claim.channelId)) {
      const signer = this.channelManager.getSignerForChannel(claim.channelId);
      return signer.buildClaimMessage(claim, this.getPublicKey());
    }
    return EvmSigner.buildClaimMessage(claim, this.getPublicKey());
  }

  /**
   * Resolve the ILP transport for a paid (claim-bearing) write.
   *
   * The connector is a payment-proxy: paid writes carry an ILP PREPARE plus the
   * signed payment-channel claim. Either transport speaks the SAME claim
   * contract — the BTP `payment-channel-claim` protocolData entry and the
   * ILP-over-HTTP `ILP-Payment-Channel-Claim` header serialize the same claim
   * JSON — so we route through whichever transport is ACTIVE rather than
   * hard-requiring BTP.
   *
   * Selection (mirrors `modes/http.ts` runtime-client precedence):
   *   1. `runtimeClient` when it implements `sendIlpPacketWithClaim` — this is
   *      the HttpIlpClient (proxy `POST /ilp`) when a `proxyUrl`/
   *      `connectorHttpEndpoint` is configured, else the BtpRuntimeClient.
   *   2. `btpClient` as an explicit fallback (always present when `btpUrl` is set).
   *
   * The level-3 `HttpRuntimeClient` (connector-admin HTTP, no `btpUrl` AND no
   * proxy) does NOT implement `sendIlpPacketWithClaim`; in that case there is no
   * paid-write transport and we throw a clear, actionable error.
   *
   * @throws {ToonClientError} NO_ILP_TRANSPORT when no active transport can send
   *   a packet+claim.
   */
  private getClaimTransport(): {
    sendIlpPacketWithClaim(
      params: {
        destination: string;
        amount: string;
        data: string;
        timeout?: number;
      },
      claim: unknown
    ): Promise<IlpSendResult>;
  } {
    const state = this.state;
    if (!state) {
      throw new ToonClientError(
        'Client not started. Call start() first.',
        'INVALID_STATE'
      );
    }
    const candidates: (IlpClient | BtpRuntimeClient | undefined)[] = [
      state.runtimeClient,
      state.btpClient,
    ];
    for (const candidate of candidates) {
      if (
        candidate &&
        typeof (candidate as IlpClient).sendIlpPacketWithClaim === 'function'
      ) {
        return candidate as ReturnType<ToonClient['getClaimTransport']>;
      }
    }
    throw new ToonClientError(
      'No ILP transport for paid writes. Configure `proxyUrl`/`connectorHttpEndpoint` ' +
        '(route through the connector proxy over ILP-over-HTTP) or `btpUrl` (BTP socket).',
      'NO_ILP_TRANSPORT'
    );
  }

  /**
   * Shared claim-resolution logic used by `publishEvent` and `sendSwapPacket`.
   * TODO(12.5 followup): also factor `publishEvent`'s inline claim resolution
   * to call this helper. Kept duplicated for now to minimize regression risk.
   */
  private async resolveClaimForDestination(
    destination: string,
    amount: bigint,
    explicitClaim?: SignedBalanceProof
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- claim message is opaque forwarded type
  ): Promise<any> {
    if (explicitClaim) {
      return this.buildClaimMessageForProof(explicitClaim);
    }
    if (this.channelManager) {
      const peerId = this.resolvePeerId(destination);
      const negotiation = this.peerNegotiations.get(peerId);
      if (!negotiation) {
        throw new ToonClientError(
          `No negotiation metadata for peer "${peerId}" — was bootstrap completed?`,
          'PEER_NOT_NEGOTIATED'
        );
      }
      const channelId = await this.channelManager.ensureChannel(
        peerId,
        negotiation
      );
      const proof = await this.channelManager.signBalanceProof(
        channelId,
        amount
      );
      const signer = this.channelManager.getSignerForChannel(channelId);
      return signer.buildClaimMessage(proof, this.getPublicKey());
    }
    throw new ToonClientError(
      'No claim provided and no channel manager configured',
      'MISSING_CLAIM'
    );
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
   * Eagerly open (or return existing) payment channel for the given destination.
   *
   * Channels are normally opened lazily on the first `publishEvent()` /
   * `sendSwapPacket()` call. This method exposes the lazy-open path so
   * callers (and E2E tests) that need a tracked `channelId` BEFORE publishing
   * can force the open. Idempotent — returns the existing channel ID for the
   * peer if one is already open.
   *
   * @param destination - Optional ILP destination address. Defaults to
   *   `config.destinationAddress`.
   * @returns The channel ID of the (now) open channel.
   * @throws {ToonClientError} If client not started, no channel manager
   *   configured, or peer negotiation metadata missing.
   */
  async openChannel(destination?: string): Promise<string> {
    if (!this.state) {
      throw new ToonClientError(
        'Client not started. Call start() first.',
        'INVALID_STATE'
      );
    }
    if (!this.channelManager) {
      throw new ToonClientError(
        'No channel manager configured. Provide evmPrivateKey in config.',
        'NO_EVM_SIGNER'
      );
    }
    const dest = destination ?? this.config.destinationAddress;
    if (!dest) {
      throw new ToonClientError(
        'No destination provided and no default destinationAddress configured.',
        'NO_DESTINATION'
      );
    }
    const peerId = this.resolvePeerId(dest);
    const negotiation = this.peerNegotiations.get(peerId);
    if (!negotiation) {
      throw new ToonClientError(
        `No negotiation metadata for peer "${peerId}" — was bootstrap completed?`,
        'PEER_NOT_NEGOTIATED'
      );
    }
    return this.channelManager.ensureChannel(peerId, negotiation);
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
   * Gets the on-chain deposit total (locked collateral) for a tracked channel.
   * The available (spendable) balance is this minus the cumulative spent amount.
   */
  getChannelDepositTotal(channelId: string): bigint {
    if (!this.channelManager) throw new Error('ChannelManager not initialized');
    return this.channelManager.getDepositTotal(channelId);
  }

  /**
   * Deposit additional collateral into an open channel. `amount` is the delta to
   * add (base units, decimal string or bigint). The daemon signs its own tx; no
   * key material leaves the client. Reads the current tracked deposit, performs
   * the on-chain deposit, updates the tracked total, and returns the new total.
   * EVM is live; Solana/Mina deposit lands in a follow-up.
   */
  async depositToChannel(
    channelId: string,
    amount: string | bigint
  ): Promise<{ channelId: string; txHash?: string; depositTotal: string }> {
    if (!this.channelManager) throw new Error('ChannelManager not initialized');
    if (!this.onChainChannelClient) {
      throw new Error('On-chain channel client not configured (no chainRpcUrls).');
    }
    const delta = BigInt(amount);
    if (delta <= 0n) throw new Error('Deposit amount must be positive.');
    const currentDeposit = this.channelManager.getDepositTotal(channelId);
    const result = await this.onChainChannelClient.depositToChannel(channelId, delta, {
      currentDeposit,
    });
    this.channelManager.setDepositTotal(channelId, result.depositTotal);
    return {
      channelId,
      ...(result.txHash ? { txHash: result.txHash } : {}),
      depositTotal: result.depositTotal.toString(),
    };
  }

  /**
   * Close a channel to begin the settlement grace period (first half of
   * withdraw). Records `closedAt`/`settleableAt` (unix seconds) on the tracked
   * channel — persisted, so the grace timer survives a daemon restart. Spends
   * on-chain. EVM today; Solana/Mina are follow-ups.
   */
  async closeChannel(
    channelId: string
  ): Promise<{ channelId: string; txHash?: string; closedAt: string; settleableAt: string }> {
    if (!this.channelManager) throw new Error('ChannelManager not initialized');
    if (!this.onChainChannelClient) {
      throw new Error('On-chain channel client not configured (no chainRpcUrls).');
    }
    const r = await this.onChainChannelClient.closeChannel(channelId);
    this.channelManager.setChannelClosed(channelId, r.closedAt, r.settleableAt);
    return {
      channelId,
      ...(r.txHash ? { txHash: r.txHash } : {}),
      closedAt: r.closedAt.toString(),
      settleableAt: r.settleableAt.toString(),
    };
  }

  /**
   * Settle a closed channel to release collateral (second half of withdraw).
   * THE time guard: never settle before `settleableAt`. A too-early call throws
   * a retryable error (carrying the remaining seconds) BEFORE spending gas — the
   * contract would revert anyway. Spends on-chain. EVM today.
   */
  async settleChannel(channelId: string): Promise<{ channelId: string; txHash?: string }> {
    if (!this.channelManager) throw new Error('ChannelManager not initialized');
    if (!this.onChainChannelClient) {
      throw new Error('On-chain channel client not configured (no chainRpcUrls).');
    }
    const settleableAt = this.channelManager.getSettleableAt(channelId);
    if (settleableAt === undefined) {
      throw new Error(`Channel "${channelId}" is not closed; call closeChannel first.`);
    }
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    if (nowSec < settleableAt) {
      const remaining = settleableAt - nowSec;
      throw Object.assign(
        new Error(
          `Channel "${channelId}" is not settleable yet — ${remaining}s remain (settleable at ${settleableAt}).`
        ),
        { name: 'SettleTooEarlyError', retryable: true, settleableAt: settleableAt.toString() }
      );
    }
    const r = await this.onChainChannelClient.settleChannel(channelId);
    this.channelManager.setChannelSettled(channelId, nowSec);
    return { channelId, ...(r.txHash ? { txHash: r.txHash } : {}) };
  }

  /** Where a tracked channel sits in the withdraw journey. */
  getChannelCloseState(channelId: string): 'open' | 'closing' | 'settleable' | 'settled' {
    if (!this.channelManager) throw new Error('ChannelManager not initialized');
    return this.channelManager.getChannelCloseState(channelId);
  }

  getSettleableAt(channelId: string): bigint | undefined {
    if (!this.channelManager) throw new Error('ChannelManager not initialized');
    return this.channelManager.getSettleableAt(channelId);
  }

  /**
   * Re-hydrate a RESUMED channel's on-chain deposit. Persisted channel state
   * omits `depositTotal`, so after a daemon restart the tracked deposit is `0`
   * and the wallet shows 0 spendable even though real collateral is locked
   * on-chain. Read the participant's `deposit` from the `participants` mapping
   * and update the tracked total so `depositTotal - cumulativeAmount` is right.
   * Best-effort by caller (await + catch); returns the on-chain deposit, or
   * `undefined` when it can't be read (no channel manager / on-chain client /
   * EVM address).
   */
  async rehydrateChannelDeposit(
    channelId: string,
    opts: { chain: string; tokenNetworkAddress: string }
  ): Promise<bigint | undefined> {
    if (!this.channelManager || !this.onChainChannelClient) return undefined;
    const participant = this.getEvmAddress();
    if (!participant) return undefined;
    const { deposit } = await this.onChainChannelClient.readEvmParticipantState({
      chain: opts.chain,
      tokenNetworkAddress: opts.tokenNetworkAddress,
      channelId,
      participant,
    });
    this.channelManager.setDepositTotal(channelId, deposit);
    return deposit;
  }

  /**
   * Read the on-chain settlement-token balance of this client's OWN wallet on
   * each configured chain (EVM token, Solana SPL, native MINA). A free read — no
   * signing, no payment. Best-effort per chain: a chain whose config is absent or
   * whose RPC read fails is omitted rather than failing the whole result, so the
   * wallet view degrades gracefully. Available after `start()` (Solana/Mina keys
   * are derived there).
   */
  async getBalances(): Promise<WalletBalance[]> {
    const out: WalletBalance[] = [];

    // EVM: read the settlement token (preferredTokens) for the client's
    // settlement chain. `supportedChains` is a union with the network PRESET
    // first (see applyDefaults), so the preset's primary EVM chain (e.g.
    // base-sepolia on devnet) sorts ahead of an explicitly-configured chain
    // like `evm:anvil:31337`. Picking the FIRST evm key would read the preset
    // chain's token — a different contract with a 0 balance — even though the
    // faucet funds, and channels live on, the settlement chain. So prefer the
    // evm key that is the actual settlement chain (present in
    // `settlementAddresses`), falling back to the first usable evm chain.
    const evmAddress = this.getEvmAddress();
    const rpcUrls = this.config.chainRpcUrls;
    const tokens = this.config.preferredTokens;
    if (evmAddress && rpcUrls && tokens) {
      const chainKeys = this.config.supportedChains ?? Object.keys(rpcUrls);
      const usableEvm = (c: string): boolean =>
        c.startsWith('evm') && Boolean(rpcUrls[c]) && Boolean(tokens[c]);
      const settlementKeys = Object.keys(this.config.settlementAddresses ?? {});
      const chainKey =
        settlementKeys.find((c) => usableEvm(c)) ?? chainKeys.find(usableEvm);
      const rpcUrl = chainKey ? rpcUrls[chainKey] : undefined;
      const tokenAddress = chainKey ? tokens[chainKey] : undefined;
      if (chainKey && rpcUrl && tokenAddress) {
        try {
          out.push(await readEvmTokenBalance({ rpcUrl, chainKey, tokenAddress, owner: evmAddress }));
        } catch {
          /* best-effort: drop EVM on read failure */
        }
      }
    }

    // Solana: SPL balance of the negotiated token mint.
    const solAddress = this.getSolanaAddress();
    const sol = this.config.solanaChannel;
    if (solAddress && sol?.rpcUrl && sol.tokenMint) {
      try {
        out.push(
          await readSolanaTokenBalance({ rpcUrl: sol.rpcUrl, mint: sol.tokenMint, owner: solAddress })
        );
      } catch {
        /* best-effort */
      }
    }

    // Mina: native MINA balance via GraphQL.
    const minaAddress = this.getMinaAddress();
    const mina = this.config.minaChannel;
    if (minaAddress && mina?.graphqlUrl) {
      try {
        out.push(await readMinaBalance({ graphqlUrl: mina.graphqlUrl, owner: minaAddress }));
      } catch {
        /* best-effort */
      }
    }

    return out;
  }

  /**
   * The FULL multi-chain wallet view (#299): for every chain the identity is
   * configured for, the native coin (ETH / SOL / MINA) AND every configured
   * token (USDC), grouped per chain with the identity's address on that chain.
   * A superset of {@link getBalances} — which stays scoped to the channel's
   * settlement token — kept as a separate reader so channel-settlement callers
   * are unaffected.
   *
   * FREE: read-only RPC, no signing, no payment. Works on an UNSTARTED client:
   * the Solana/Mina addresses (which the signers only register during
   * `start()`) are derived on demand from the retained mnemonic — the SAME keys
   * `start()` would register and that `rig fund` prints — so all configured
   * chains appear even before a start. Best-effort per chain: an unreachable
   * RPC yields `{ unreadable: true }` for that chain, never failing the others.
   */
  async getWalletBalances(): Promise<WalletChainBalances[]> {
    const sources: WalletBalanceSources = {};

    // Solana/Mina keys are only registered as signers during start(); derive
    // them from the retained mnemonic on demand so an unstarted client (e.g.
    // `rig balance`) still reports every configured chain. Derived once, lazily.
    let derived: Awaited<ReturnType<typeof deriveFullIdentity>> | undefined;
    let derivedTried = false;
    const ensureDerived = async (): Promise<typeof derived> => {
      if (derivedTried) return derived;
      derivedTried = true;
      if (this.config.mnemonic) {
        derived = await deriveFullIdentity(
          this.config.mnemonic,
          this.config.mnemonicAccountIndex ?? 0
        );
      }
      return derived;
    };

    // EVM: native ETH + settlement USDC. Pick the settlement chain key the same
    // way getBalances does (settlement chain wins over the preset primary).
    const evmAddress = this.getEvmAddress();
    const rpcUrls = this.config.chainRpcUrls;
    const tokens = this.config.preferredTokens;
    if (evmAddress && rpcUrls) {
      const usableEvm = (c: string): boolean => c.startsWith('evm') && Boolean(rpcUrls[c]);
      const settlementKeys = Object.keys(this.config.settlementAddresses ?? {});
      const chainKeys = this.config.supportedChains ?? Object.keys(rpcUrls);
      const chainKey = settlementKeys.find(usableEvm) ?? chainKeys.find(usableEvm);
      if (chainKey && rpcUrls[chainKey]) {
        sources.evm = {
          chainKey,
          rpcUrl: rpcUrls[chainKey],
          owner: evmAddress,
          ...(tokens?.[chainKey] ? { tokenAddress: tokens[chainKey] } : {}),
        };
      }
    }

    // Solana: native SOL + SPL USDC (the negotiated mint).
    const sol = this.config.solanaChannel;
    if (sol?.rpcUrl) {
      const solAddress = this.getSolanaAddress() ?? (await ensureDerived())?.solana.publicKey;
      if (solAddress) {
        sources.solana = {
          chainKey: 'solana',
          rpcUrl: sol.rpcUrl,
          owner: solAddress,
          ...(sol.tokenMint ? { tokenMint: sol.tokenMint } : {}),
        };
      }
    }

    // Mina: native MINA (no configured Mina token on devnet).
    const mina = this.config.minaChannel;
    if (mina?.graphqlUrl) {
      const minaAddress = this.getMinaAddress() ?? (await ensureDerived())?.mina.publicKey;
      if (minaAddress) {
        sources.mina = { chainKey: 'mina', graphqlUrl: mina.graphqlUrl, owner: minaAddress };
      }
    }

    return readWalletBalances(sources);
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
      if (
        destination.endsWith(`.${peerId}`) ||
        destination.endsWith(`.${peerId.replace('nostr-', '')}`)
      ) {
        return peerId;
      }
    }

    // Fallback: return first peer
    const firstPeerResult = this.peerNegotiations.keys().next();
    if (!firstPeerResult.done && firstPeerResult.value)
      return firstPeerResult.value;

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
    // Accept 3-part `evm:{network}:{chainId}` and 2-part `evm:{chainId}`.
    const chainIdPart =
      parts.length >= 3 ? parts[2] : parts.length >= 2 ? parts[1] : undefined;
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
    // node-to-node forwarding (relay.ts), not client-to-node.
    if (!params.claim) {
      throw new ToonClientError(
        'Signed balance proof required. Call signBalanceProof() first.',
        'MISSING_CLAIM'
      );
    }
    const transport = this.getClaimTransport();

    const claimMessage = this.buildClaimMessageForProof(params.claim);
    return transport.sendIlpPacketWithClaim(
      ilpParams,
      claimMessage as unknown as Record<string, unknown>
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
