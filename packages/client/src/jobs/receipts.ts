/**
 * The receipts the store and the gas station answer with.
 *
 * These MIRROR the two app repositories — `toon-protocol/store`'s
 * `ArnsAntPrepareReceipt` / `ArnsBuyReceipt` and `toon-protocol/gas-station`'s
 * `GasStationReceipt` — and mirror them by hand, because this package has no
 * TOON-protocol runtime dependencies. That makes them a claim about a remote
 * contract rather than a shared type, so every integer that could exceed 2^53
 * is a `string` here exactly as it is on the wire: reading one as a `number`
 * would be this client inventing precision the app never sent.
 *
 * A field this client does not read is still declared, so that a receipt logged
 * or forwarded whole keeps its shape.
 */

/** Which cluster's ar.io deployment a kind:5095 job targets. */
export type ArnsNetwork = 'mainnet' | 'devnet';

/** A name registration kind: a time-boxed lease, or a one-time permabuy. */
export type ArnsNameType = 'lease' | 'permabuy';

/** Which Solana cluster the gas station pays on. */
export type SolanaNetwork = 'mainnet' | 'devnet';

/**
 * kind:5095 `op=prepare` — the unsigned ANT-spawn transaction.
 *
 * `requiredSigners` is the compiled slot order and is **address-sorted within a
 * role**, so it says who signs, never what each one is for. Map a keypair to a
 * slot by address. The fee payer is always slot 0 and is the one slot a client
 * leaves alone.
 */
export interface ArnsAntPrepareReceipt {
  job: 'arns-buy';
  op: 'prepare';
  network: ArnsNetwork;
  /** The ANT's MPL Core asset pubkey — the `processId` for `op=buy`. */
  processId: string;
  /** The same key, named for the keypair the client signs with. */
  mint: string;
  owner: string;
  feePayer: string;
  name: string;
  antProgramId: string;
  /** Base64 v0 wire transaction, every signature slot zero-filled. */
  transaction: string;
  recentBlockhash: string;
  /** True ⇒ built on a placeholder blockhash: quote with it, never execute it. */
  draft: boolean;
  requiredSigners: string[];
  /** The subset the client must fill before the gas station will look at it. */
  clientSigners: string[];
  rentTransferLamports: string;
  estimatedFeePayerLamports: string;
  instructions: string[];
}

/** kind:5095 `op=buy` — the name is registered to the ANT. */
export interface ArnsBuyReceipt {
  job: 'arns-buy';
  network: ArnsNetwork;
  name: string;
  type: ArnsNameType;
  years: number | null;
  processId: string;
  quotedMario: string;
  registryTxId: string;
  syncAttributesTxId: string | null;
}

/**
 * Why a gas station declined, from its own closed vocabulary. The ones a client
 * driving this ceremony can act on:
 *
 *  - `float_exhausted` — the node is out of gas money; nothing to retry.
 *  - `dvm_key_misplaced` — the gas wallet appears where it may not. Almost
 *    always a transaction built wrong.
 *  - `quote_expired`, `blockhash_expired`, `blockhash_mismatch` — re-quote,
 *    re-patch, re-sign.
 *  - `missing_client_signature` — a slot is still zero: sign AFTER patching.
 *  - `confirmation_timeout` — broadcast but not confirmed. It may still land;
 *    retry with the **same** `idempotencyKey`.
 */
export type GasStationFailureReason =
  | 'malformed_transaction'
  | 'fee_payer_mismatch'
  | 'dvm_key_misplaced'
  | 'program_not_whitelisted'
  | 'priority_fee_exceeded'
  | 'channel_op_not_permitted'
  | 'missing_client_signature'
  | 'unknown_quote'
  | 'quote_expired'
  | 'blockhash_mismatch'
  | 'blockhash_expired'
  | 'simulation_failed'
  | 'delta_cap_exceeded'
  | 'float_exhausted'
  | 'quote_refused'
  | 'confirmation_timeout'
  | 'broadcast_failed';

/** kind:5096 `phase=quote` — what this node will do, and what it will cost. */
export interface GasStationQuoteReceipt {
  job: 'gas-station';
  phase: 'quote';
  status: 'ok';
  network: SolanaNetwork;
  quoteId: string;
  /** The address the transaction must name as its fee payer. */
  feePayer: string;
  maxLamports: string;
  /** The blockhash the executed transaction must carry. */
  recentBlockhash: string;
  /** ms epoch — quote TTL and blockhash validity, merged into one deadline. */
  expiresAt: number;
}

/** kind:5096 `phase=execute` — co-signed, broadcast, confirmed. */
export interface GasStationExecuteReceipt {
  job: 'gas-station';
  phase: 'execute';
  status: 'ok';
  network: SolanaNetwork;
  quoteId: string;
  idempotencyKey: string;
  signature: string;
  slot: string | null;
  feeLamportsActual: string | null;
  /** True when this result was replayed from the idempotency store. */
  replayed?: boolean;
}

/**
 * The gate said no — and said so as an accepted job, because it was asked a
 * question and applied its rules. Branch on {@link reason}, never on `detail`.
 */
export interface GasStationFailureReceipt {
  job: 'gas-station';
  phase: 'quote' | 'execute';
  status: 'failed';
  network: SolanaNetwork;
  reason: GasStationFailureReason;
  detail: string;
}

export type GasStationReceipt =
  | GasStationQuoteReceipt
  | GasStationExecuteReceipt
  | GasStationFailureReceipt;

/** True when a gas-station receipt is the gate declining. */
export function isGasStationFailure(
  receipt: GasStationReceipt
): receipt is GasStationFailureReceipt {
  return receipt.status === 'failed';
}
