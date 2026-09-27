// x402 `batch-settlement` (connector ADR 0074): the chain half of paying a
// connector from an x402 channel — channel config and id, vouchers, and the
// gasless deposit or sponsored open. How a voucher rides TOON's wire is fixed by
// the connector's vectors, and is not here yet (toon-client#679).
export {
  X402_BATCH_SETTLEMENT_ADDRESS,
  ERC3009_DEPOSIT_COLLECTOR_ADDRESS,
  PERMIT2_DEPOSIT_COLLECTOR_ADDRESS,
  PERMIT2_ADDRESS,
  MIN_WITHDRAW_DELAY_SECONDS,
  MAX_WITHDRAW_DELAY_SECONDS,
  evmChainIdOf,
  buildBatchChannelConfig,
  batchChannelId,
  batchVoucherDigest,
  signBatchVoucher,
  buildEip3009Deposit,
  buildPermit2Deposit,
  type BatchSettlementEvmOffer,
  type BatchChannelConfig,
  type BatchVoucher,
  type BatchDepositPayload,
  type Eip3009DepositPayload,
  type Permit2DepositPayload,
  type TypedDataSigner,
} from './evm.js';
export { settleDeposit, type SettledDeposit } from './facilitator.js';
export {
  PAYMENT_CHANNELS_PROGRAM_ID,
  MIN_GRACE_PERIOD_SECONDS,
  MAX_GRACE_PERIOD_SECONDS,
  buildSvmBatchChannelConfig,
  svmBatchChannelAddress,
  paymentChannelsEventAuthority,
  buildSvmTopUpInstruction,
  buildSponsoredOpen,
  acceptSponsorSignature,
  buildSvmVoucherMessage,
  signSvmVoucher,
  decodeSvmBatchChannel,
  singleRecipientDistributionHash,
  type BatchSettlementSvmOffer,
  type SvmBatchChannelConfig,
  type SvmBatchVoucher,
  type SvmBatchChannelState,
} from './svm.js';
export {
  CONNECTOR_MAX_TIMEOUT_SECONDS,
  parseBatchSettlementOffer,
  parseBatchSettlementTerms,
  offerFromTerms,
  chooseBatchSettlement,
  type BatchSettlementOffer,
  type BatchSettlementTerms,
} from './offers.js';
export {
  evmVoucherClaim,
  solanaVoucherClaim,
  nextVoucherAmount,
  type VoucherClaimEnvelope,
} from './claim.js';
export { BatchChannelManager, type BatchChannel } from './manager.js';
export {
  X402_BATCH_SETTLEMENT_READ_ABI,
  readEvmBatchChannel,
  type EvmBatchChannelState,
  type ContractReader,
} from './evm.js';
export { getSvmBatchChannel } from './svm.js';
export {
  BatchSettlementPayer,
  voucherRefusalIsNotAdvancing,
  type BatchSettlementPayerConfig,
  type PreparedVoucher,
  type VoucherOutcome,
} from './payer.js';
