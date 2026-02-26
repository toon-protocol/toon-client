import type { BootstrapService, RelayMonitor } from '@crosstown/core';
import type { HttpRuntimeClient } from '../adapters/HttpRuntimeClient.js';
import type { HttpConnectorAdmin } from '../adapters/HttpConnectorAdmin.js';
import type { BtpRuntimeClient } from '../adapters/BtpRuntimeClient.js';
import type { OnChainChannelClient } from '../channel/OnChainChannelClient.js';

/**
 * Result of HTTP mode initialization.
 *
 * HTTP mode uses external connector service via HTTP/WebSocket.
 */
export interface HttpModeInitialization {
  /** Bootstrap service for peer discovery and handshaking */
  bootstrapService: BootstrapService;

  /** Relay monitor for tracking new peers from kind:10032 events */
  relayMonitor: RelayMonitor;

  /** Runtime client for sending ILP packets (HTTP or BTP) */
  runtimeClient: HttpRuntimeClient | BtpRuntimeClient;

  /** HTTP client for connector admin operations (add/remove peers). Null when admin not wired. */
  adminClient: HttpConnectorAdmin | null;

  /** BTP client for WebSocket transport. Null when btpUrl not configured. */
  btpClient: BtpRuntimeClient | null;

  /** On-chain channel client. Null when EVM not configured. */
  onChainChannelClient: OnChainChannelClient | null;
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
