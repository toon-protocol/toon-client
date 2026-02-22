import { SimplePool } from 'nostr-tools/pool';
import { BootstrapService, RelayMonitor } from '@crosstown/core';
import type { BootstrapServiceConfig, RelayMonitorConfig } from '@crosstown/core';
import { HttpRuntimeClient } from '../adapters/HttpRuntimeClient.js';
import { HttpConnectorAdmin } from '../adapters/HttpConnectorAdmin.js';
import type { CrosstownClientConfig } from '../types.js';
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
  config: Required<Omit<CrosstownClientConfig, 'connector'>> & { connector?: unknown },
  pool: SimplePool
): Promise<HttpModeInitialization> {
  // Derive admin URL from connector URL (change port 8080 → 8081)
  const connectorUrl = config.connectorUrl;
  const adminUrl = connectorUrl.replace(':8080', ':8081');

  // Create HTTP clients
  const runtimeClient = new HttpRuntimeClient({
    connectorUrl,
    timeout: config.queryTimeout,
    maxRetries: config.maxRetries,
    retryDelay: config.retryDelay,
  });

  const adminClient = new HttpConnectorAdmin({
    adminUrl,
    timeout: config.queryTimeout,
  });

  // Create BootstrapService
  const bootstrapConfig: BootstrapServiceConfig = {
    knownPeers: [], // Start with no known peers; RelayMonitor will discover them
    queryTimeout: config.queryTimeout,
    ardriveEnabled: true,
    defaultRelayUrl: config.relayUrl,
    settlementInfo: undefined, // Optional: settlement chain preferences
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

  // Wire runtime client and admin client into bootstrap service
  bootstrapService.setAgentRuntimeClient(runtimeClient);
  bootstrapService.setConnectorAdmin(adminClient);

  // Create RelayMonitor
  const monitorConfig: RelayMonitorConfig = {
    relayUrl: config.relayUrl,
    secretKey: config.secretKey,
    toonEncoder: config.toonEncoder,
    toonDecoder: config.toonDecoder,
    basePricePerByte: 10n,
    settlementInfo: undefined,
    defaultTimeout: config.queryTimeout,
  };

  const relayMonitor = new RelayMonitor(monitorConfig, pool);

  // Wire runtime client and admin client into relay monitor
  relayMonitor.setConnectorAdmin(adminClient);
  relayMonitor.setAgentRuntimeClient(runtimeClient);

  return {
    bootstrapService,
    relayMonitor,
    runtimeClient,
    adminClient,
    channelClient: null, // HTTP mode doesn't support direct channels yet
  };
}
