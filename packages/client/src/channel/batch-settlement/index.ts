// x402 `batch-settlement` (connector ADRs 0074, 0075): the only way this client
// pays a connector.
//
// What is exported is the chain-blind lifecycle (the payer, the channel
// record) and the seam it pays through: the settlement network, one adapter per
// network. The per-chain helpers each adapter composes (channel config and id,
// deposits, vouchers, claims, challenges, exits, the sponsor and facilitator
// calls) are its own, and are not exported (toon-client#780).

// The deployments' fixed facts.
export {
  X402_BATCH_SETTLEMENT_ADDRESS,
  ERC3009_DEPOSIT_COLLECTOR_ADDRESS,
  PERMIT2_DEPOSIT_COLLECTOR_ADDRESS,
  PERMIT2_ADDRESS,
  MIN_WITHDRAW_DELAY_SECONDS,
  MAX_WITHDRAW_DELAY_SECONDS,
  type BatchChannelConfig,
  type BatchSettlementEvmOffer,
  type ContractReader,
  type TypedDataSigner,
} from './evm.js';
export {
  PAYMENT_CHANNELS_PROGRAM_ID,
  MIN_GRACE_PERIOD_SECONDS,
  MAX_GRACE_PERIOD_SECONDS,
  type BatchSettlementSvmOffer,
  type SvmBatchChannelConfig,
} from './svm.js';

// The connector's terms, as its self-description publishes them.
export {
  CONNECTOR_MAX_TIMEOUT_SECONDS,
  parseBatchSettlementOffer,
  parseBatchSettlementTerms,
  offerFromTerms,
  chooseBatchSettlement,
  type BatchSettlementOffer,
  type BatchSettlementTerms,
} from './offers.js';

// The chain-blind lifecycle.
export { nextVoucherAmount, type VoucherClaimEnvelope } from './claim.js';
export { CHANNEL_CHALLENGE_MAX_LIFETIME_SECONDS } from './challenge.js';
export { BatchChannelManager, type BatchChannel } from './manager.js';
export {
  BatchSettlementPayer,
  readVoucherRefusal,
  type BatchSettlementPayerConfig,
  type PreparedVoucher,
  type VoucherOutcome,
} from './payer.js';

// The settlement network, and its two adapters.
export {
  settlementNetworkFor,
  type ChannelStoredForm,
  type CloseOutcome,
  type Cover,
  type OpenAmounts,
  type PlannedOpen,
  type SettleOutcome,
  type SettlementNetwork,
  type TopUpAmounts,
} from './settlement-network.js';
export {
  EvmSettlementNetwork,
  evmSettlementNetwork,
  evmStoredForm,
  type EvmRpc,
  type EvmSettlementNetworkConfig,
} from './evm-network.js';
export type { EvmWalletAccess } from './deposit-gas.js';
export {
  SolanaSettlementNetwork,
  solanaStoredForm,
  type SolanaSettlementNetworkConfig,
} from './solana-network.js';
