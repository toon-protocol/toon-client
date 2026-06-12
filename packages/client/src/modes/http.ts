import { BootstrapService, createDiscoveryTracker } from '@toon-protocol/core';
import type { BootstrapServiceConfig } from '@toon-protocol/core';
import { HttpRuntimeClient } from '../adapters/HttpRuntimeClient.js';
import { BtpRuntimeClient } from '../adapters/BtpRuntimeClient.js';
import { OnChainChannelClient } from '../channel/OnChainChannelClient.js';
import { EvmSigner } from '../signing/evm-signer.js';
import { buildSettlementInfo } from '../config.js';
import type { ResolvedConfig } from '../config.js';
import type { HttpModeInitialization } from './types.js';
import { resolveTransport } from '../transport/index.js';

/**
 * Initializes HTTP mode for ToonClient.
 *
 * HTTP mode uses external connector service via HTTP/WebSocket.
 * This function creates all necessary clients and services for operating in HTTP mode.
 *
 * @param config - ToonClient configuration (must have connectorUrl)
 * @returns Initialized HTTP mode components
 */
export async function initializeHttpMode(
  config: ResolvedConfig
): Promise<HttpModeInitialization> {
  // Resolve transport (probes SOCKS5 proxy or rewrites gateway URLs; for a
  // `.anyone` btpUrl with no explicit proxy, auto-starts a managed `anon`
  // SOCKS5h daemon). Fail-closed: throws if SOCKS5 proxy is configured but
  // unreachable.
  const transport = await resolveTransport(
    config.transport,
    config.btpUrl,
    config.connectorUrl,
    {
      ...(config.managedAnonProxy !== undefined
        ? { managedAnonProxy: config.managedAnonProxy }
        : {}),
      ...(config.managedAnonSocksPort !== undefined
        ? { managedAnonSocksPort: config.managedAnonSocksPort }
        : {}),
    }
  );

  // Apply gateway URL rewrites if present, otherwise use original URLs
  const effectiveBtpUrl = transport.btpUrl ?? config.btpUrl;
  const effectiveConnectorUrl = transport.connectorUrl ?? config.connectorUrl;

  // Build settlement info from config
  const settlementInfo = buildSettlementInfo(config);

  // Create BTP runtime client — this is the primary transport for the client SDK.
  // The client connects to the connector via BTP WebSocket to send ILP packets.
  // HTTP is not used for ILP packet transport.
  let btpClient: BtpRuntimeClient | null = null;
  if (effectiveBtpUrl) {
    btpClient = new BtpRuntimeClient({
      btpUrl: effectiveBtpUrl,
      peerId: config.btpPeerId ?? `client`,
      authToken: config.btpAuthToken ?? '',
      createWebSocket: transport.createWebSocket,
    });
    await btpClient.connect();
  }

  // BTP is the runtime client for sending ILP packets
  const runtimeClient =
    btpClient ??
    new HttpRuntimeClient({
      connectorUrl: effectiveConnectorUrl,
      timeout: config.queryTimeout,
      maxRetries: config.maxRetries,
      retryDelay: config.retryDelay,
      httpClient: transport.httpClient,
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
    basePricePerByte: 10n, // Match network default (10 micro-USDC per byte)
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
    // Teardown handle for a managed `anon` proxy this init STARTED (undefined
    // for explicit-proxy/direct/gateway). ToonClient.stop() invokes it.
    stopManagedProxy: transport.stopManagedProxy,
  };
}
