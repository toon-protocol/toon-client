// Main Client
export { ToonClient } from './ToonClient.js';

// Types
export type {
  ToonClientConfig,
  SolanaChannelClientOptions,
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
export { buildStoreWriteEnvelope } from './utils/store-envelope.js';
export {
  parseFulfillHttp,
  parseFulfillHttpBytes,
  type ParsedFulfillHttp,
} from './utils/fulfill-http.js';

// Config validation (for advanced use cases)
export {
  validateConfig,
  applyDefaults,
  buildSettlementInfo,
  applyNetworkPresets,
  getNetworkStatus,
  proxyIlpEndpoint,
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

// Devnet faucet helper
export {
  fundWallet,
  type FaucetChain,
  type FundWalletResult,
  type FundWalletOptions,
} from './faucet.js';

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

// NIP-on-TOON render dispatch (render trust gradient: native / A2UI / mcp-ui /
// generative). Branch 1 (native registry) is wired; branch 3 (#90) adds the
// consent invariant; branches 2/4 route to marked decisions for sibling tickets
// (#89/#92). See toon-meta#58.
export {
  renderDispatch,
  resolveRendererMime,
  resolveUiCoordinate,
  resolveUiRenderer,
  guardedRenderDispatch,
  KindRegistry,
  UI_RENDERER_KIND,
  UI_TAG,
  MIME_A2UI,
  MIME_MCP_APP,
  parseUiCoordinate,
  getUiCoordinate,
  buildUiCoordinate,
  selectLatestAddressable,
  // Renderer-swap defense (toon-client#91).
  verifyRendererTrust,
  isTrustDowngrade,
  RendererPinStore,
  // Branch 3 consent invariant (#90).
  extractUiResource,
  classifyIntent,
  buildConsentRequest,
  type ResolvedCoordinate,
  // Branch 4 — generative fallback + optional kind:31036 publish-back (#92).
  GenerativeFallbackRenderer,
  deterministicGenerator,
  renderDeterministicHtml,
  buildRendererEventTemplate,
  publishBackCoordinate,
  type DispatchInput,
  type GuardedDispatchInput,
  type DispatchGuardInfo,
  type UiCoordinate,
  type SwapDecision,
  type SwapApproval,
  type SwapRejection,
  type SwapRejectionReason,
  type RendererPin,
  type VerifyRendererInput,
  type RenderBranch,
  type RenderTrust,
  type RenderDecision,
  type NativeDecision,
  type A2uiDecision,
  type McpUiDecision,
  type GenerativeDecision,
  type UiResource,
  type WidgetIntent,
  type IntentClassification,
  type ConsentRequest,
  type ConsentDecision,
  type GeneratedRenderer,
  type GenerateContext,
  type RendererGenerator,
  type RendererSigner,
  type RendererPublisher,
  type PublishBackOptions,
  type GenerativeFallbackOptions,
  type GenerativeFallbackResult,
} from './render/index.js';
