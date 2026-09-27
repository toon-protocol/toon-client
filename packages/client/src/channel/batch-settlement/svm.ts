/**
 * x402 `batch-settlement` on Solana — the chain half of a client that pays a
 * connector from a payment-channels channel instead of a TOON-program one
 * (connector ADR 0074, toon-client#679).
 *
 * The program is solana-foundation's payment-channels,
 * `CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX` on devnet and mainnet-beta.
 * x402's own SVM TypeScript is unmerged (x402-foundation/x402#3164), so this
 * module reproduces the program's contract directly, cited to
 * `program/payment_channels/src/` at `3ffa4d67` and to x402's
 * `specs/schemes/batch-settlement/scheme_batch_settlement_svm.md` at `0cb1a1f0`,
 * and is tested against fixtures from the program's own codama client.
 *
 *   1. A channel is a PDA over `["channel", payer, payee, mint,
 *      authorized_signer, salt u64 LE, open_slot u64 LE]`
 *      (`state/channel.rs#L238-L258`). `open_slot` is a seed nobody can
 *      predict far ahead, so a channel is never derived by a connector — the
 *      voucher names it (ADR 0074 decision 2).
 *   2. A voucher is 50 bytes, `0x56 0x01 ‖ channel ‖ u64 cumulative LE ‖ i64
 *      expires_at LE` (`instructions/mod.rs`), Ed25519-signed by the channel's
 *      `authorized_signer`. `expires_at` is always zero (decision 3).
 *   3. `open` is sponsored. The sponsor is fee payer, `rent_payer` AND the
 *      zero-share `payee`, and the payee may seal the channel at any time and is
 *      the only party that can land a voucher once the payer starts to close.
 *      So the sponsor MUST be the receiving connector itself, and any other is
 *      refused before the payer signs (decision 5).
 *
 * What travels on TOON's wire, and how the connector's sponsor endpoint is
 * reached (connector #1346), are NOT here. The vectors fix the first, and the
 * second is not built.
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { base58Decode, base58Encode } from '../../utils/base58.js';
import { fromBase64, toBase64, encodeUtf8, toHex } from '../../utils/binary.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  solanaRpc,
  type SolanaRpcTarget,
  compileLegacyMessage,
  deriveAssociatedTokenAccount,
  findProgramAddress,
  padTo32,
  serializeLegacyTransaction,
  type RawInstruction,
  type Signer,
} from '../solana/payment-channel.js';
import { signSolanaWireTransaction } from '../solana/wire-transaction.js';
import { ConfigError, ValidationError } from '../../client/errors.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** solana-foundation payment-channels — a network constant, never read off the wire. */
export const PAYMENT_CHANNELS_PROGRAM_ID =
  'CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX';

const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ASSOCIATED_TOKEN_PROGRAM_ID =
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
const RENT_SYSVAR_ID = 'SysvarRent111111111111111111111111111111111';
const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

const IX_OPEN = 1;
const IX_TOP_UP = 3;
/** `VOUCHER_MAGIC`: tag `'V'` and format version 1. */
const VOUCHER_MAGIC = [0x56, 0x01] as const;
const VOUCHER_LENGTH = 50;
/** `BPS_DENOMINATOR`: one recipient takes all of it. */
const ALL_BPS = 10_000;

/** x402's conformance bound on `withdrawDelay` / `grace_period` (SVM spec §4.1). */
export const MIN_GRACE_PERIOD_SECONDS = 900;
export const MAX_GRACE_PERIOD_SECONDS = 30 * 24 * 60 * 60;

const MAX_U64 = 2n ** 64n - 1n;
const CHANNEL_ACCOUNT_LENGTH = 256;
const CHANNEL_DISCRIMINATOR = 1;
const STATUSES = ['open', 'sealed', 'closing', 'distributed'] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A connector's `batch-settlement` offer on Solana: one `accepts[]` entry of its
 * greeting, in x402's `PaymentRequirements` shape (ADR 0074 decision 8).
 */
