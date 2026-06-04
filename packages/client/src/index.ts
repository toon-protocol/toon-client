// Main Client
export { ToonClient } from './ToonClient.js';

// Types
export type {
  ToonClientConfig,
  ToonStartResult,
  PublishEventResult,
  BalanceProofParams,
  SignedBalanceProof,
  ClientTransportConfig,
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
export {
  EvmSigner,
  type EVMClaimMessage,
  SolanaSigner,
  MinaSigner,
  type ChainSigner,
  type ChainMetadata,
  type ClaimMessage,
  type SolanaClaimMessage,
  type MinaClaimMessage,
} from './signing/index.js';

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

// Pet DVM Utilities
export {
  filterPetDvmProviders,
  buildPetInteractionRequest,
  parsePetInteractionResult,
  parsePetInteractionEvent,
  // Pet Marketplace Utilities (Story 11-14)
  buildPetListingEvent,
  parsePetListing,
  filterPetListings,
  buildPetPurchaseRequest,
  type PetDvmProvider,
  type PetInteractionRequestParams,
  type PetInteractionResultData,
  type PetInteractionEventData,
  type InteractionResultContent,
  type UnsignedNostrEvent,
  type StatValues,
  type ProofStatus,
  // Pet Marketplace Types (Story 11-14)
  type PetListingParams,
  type PetListing,
  type PetListingFilterOptions,
  type PetPurchaseRequestParams,
} from './pet/index.js';

// Arweave Blob Storage (kind:5094 DVM) helper
export {
  requestBlobStorage,
  type RequestBlobStorageParams,
  type RequestBlobStorageResult,
} from './blob-storage.js';

// Key Management
export {
  KeyManager,
  generateMnemonic,
  validateMnemonic,
  deriveNostrKeyFromMnemonic,
  deriveFullIdentity,
  deriveFromNsec,
  generateRandomIdentity,
  isPrfSupported,
  buildBackupEvent,
  buildBackupFilter,
  parseBackupPayload,
  type ToonIdentity,
  type ToonSigners,
  type PasskeyInfo,
  type KeyManagerConfig,
  type BackupPayload,
  type VaultData,
} from './keys/index.js';
