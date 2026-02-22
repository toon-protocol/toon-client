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

  // Validate required fields
  if (!config.secretKey || config.secretKey.length !== 32) {
    throw new ValidationError('secretKey must be 32 bytes (Nostr private key)');
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
}

/**
 * Applies default values to optional configuration fields.
 */
export function applyDefaults(
  config: CrosstownClientConfig
): Required<Omit<CrosstownClientConfig, 'connector'>> & { connector?: unknown } {
  return {
    ...config,
    connectorUrl: config.connectorUrl!, // Already validated as required
    relayUrl: config.relayUrl ?? 'ws://localhost:7100',
    queryTimeout: config.queryTimeout ?? 30000,
    maxRetries: config.maxRetries ?? 3,
    retryDelay: config.retryDelay ?? 1000,
  };
}