export interface BatchSettlementSvmOffer {
  scheme: 'batch-settlement';
  /** CAIP-2, `solana:<genesis hash prefix>`. */
  network: string;
  amount: string;
  /** The mint. */
  asset: string;
  /** The owner of the connector's receiving account — the one distribution recipient. */
  payTo: string;
  maxTimeoutSeconds: number;
  extra: {
    /** The connector's sponsor key: fee payer, `rent_payer` and zero-share `payee`. */
    feePayer: string;
    /** The connector's published MINIMUM `grace_period`, seconds. */
    withdrawDelay: number;
    /** The program that owns `asset`. */
    tokenProgram: string;
    /** When present, the `open` transaction's memo must be exactly this. */
    memo?: string;
    /**
     * The connector's own field, not x402's: the smallest deposit it will
     * sponsor an open for, atomic units (connector #1346).
     */
    minDeposit?: string;
    /**
     * The connector's own field, not x402's: the path, on the connector's
     * client edge, that co-signs and submits a sponsored `open` (connector #1357).
     */
    sponsorEndpoint?: string;
  };
}

/** x402's SVM `ChannelConfig`: what a channel's PDA and `open` are built from. */
export interface SvmBatchChannelConfig {
  payer: string;
  /** The channel's `authorized_signer` — the key that signs vouchers. */
  payerAuthorizer: string;
  receiver: string;
  token: string;
  withdrawDelay: number;
  salt: bigint;
  openSlot: bigint;
}

/** A signed voucher, in x402's `BatchVoucher` spelling. */
export interface SvmBatchVoucher {
  channelId: string;
  maxClaimableAmount: string;
  expiresAt: 0;
  /** Base58 Ed25519 signature. */
  signature: string;
}

/** The 256-byte `Channel` account, decoded. */
export interface SvmBatchChannelState {
  status: (typeof STATUSES)[number];
  salt: bigint;
  deposit: bigint;
  settled: bigint;
  payoutWatermark: bigint;
  closureStartedAt: bigint;
  payerWithdrawnAt: bigint;
  gracePeriod: number;
  distributionHash: Uint8Array;
  payer: string;
  payee: string;
  authorizedSigner: string;
  mint: string;
  rentPayer: string;
  openSlot: bigint;
}

// ---------------------------------------------------------------------------
// Config and addresses
// ---------------------------------------------------------------------------

/**
 * The config of a NEW channel to the connector that made `offer`.
 *
 * x402 fixes most of it from the offer (SVM spec §4.1): the mint, the single
 * recipient `payTo`, and `grace_period`. The client chooses `payer`, the voucher
 * key, `salt`, and `openSlot` — a recent slot; the program refuses one more than
 * 1,500 slots old, so it is fetched just before the transaction is built.
 *
 * Only SPL Token mints are built for: the associated-token-account derivation
 * this client carries is SPL Token's.
 */
export function buildSvmBatchChannelConfig(params: {
  payer: string;
  payerAuthorizer?: string;
  offer: BatchSettlementSvmOffer;
  openSlot: bigint;
  /** Seconds; at least the offer's minimum. Defaults to that minimum. */
  withdrawDelay?: number;
  salt?: bigint;
}): SvmBatchChannelConfig {
  const { offer } = params;
  if (offer.scheme !== 'batch-settlement') {
    throw new ConfigError(
      `offer scheme is ${String(offer.scheme)}, not batch-settlement`
    );
  }
  if (!offer.network.startsWith('solana:')) {
    throw new ConfigError(
      `batch-settlement offer names ${offer.network}, which is not a Solana network`
    );
  }
  if (offer.extra.tokenProgram !== TOKEN_PROGRAM_ID) {
    throw new ConfigError(
      `batch-settlement offer's mint is owned by ${offer.extra.tokenProgram}; only SPL Token is supported`
    );
  }
  const sponsor = offer.extra.feePayer;
  const payerAuthorizer = params.payerAuthorizer ?? params.payer;
  if (params.payer === sponsor || payerAuthorizer === sponsor) {
    throw new ConfigError(
      `the sponsor ${sponsor} cannot also be the payer or the voucher signer: it is the channel's payee`
    );
  }

  const minimum = offer.extra.withdrawDelay;
  const withdrawDelay = params.withdrawDelay ?? minimum;
  if (
    !Number.isInteger(withdrawDelay) ||
    withdrawDelay < MIN_GRACE_PERIOD_SECONDS ||
    withdrawDelay > MAX_GRACE_PERIOD_SECONDS
  ) {
    throw new ConfigError(
      `withdrawDelay ${withdrawDelay}s is outside x402's ${MIN_GRACE_PERIOD_SECONDS}..${MAX_GRACE_PERIOD_SECONDS}s`
    );
  }
  if (withdrawDelay < minimum) {
    throw new ConfigError(
      `withdrawDelay ${withdrawDelay}s is below the connector's published minimum of ${minimum}s`
    );
  }
  if (withdrawDelay < offer.maxTimeoutSeconds) {
    throw new ConfigError(
      `withdrawDelay ${withdrawDelay}s is below the offer's maxTimeoutSeconds ${offer.maxTimeoutSeconds}s (x402 SVM spec §4.1)`
    );
  }

  const salt = params.salt ?? randomU64();
  assertU64(salt, 'salt');
  assertU64(params.openSlot, 'openSlot');
  return {
    payer: params.payer,
    payerAuthorizer,
    receiver: offer.payTo,
    token: offer.asset,
    withdrawDelay,
    salt,
    openSlot: params.openSlot,
  };
}

