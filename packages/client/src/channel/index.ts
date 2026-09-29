// The store every channel's watermark and config persist in.
export {
  JsonFileChannelStore,
  InMemoryChannelStore,
  type ChannelStore,
  type ChannelStoreEntry,
  type ChannelBinding,
  type ChannelBindingContext,
  type BatchSettlementBinding,
} from './ChannelStore.js';
export type { ChainKind } from './types.js';

// Solana wire transactions this client did NOT build: reading one, moving the
// blockhash a fee payer chose, and filling the signature slots that are ours.
export {
  generateSolanaKeypair,
  parseSolanaWireTransaction,
  patchSolanaRecentBlockhash,
  signSolanaWireTransaction,
  solanaKeypair,
  type SolanaWireTransaction,
} from './solana/wire-transaction.js';
export type { Signer as SolanaKeypair } from './solana/payment-channel.js';

// A Solana JSON-RPC call that got no answer after its retries. The outcome of a
// chain write that did not end confirmed is `TransactionOutcomeError`, exported
// with the other client errors.
export { SolanaRpcTransportError } from './solana/payment-channel.js';

// Every channel is an x402 batch-settlement channel (connector ADRs 0074,
// 0075): opened with no native gas, and paid with vouchers.
export * from './batch-settlement/index.js';
