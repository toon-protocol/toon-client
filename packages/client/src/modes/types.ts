import type { BootstrapService, RelayMonitor } from '@crosstown/core';
import type { HttpRuntimeClient } from '../adapters/HttpRuntimeClient.js';
import type { HttpConnectorAdmin } from '../adapters/HttpConnectorAdmin.js';

/**
 * Result of HTTP mode initialization.
 *
 * HTTP mode uses external connector service via HTTP/WebSocket.
 * Channel client is null because HTTP mode doesn't support direct payment channels yet.
 */
export interface HttpModeInitialization {
  /** Bootstrap service for peer discovery and handshaking */
  bootstrapService: BootstrapService;

  /** Relay monitor for tracking new peers from kind:10032 events */
  relayMonitor: RelayMonitor;

  /** HTTP client for sending ILP packets to connector */
  runtimeClient: HttpRuntimeClient;

  /** HTTP client for connector admin operations (add/remove peers) */
  adminClient: HttpConnectorAdmin;

  /**
   * Channel client for direct payment channels.
   * Always null in HTTP mode (not supported yet).
   */
  channelClient: null;
}

/**
 * Result of embedded mode initialization.
 * NOT IMPLEMENTED in this story - reserved for future epic.
 */
export interface EmbeddedModeInitialization {
  bootstrapService: BootstrapService;
  relayMonitor: RelayMonitor;
  runtimeClient: unknown; // DirectRuntimeClient (future)
  adminClient: unknown; // DirectConnectorAdmin (future)
  channelClient: unknown; // DirectChannelClient (future)
}