/** The channel PDA — the `channelId` every voucher on it names. */
export function svmBatchChannelAddress(
  config: SvmBatchChannelConfig,
  sponsor: string
): string {
  const { pda } = findProgramAddress(
    [
      encodeUtf8('channel'),
      key(config.payer),
      key(sponsor),
      key(config.token),
      key(config.payerAuthorizer),
      u64(config.salt),
      u64(config.openSlot),
    ],
    key(PAYMENT_CHANNELS_PROGRAM_ID)
  );
  return base58Encode(pda);
}

/** The program's event-authority PDA (`["event_authority"]`), an `open` account. */
export function paymentChannelsEventAuthority(): string {
  const { pda } = findProgramAddress(
    [encodeUtf8('event_authority')],
    key(PAYMENT_CHANNELS_PROGRAM_ID)
  );
  return base58Encode(pda);
}

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------

/**
 * `open` (discriminator 1). Deliberately not exported from the package: it takes
 * any `sponsor`, and {@link buildSponsoredOpen} is the one path that checks the
 * sponsor is the receiving connector's before a payer signs.
 *
 * The 14 accounts, in the order x402's SVM spec
 * requires a sponsor to check, and `salt ‖ deposit ‖ grace_period ‖ open_slot ‖
 * recipients`, where the one recipient is `payTo` at 10,000 bps.
 */
export function buildSvmOpenInstruction(params: {
  config: SvmBatchChannelConfig;
  sponsor: string;
  deposit: bigint;
}): RawInstruction {
  const { config, sponsor, deposit } = params;
  assertPositive(deposit, 'deposit');
  const channel = svmBatchChannelAddress(config, sponsor);

  const data = new Uint8Array(1 + 8 + 8 + 4 + 8 + 4 + 34);
  data[0] = IX_OPEN;
  data.set(u64(config.salt), 1);
  data.set(u64(deposit), 9);
  new DataView(data.buffer).setUint32(17, config.withdrawDelay, true);
  data.set(u64(config.openSlot), 21);
  new DataView(data.buffer).setUint32(29, 1, true);
  data.set(key(config.receiver), 33);
  new DataView(data.buffer).setUint16(65, ALL_BPS, true);

  return {
    programId: PAYMENT_CHANNELS_PROGRAM_ID,
    keys: [
      meta(config.payer, true, true),
      meta(sponsor, true, true),
      meta(sponsor, false, false),
      meta(config.token, false, false),
      meta(config.payerAuthorizer, false, false),
      meta(channel, false, true),
      meta(
        deriveAssociatedTokenAccount(config.payer, config.token),
        false,
        true
      ),
      meta(deriveAssociatedTokenAccount(channel, config.token), false, true),
      meta(TOKEN_PROGRAM_ID, false, false),
      meta(SYSTEM_PROGRAM_ID, false, false),
      meta(RENT_SYSVAR_ID, false, false),
      meta(ASSOCIATED_TOKEN_PROGRAM_ID, false, false),
      meta(paymentChannelsEventAuthority(), false, false),
      meta(PAYMENT_CHANNELS_PROGRAM_ID, false, false),
    ],
    data,
  };
}

/**
 * `top_up` (discriminator 3): more deposit into an Open channel. The sponsor
 * pays only the fee, so it is not among the instruction's accounts.
 */
