export {
  OnChainChannelClient,
  type OnChainChannelClientConfig,
  type SolanaChannelConfig,
  type EvmReadConsistencyConfig,
} from './OnChainChannelClient.js';
export {
  ChannelManager,
  type ChannelManagerConfig,
  type EnsureChannelOptions,
} from './ChannelManager.js';
export {
  JsonFileChannelStore,
  InMemoryChannelStore,
  type ChannelStore,
  type ChannelStoreEntry,
  type ChannelBinding,
  type ChannelBindingContext,
} from './ChannelStore.js';
export {
  counterpartyMatch,
  sameSettlementAddress,
  type CounterpartyVerdict,
} from './counterparty.js';
export {
  isUnknownChannelReject,
  rejectNamesChannel,
  CLAIM_REJECT_CODE,
} from './stale-channel.js';
export type {
  ChainKind,
  ChannelClient,
  ChannelStatus,
  ChannelTerms,
  OnChainChannelStatus,
  OpenChannelParams,
  OpenChannelResult,
} from './types.js';

// EVM settlement: the contracts, the id derivation that makes a channel
// adoptable without a record, and the client that drives the lifecycle.
export {
  TokenNetworkClient,
  parseEvmChainId,
  MIN_SETTLEMENT_TIMEOUT_SECONDS,
  type TokenNetworkClientConfig,
  type EvmChannelRecord,
  type OpenOrAdoptParams,
} from './evm/TokenNetworkClient.js';
export { deriveEvmChannelId, sortParticipants } from './evm/channel-id.js';
export {
  TOKEN_NETWORK_ABI,
  TOKEN_NETWORK_REGISTRY_ABI,
  ERC20_ABI,
} from './evm/abi.js';
