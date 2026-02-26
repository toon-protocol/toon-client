import { generateSecretKey } from 'nostr-tools/pure';
import type { SpspRequestSettlementInfo } from '@crosstown/core';
import { ValidationError } from './errors.js';
import type { CrosstownClientConfig } from './types.js';

/**
 * Validates CrosstownClient configuration.
 *
 * This story implements HTTP mode only. Embedded mode validation will be added in a future epic.
 *
 * @throws {ValidationError} If configuration is invalid
 */
export function validateConfig(config: CrosstownClientConfig): void {
  // Reject embedded mode (not implemented in this story)
  if (config.connector !== undefined) {
    throw new ValidationError(
      'Embedded mode not yet implemented in CrosstownClient. Use connectorUrl for HTTP mode.'
    );
  }

  // Require connectorUrl for HTTP mode
  if (!config.connectorUrl) {
    throw new ValidationError(
      'connectorUrl is required for HTTP mode. Example: "http://localhost:8080"'
    );
  }

  // Validate connectorUrl format
  try {
    const url = new URL(config.connectorUrl);
    if (!url.protocol.startsWith('http')) {
      throw new Error('Must be HTTP or HTTPS');
    }
  } catch (error) {
    throw new ValidationError(
      `Invalid connectorUrl: must be a valid HTTP/HTTPS URL (e.g., "http://localhost:8080"). ` +
        `Error: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // Validate secretKey only when provided
  if (config.secretKey !== undefined) {
    if (!config.secretKey || config.secretKey.length !== 32) {
      throw new ValidationError('secretKey must be 32 bytes (Nostr private key)');
    }
  }

  if (!config.ilpInfo?.ilpAddress) {
    throw new ValidationError('ilpInfo.ilpAddress is required');
  }

  if (!config.toonEncoder || typeof config.toonEncoder !== 'function') {
    throw new ValidationError('toonEncoder function is required');
  }

  if (!config.toonDecoder || typeof config.toonDecoder !== 'function') {
    throw new ValidationError('toonDecoder function is required');
  }

  // Validate evmPrivateKey format when provided
  if (config.evmPrivateKey !== undefined) {
    if (config.evmPrivateKey instanceof Uint8Array) {
      if (config.evmPrivateKey.length !== 32) {
        throw new ValidationError('evmPrivateKey must be 32 bytes');
      }
    } else if (typeof config.evmPrivateKey === 'string') {
      const hex = config.evmPrivateKey.startsWith('0x')
        ? config.evmPrivateKey.slice(2)
        : config.evmPrivateKey;
      if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
        throw new ValidationError('evmPrivateKey must be a 32-byte hex string');
      }
    } else {
      throw new ValidationError('evmPrivateKey must be a hex string or Uint8Array');
    }
  }

  // Validate btpUrl when provided
  if (config.btpUrl !== undefined) {
    try {
      const url = new URL(config.btpUrl);
      if (!url.protocol.startsWith('ws')) {
        throw new Error('Must be WS or WSS');
      }
    } catch (error) {
      throw new ValidationError(
        `Invalid btpUrl: must be a valid WebSocket URL (e.g., "ws://localhost:3000"). ` +
          `Error: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // Validate chainRpcUrls keys match supportedChains when both present
  if (config.chainRpcUrls && config.supportedChains) {
    for (const chain of Object.keys(config.chainRpcUrls)) {
      if (!config.supportedChains.includes(chain)) {
        throw new ValidationError(
          `chainRpcUrls key "${chain}" is not in supportedChains`
        );
      }
    }
  }
}

/**
 * The resolved config type after defaults are applied.
 * secretKey is guaranteed to be present (auto-generated if omitted).
 */
export type ResolvedConfig = Required<
  Omit<
    CrosstownClientConfig,
    | 'connector'
    | 'evmPrivateKey'
    | 'supportedChains'
    | 'settlementAddresses'
    | 'preferredTokens'
    | 'tokenNetworks'
    | 'btpUrl'
    | 'btpAuthToken'
    | 'btpPeerId'
    | 'chainRpcUrls'
    | 'initialDeposit'
    | 'settlementTimeout'
  >
> & {
  connector?: unknown;
  evmPrivateKey?: string | Uint8Array;
  supportedChains?: string[];
  settlementAddresses?: Record<string, string>;
  preferredTokens?: Record<string, string>;
  tokenNetworks?: Record<string, string>;
  btpUrl?: string;
  btpAuthToken?: string;
  btpPeerId?: string;
  chainRpcUrls?: Record<string, string>;
  initialDeposit?: string;
  settlementTimeout?: number;
};

/**
 * Applies default values to optional configuration fields.
 * Auto-generates a Nostr keypair when secretKey is omitted.
 * Derives btpUrl from connectorUrl when not provided.
 */
export function applyDefaults(config: CrosstownClientConfig): ResolvedConfig {
  // Auto-generate Nostr keypair when secretKey is omitted
  const secretKey = config.secretKey ?? generateSecretKey();

  // Derive btpUrl from connectorUrl when not explicitly provided
  // http://host:8080 → ws://host:3000
  let btpUrl = config.btpUrl;
  if (!btpUrl && config.connectorUrl) {
    try {
      const url = new URL(config.connectorUrl);
      const wsProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      btpUrl = `${wsProtocol}//${url.hostname}:3000`;
    } catch {
      // connectorUrl already validated, this shouldn't happen
    }
  }

  return {
    ...config,
    secretKey,
    connectorUrl: config.connectorUrl!, // Already validated as required
    relayUrl: config.relayUrl ?? 'ws://localhost:7100',
    queryTimeout: config.queryTimeout ?? 30000,
    maxRetries: config.maxRetries ?? 3,
    retryDelay: config.retryDelay ?? 1000,
    btpUrl,
  };
}

/**
 * Builds SpspRequestSettlementInfo from client config.
 * Returns undefined if no settlement-related config is present.
 */
export function buildSettlementInfo(
  config: CrosstownClientConfig
): SpspRequestSettlementInfo | undefined {
  if (
    !config.supportedChains?.length &&
    !config.settlementAddresses &&
    !config.preferredTokens &&
    !config.tokenNetworks
  ) {
    return undefined;
  }

  return {
    ilpAddress: config.ilpInfo?.ilpAddress,
    supportedChains: config.supportedChains,
    settlementAddresses: config.settlementAddresses,
    preferredTokens: config.preferredTokens,
    tokenNetworks: config.tokenNetworks,
  };
}
