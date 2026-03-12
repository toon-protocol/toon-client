import { BootstrapService, createDiscoveryTracker } from '@crosstown/core';
import type { BootstrapServiceConfig } from '@crosstown/core';
import { HttpRuntimeClient } from '../adapters/HttpRuntimeClient.js';
import { BtpRuntimeClient } from '../adapters/BtpRuntimeClient.js';
import { OnChainChannelClient } from '../channel/OnChainChannelClient.js';
import { EvmSigner } from '../signing/evm-signer.js';
import { buildSettlementInfo } from '../config.js';
import type { ResolvedConfig } from '../config.js';
import type { HttpModeInitialization } from './types.js';

/**
 * Initializes HTTP mode for CrosstownClient.
 *
 * HTTP mode uses external connector service via HTTP/WebSocket.
 * This function creates all necessary clients and services for operating in HTTP mode.
 *
 * @param config - CrosstownClient configuration (must have connectorUrl)
 * @returns Initialized HTTP mode components
 */
export async function initializeHttpMode(
  config: ResolvedConfig
): Promise<HttpModeInitialization> {
  // Derive admin URL from connector URL (change port 8080 → 8081)
  const connectorUrl = config.connectorUrl;

  // Build settlement info from config
  const settlementInfo = buildSettlementInfo(config);

  // Create BTP runtime client — this is the primary transport for the client SDK.
  // The client connects to the connector via BTP WebSocket to send ILP packets.
  // HTTP is not used for ILP packet transport.
  let btpClient: BtpRuntimeClient | null = null;
  if (config.btpUrl) {
    btpClient = new BtpRuntimeClient({
      btpUrl: config.btpUrl,
      peerId: config.btpPeerId ?? `client`,
      authToken: config.btpAuthToken ?? '',
    });
    await btpClient.connect();
  }

  // BTP is the runtime client for sending ILP packets
  const runtimeClient =
    btpClient ??
    new HttpRuntimeClient({
      connectorUrl,
      timeout: config.queryTimeout,
      maxRetries: config.maxRetries,
      retryDelay: config.retryDelay,
    });

  // Create on-chain channel client when chain RPC URLs are configured.
  // evmPrivateKey is always present (derived from secretKey by default).
  let onChainChannelClient: OnChainChannelClient | null = null;
  if (config.chainRpcUrls) {
    const evmSigner = new EvmSigner(config.evmPrivateKey);
    onChainChannelClient = new OnChainChannelClient({
      evmSigner,
      chainRpcUrls: config.chainRpcUrls,
    });
  }

  // Create BootstrapService
  const bootstrapConfig: BootstrapServiceConfig = {
    knownPeers: (config.knownPeers || []).map((p) => ({
      pubkey: p.pubkey,
      relayUrl: p.relayUrl,
      btpEndpoint: p.btpEndpoint ?? '',
    })),
    queryTimeout: config.queryTimeout,
    ardriveEnabled: true,
    defaultRelayUrl: config.relayUrl,
    settlementInfo,
    ownIlpAddress: config.ilpInfo.ilpAddress,
    toonEncoder: config.toonEncoder,
    toonDecoder: config.toonDecoder,
    basePricePerByte: 10n, // Default pricing
  };

  const bootstrapService = new BootstrapService(
    bootstrapConfig,
    config.secretKey,
    config.ilpInfo
  );

  // Wire ILP client into bootstrap service
  bootstrapService.setIlpClient(runtimeClient);

  // Wire on-chain channel client if available
  if (onChainChannelClient) {
    bootstrapService.setChannelClient(onChainChannelClient);
  }

  // Do NOT wire ConnectorAdmin — addPeer() at line 472 is skipped when connectorAdmin is null
  // This is intentional: the client is a standalone peer, not an admin interface

  // Create DiscoveryTracker
  const discoveryTracker = createDiscoveryTracker({
    secretKey: config.secretKey,
    settlementInfo,
  });

  return {
    bootstrapService,
    discoveryTracker,
    runtimeClient,
    adminClient: null,
    btpClient,
    onChainChannelClient,
  };
}
