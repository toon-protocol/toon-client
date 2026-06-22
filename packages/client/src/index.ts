// Main Client
export { ToonClient } from './ToonClient.js';

// Hidden-service hostname validation (.anyone TLD only — see issue #201)
export {
  isRoutableHsHostname,
  assertRoutableHsHostname,
  HS_HOSTNAME_REGEX,
  HS_HOSTNAME_MAX_LENGTH,
} from './transport/hs-hostname.js';

// Types
export type {
  ToonClientConfig,
  SolanaChannelClientOptions,
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
  HttpIlpClient,
  type HttpIlpClientConfig,
  httpEndpointToBtpUrl,
  ILP_CLAIM_HEADER,
  ILP_CLAIM_WRAPPED_HEADER,
  ILP_PEER_ID_HEADER,
  selectIlpTransport,
  readDiscoveredIlpPeer,
  type DiscoveredIlpPeer,
  type IlpTransportChoice,
  type SelectIlpTransportOptions,
  Http402Client,
  parseX402Challenge,
  parseX402Body,
  serializeHttpRequest,
  parseHttpResponse,
  type H402FetchOptions,
  type Http402ClientConfig,
  type ClaimResolver,
  type HttpIlpClientFactory,
  type ToonChannelAccept,
  type ParsedX402Challenge,
} from './adapters/index.js';

// Signing
export {
  EvmSigner,
  type EVMClaimMessage,
  SolanaSigner,
  MinaSigner,
  type MinaSignerOptions,
  type MinaDepositReader,
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
  readMinaDepositTotal,
} from './channel/index.js';

// Utilities
export { withRetry, type RetryOptions } from './utils/index.js';

// Managed `anon` (ATOR) SOCKS5h proxy — Node-only. Exposed for advanced
// consumers who want to drive the daemon directly; ToonClient auto-starts it for
// `.anyone` hosts. Importing these names is safe in any environment (the actual
// node-only deps are loaded lazily inside the functions).
export {
  startManagedAnonProxy,
  selectAnonAsset,
  ANON_VERSION,
  ANON_ASSETS,
  type ManagedAnonProxy,
  type StartManagedAnonProxyOptions,
  type AnonAsset,
} from './transport/anon-proxy.js';

// Config validation (for advanced use cases)
export {
  validateConfig,
  applyDefaults,
  buildSettlementInfo,
  applyNetworkPresets,
  getNetworkStatus,
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
  encryptMnemonic,
  decryptMnemonic,
  generateKeystore,
  importKeystore,
  loadKeystore,
  writeKeystoreFile,
  type ToonIdentity,
  type ToonSigners,
  type PasskeyInfo,
  type KeyManagerConfig,
  type BackupPayload,
  type VaultData,
  type EncryptedKeystore,
} from './keys/index.js';
