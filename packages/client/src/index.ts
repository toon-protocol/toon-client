// Main Client
export { ToonClient } from './ToonClient.js';

// Types
export type {
  ToonClientConfig,
  ToonStartResult,
  PublishEventResult,
  BalanceProofParams,
  SignedBalanceProof,
} from './types.js';

// Error classes
export {
  ToonClientError,
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
  BtpRuntimeClient,
  type BtpRuntimeClientConfig,
} from './adapters/index.js';

// Signing
export { EvmSigner, type EVMClaimMessage } from './signing/index.js';

// Channel
export {
  OnChainChannelClient,
  type OnChainChannelClientConfig,
  ChannelManager,
} from './channel/index.js';

// Utilities
export { withRetry, type RetryOptions } from './utils/index.js';

// Config validation (for advanced use cases)
export {
  validateConfig,
  applyDefaults,
  buildSettlementInfo,
} from './config.js';
