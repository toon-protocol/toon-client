import { SimplePool } from 'nostr-tools/pool';
import { BootstrapService, RelayMonitor } from '@crosstown/core';
import type { BootstrapServiceConfig, RelayMonitorConfig } from '@crosstown/core';
import { HttpRuntimeClient } from '../adapters/HttpRuntimeClient.js';
import { HttpConnectorAdmin } from '../adapters/HttpConnectorAdmin.js';
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
 * @param pool - SimplePool instance for Nostr relay operations
 * @returns Initialized HTTP mode components
 */
export async function initializeHttpMode(
  config: ResolvedConfig,
  pool: SimplePool
): Promise<HttpModeInitialization> {
  // Derive admin URL from connector URL (change port 8080 → 8081)
  const connectorUrl = config.connectorUrl;
  const adminUrl = connectorUrl.replace(':8080', ':8081');

  // Build settlement info from config
  const settlementInfo = buildSettlementInfo(config);

  // Create HTTP runtime client (fallback when BTP not configured)
  const httpRuntimeClient = new HttpRuntimeClient({
    connectorUrl,
    timeout: config.queryTimeout,
    maxRetries: config.maxRetries,
    retryDelay: config.retryDelay,
  });

  // Create BTP runtime client when btpUrl is configured
  let btpClient: BtpRuntimeClient | null = null;
  if (config.btpUrl) {
    btpClient = new BtpRuntimeClient({
      btpUrl: config.btpUrl,
      peerId: `nostr-${config.ilpInfo.pubkey?.slice(0, 16) ?? 'client'}`,
      authToken: config.btpAuthToken ?? 'default-token',
    });
    await btpClient.connect();
  }

  // Use BTP client as runtime client when available, fall back to HTTP
  const runtimeClient = btpClient ?? httpRuntimeClient;

  // Create on-chain channel client when EVM is configured
  let onChainChannelClient: OnChainChannelClient | null = null;
  if (config.evmPrivateKey && config.chainRpcUrls) {
    const evmSigner = new EvmSigner(config.evmPrivateKey);
    onChainChannelClient = new OnChainChannelClient({
      evmSigner,
      chainRpcUrls: config.chainRpcUrls,
    });
  }

  // Create BootstrapService
  const bootstrapConfig: BootstrapServiceConfig = {
    knownPeers: [], // Start with no known peers; RelayMonitor will discover them
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
    config.ilpInfo,
    pool
  );

  // Wire runtime client into bootstrap service
  bootstrapService.setAgentRuntimeClient(runtimeClient);

  // Wire on-chain channel client if available
  if (onChainChannelClient) {
    bootstrapService.setChannelClient(onChainChannelClient);
  }

  // Do NOT wire ConnectorAdmin — addPeer() at line 472 is skipped when connectorAdmin is null
  // This is intentional: the client is a standalone peer, not an admin interface

  // Create RelayMonitor
  const monitorConfig: RelayMonitorConfig = {
    relayUrl: config.relayUrl,
    secretKey: config.secretKey,
    toonEncoder: config.toonEncoder,
    toonDecoder: config.toonDecoder,
    basePricePerByte: 10n,
    settlementInfo,
    defaultTimeout: config.queryTimeout,
  };

  const relayMonitor = new RelayMonitor(monitorConfig, pool);

  // Wire runtime client into relay monitor
  relayMonitor.setAgentRuntimeClient(runtimeClient);

  return {
    bootstrapService,
    relayMonitor,
    runtimeClient,
    adminClient: null,
    btpClient,
    onChainChannelClient,
  };
}