export function buildSvmTopUpInstruction(params: {
  config: SvmBatchChannelConfig;
  sponsor: string;
  amount: bigint;
}): RawInstruction {
  const { config, sponsor, amount } = params;
  assertPositive(amount, 'top-up amount');
  const channel = svmBatchChannelAddress(config, sponsor);
  const data = new Uint8Array(9);
  data[0] = IX_TOP_UP;
  data.set(u64(amount), 1);
  return {
    programId: PAYMENT_CHANNELS_PROGRAM_ID,
    keys: [
      meta(config.payer, true, true),
      meta(channel, false, true),
      meta(
        deriveAssociatedTokenAccount(config.payer, config.token),
        false,
        true
      ),
      meta(deriveAssociatedTokenAccount(channel, config.token), false, true),
      meta(config.token, false, false),
      meta(TOKEN_PROGRAM_ID, false, false),
    ],
    data,
  };
}

// ---------------------------------------------------------------------------
// The sponsored open
// ---------------------------------------------------------------------------

/**
 * The `open` transaction for a channel the receiving connector sponsors: `[open,
 * memo]`, with the sponsor as fee payer, signed by the payer, and the sponsor's
 * slot left empty for it to fill.
 *
 * `connectorSponsor` is the sponsor key the RECEIVING connector publishes. The
 * offer's `feePayer` must be that key, or nothing is signed: a third-party
 * sponsor sits in the `payee` seat, can seal the channel before the connector
 * settles, and after the payer calls `request_close` is the only party that can
 * land a voucher — a loss to the connector, not merely a risk (ADR 0074
 * decision 5). The connector refuses such a channel, so the payer's deposit
 * would be locked for `grace_period` in a channel that buys nothing.
 *
 * The memo is the offer's when it names one, and otherwise a random 16-byte hex
 * nonce, as x402's acceptance policy requires of the transaction's suffix.
 */
export function buildSponsoredOpen(params: {
  payer: Signer;
  config: SvmBatchChannelConfig;
  offer: BatchSettlementSvmOffer;
  connectorSponsor: string;
  deposit: bigint;
  recentBlockhash: string;
  memo?: string;
}): { transaction: string; channelId: string } {
  const { payer, config, offer, connectorSponsor } = params;
  const sponsor = offer.extra.feePayer;
  if (sponsor !== connectorSponsor) {
    throw new ConfigError(
      `sponsor ${sponsor} is not the receiving connector's sponsor ${connectorSponsor}; ` +
        'a third-party sponsor can seal the channel (connector ADR 0074 decision 5)'
    );
  }
  if (base58Encode(payer.publicKey) !== config.payer) {
    throw new ValidationError(
      `signing key is not the channel payer ${config.payer}`
    );
  }

  const memo = offer.extra.memo ?? params.memo ?? toHex(randomBytes(16));
  const compiled = compileLegacyMessage(
    sponsor,
    [
      buildSvmOpenInstruction({ config, sponsor, deposit: params.deposit }),
      { programId: MEMO_PROGRAM_ID, keys: [], data: encodeUtf8(memo) },
    ],
    params.recentBlockhash
  );
  const unsigned = toBase64(serializeLegacyTransaction(compiled, []));
  return {
    transaction: signSolanaWireTransaction(unsigned, [payer]),
    channelId: svmBatchChannelAddress(config, sponsor),
  };
}

// ---------------------------------------------------------------------------
// Vouchers
// ---------------------------------------------------------------------------

/**
 * The 50 bytes a voucher signs, with `expires_at` always zero: a nonzero one is
 * value that can lapse before the connector lands it, and the connector refuses
 * it structurally (ADR 0074 decision 3). So there is no way to ask for one.
 */
export function buildSvmVoucherMessage(
  channelId: string,
  cumulative: bigint
): Uint8Array {
  assertU64(cumulative, 'voucher amount');
  const message = new Uint8Array(VOUCHER_LENGTH);
  message.set(VOUCHER_MAGIC, 0);
  message.set(key(channelId), 2);
  message.set(u64(cumulative), 34);
  // bytes 42..50: expires_at, i64 LE zero.
  return message;
}

