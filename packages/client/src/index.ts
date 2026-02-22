// Main Client
export { CrosstownClient } from './CrosstownClient.js';

// Types
export type {
  CrosstownClientConfig,
  CrosstownStartResult,
  PublishEventResult,
} from './types.js';

// Error classes
export {
  CrosstownClientError,
  NetworkError,
  ConnectorError,
  ValidationError,
} from './errors.js';

// HTTP Adapters
export {
  HttpRuntimeClient,
  type HttpRuntimeClientConfig,
  HttpConnectorAdmin,
  type HttpConnectorAdminConfig,
} from './adapters/index.js';

// Utilities
export { withRetry, type RetryOptions } from './utils/index.js';

// Config validation (for advanced use cases)
export { validateConfig, applyDefaults } from './config.js';