/** Sign a cumulative voucher on `channelId` with the channel's `authorized_signer`. */
export function signSvmVoucher(
  signer: Signer,
  channelId: string,
  cumulative: bigint
): SvmBatchVoucher {
  const message = buildSvmVoucherMessage(channelId, cumulative);
  return {
    channelId,
    maxClaimableAmount: cumulative.toString(),
    expiresAt: 0,
    signature: base58Encode(ed25519.sign(message, signer.privateKey)),
  };
}

// ---------------------------------------------------------------------------
// The channel account
// ---------------------------------------------------------------------------

/**
 * Decode the 256-byte `Channel` account (`state/channel.rs`), refusing anything
 * that is not a live one: the wrong length, or a discriminator other than
 * `Channel` (a `ClosedChannel` tombstone included).
 */
export function decodeSvmBatchChannel(
  data: Uint8Array | string
): SvmBatchChannelState {
  const bytes = typeof data === 'string' ? fromBase64(data) : data;
  if (bytes.length !== CHANNEL_ACCOUNT_LENGTH) {
    throw new ValidationError(
      `a payment-channels Channel is ${CHANNEL_ACCOUNT_LENGTH} bytes, got ${bytes.length}`
    );
  }
  if (bytes[0] !== CHANNEL_DISCRIMINATOR) {
    throw new ValidationError(
      `account discriminator ${bytes[0]} is not a payment-channels Channel`
    );
  }
  const status = STATUSES[bytes[3] ?? 255];
  if (!status) {
    throw new ValidationError(
      `channel status byte ${bytes[3]} is not one the program writes`
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const address = (offset: number) =>
    base58Encode(bytes.slice(offset, offset + 32));
  return {
    status,
    salt: view.getBigUint64(4, true),
    deposit: view.getBigUint64(12, true),
    settled: view.getBigUint64(20, true),
    payoutWatermark: view.getBigUint64(28, true),
    closureStartedAt: view.getBigInt64(36, true),
    payerWithdrawnAt: view.getBigInt64(44, true),
    gracePeriod: view.getUint32(52, true),
    distributionHash: bytes.slice(56, 88),
    payer: address(88),
    payee: address(120),
    authorizedSigner: address(152),
    mint: address(184),
    rentPayer: address(216),
    openSlot: view.getBigUint64(248, true),
  };
}

/**
 * Read the channel account at `channelId` over JSON-RPC, or `null` when it does
 * not exist (never opened, or closed and deallocated). An account that exists
 * but is not a payment-channels `Channel` — the wrong owner included — throws.
 */
export async function getSvmBatchChannel(
  rpc: SolanaRpcTarget,
  channelId: string
): Promise<SvmBatchChannelState | null> {
  const result = (await solanaRpc(rpc, 'getAccountInfo', [
    channelId,
    { encoding: 'base64', commitment: 'confirmed' },
  ])) as { value: { data: [string, string]; owner: string } | null };
  if (result.value === null) return null;
  if (result.value.owner !== PAYMENT_CHANNELS_PROGRAM_ID) {
    throw new ValidationError(
      `account ${channelId} is owned by ${result.value.owner}, not payment-channels`
    );
  }
  return decodeSvmBatchChannel(result.value.data[0]);
}

/**
 * The `distribution_hash` a channel paying all of its settled value to
 * `receiver` commits to: `sha256(count u32 LE ‖ recipient ‖ bps u16 LE)`. A
 * client compares it with a decoded channel's to confirm where the money goes.
 */
export function singleRecipientDistributionHash(receiver: string): Uint8Array {
  const preimage = new Uint8Array(4 + 34);
  new DataView(preimage.buffer).setUint32(0, 1, true);
  preimage.set(key(receiver), 4);
  new DataView(preimage.buffer).setUint16(36, ALL_BPS, true);
  return sha256(preimage);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function key(address: string): Uint8Array {
  return padTo32(base58Decode(address));
}

function meta(pubkey: string, isSigner: boolean, isWritable: boolean) {
  return { pubkey, isSigner, isWritable };
}

function u64(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

function assertU64(value: bigint, what: string): void {
  if (value < 0n || value > MAX_U64) {
    throw new ValidationError(`${what} ${value} is outside u64`);
  }
}

function assertPositive(value: bigint, what: string): void {
  assertU64(value, what);
  if (value === 0n) throw new ValidationError(`${what} must be positive`);
}

function randomBytes(length: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

function randomU64(): bigint {
  return new DataView(randomBytes(8).buffer).getBigUint64(0, true);
}
