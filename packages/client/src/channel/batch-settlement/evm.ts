/**
 * x402 `batch-settlement` on EVM — the chain half of a client that pays a
 * connector from an x402 channel instead of a `TokenNetwork` one (connector ADR
 * 0074, toon-client#679).
 *
 * Everything here is fixed by x402 and the contracts it deployed, not by TOON:
 * `x402BatchSettlement` and its two deposit collectors sit at one address on Base
 * Sepolia and Base mainnet, ownerless and immutable. Cited against x402 at
 * `0cb1a1f0` (`contracts/evm/src/x402BatchSettlement.sol`, and
 * `specs/schemes/batch-settlement/scheme_batch_settlement_evm.md`), and checked in
 * the tests against the published `@x402/evm` 2.27.0 client, which is the
 * reference this module must never drift from.
 *
 *   1. A channel is a {@link BatchChannelConfig}. Its id is the EIP-712 hash of
 *      that config under the contract's domain (`getChannelId`), so the id binds
 *      the chain and the contract — and, through a free `salt`, a client may hold
 *      as many channels to one connector as it likes (ADR 0074 decision 2).
 *   2. A voucher signs `Voucher(bytes32 channelId, uint128 maxClaimableAmount)`
 *      under the same domain. It is cumulative and carries no nonce: the
 *      connector orders vouchers by amount alone (decision 3).
 *   3. The first deposit CREATES the channel, and anyone may submit it: the
 *      payer signs an ERC-3009 `ReceiveWithAuthorization` (or a Permit2 witness
 *      transfer, for a token without ERC-3009) whose nonce/witness binds it to
 *      the channel id, and a facilitator relays it and pays the gas.
 *
 * What travels on TOON's wire — the claim JSON a voucher rides in — is NOT here.
 * The connector's vectors fix it (ADR 0074 decision 7), and they have not landed.
 */

import {
  encodeAbiParameters,
  getAddress,
  hashTypedData,
  keccak256,
  toHex,
  type Hex,
} from 'viem';
import { ConfigError, ValidationError } from '../../client/errors.js';

// ---------------------------------------------------------------------------
// The deployment (identical on Base Sepolia and Base mainnet — ADR 0074 Sources)
// ---------------------------------------------------------------------------

/** `x402BatchSettlement`: the escrow every channel lives in. */
export const X402_BATCH_SETTLEMENT_ADDRESS =
  '0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003';
/** The collector a deposit names when it is paid by an ERC-3009 authorization. */
export const ERC3009_DEPOSIT_COLLECTOR_ADDRESS =
  '0x4020806089470a89826cB9fB1f4059150b550004';
/** The collector a deposit names when it is paid by a Permit2 witness transfer. */
export const PERMIT2_DEPOSIT_COLLECTOR_ADDRESS =
  '0x4020425FAf3B746C082C2f942b4E5159887B0005';
/** Uniswap's canonical Permit2, the same address on every chain. */
export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

/** `MIN_WITHDRAW_DELAY` / `MAX_WITHDRAW_DELAY` (`x402BatchSettlement.sol#L85-L86`), seconds. */
export const MIN_WITHDRAW_DELAY_SECONDS = 15 * 60;
export const MAX_WITHDRAW_DELAY_SECONDS = 30 * 24 * 60 * 60;

/**
 * The largest amount a connector's claim gate holds (`u64` today). A voucher is
 * `uint128` on chain, but one above this is refused by the connector rather than
 * truncated (ADR 0074 decision 3), so it is refused here, before it is signed.
 */
const MAX_VOUCHER_AMOUNT = 2n ** 64n - 1n;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const CHANNEL_CONFIG_TYPES = {
  ChannelConfig: [
    { name: 'payer', type: 'address' },
    { name: 'payerAuthorizer', type: 'address' },
    { name: 'receiver', type: 'address' },
    { name: 'receiverAuthorizer', type: 'address' },
    { name: 'token', type: 'address' },
    { name: 'withdrawDelay', type: 'uint40' },
    { name: 'salt', type: 'bytes32' },
  ],
} as const;

const VOUCHER_TYPES = {
  Voucher: [
    { name: 'channelId', type: 'bytes32' },
    { name: 'maxClaimableAmount', type: 'uint128' },
  ],
} as const;

const RECEIVE_WITH_AUTHORIZATION_TYPES = {
  ReceiveWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

const PERMIT2_WITNESS_TYPES = {
  PermitWitnessTransferFrom: [
    { name: 'permitted', type: 'TokenPermissions' },
    { name: 'spender', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'witness', type: 'DepositWitness' },
  ],
  TokenPermissions: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
  DepositWitness: [{ name: 'channelId', type: 'bytes32' }],
} as const;

/** The contract's EIP-712 domain: `("x402 Batch Settlement", "1", chainId, contract)`. */
function batchSettlementDomain(chainId: number) {
  return {
    name: 'x402 Batch Settlement',
    version: '1',
    chainId,
    verifyingContract: X402_BATCH_SETTLEMENT_ADDRESS as Hex,
  } as const;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A connector's `batch-settlement` offer on EVM: one `accepts[]` entry of its
 * greeting. Unlike the `toon-channel` entry it is x402-valid (ADR 0074 decision
 * 8), so its shape is x402's `PaymentRequirements`, field for field.
 */
export interface BatchSettlementEvmOffer {
  scheme: 'batch-settlement';
  /** CAIP-2, `eip155:<chainId>`. */
  network: string;
  /** Per-request price, atomic units. */
  amount: string;
  /** The token address. */
  asset: string;
  /** The connector's EVM settlement address — the channel's `receiver`. */
  payTo: string;
  maxTimeoutSeconds: number;
  extra: {
    /** Must be `payTo`: a connector never delegates it (ADR 0074 decision 5). */
    receiverAuthorizer: string;
    /** The connector's published MINIMUM `withdrawDelay`, seconds. */
    withdrawDelay: number;
    /** The token's own EIP-712 domain, which an ERC-3009 authorization signs under. */
    name?: string;
    version?: string;
  };
}

/** `x402BatchSettlement.ChannelConfig` — the seven immutable fields a channel id hashes. */
export interface BatchChannelConfig {
  payer: string;
  payerAuthorizer: string;
  receiver: string;
  receiverAuthorizer: string;
  token: string;
  withdrawDelay: number;
  salt: Hex;
}

/** A signed voucher, in x402's own spelling. `maxClaimableAmount` is decimal. */
export interface BatchVoucher {
  channelId: Hex;
  maxClaimableAmount: string;
  signature: Hex;
}

/** Anything that can sign EIP-712 typed data as one address — a viem `LocalAccount`. */
export interface TypedDataSigner {
  address: string;
  signTypedData: (params: never) => Promise<Hex>;
}

/** x402's `deposit` payload: a deposit authorization plus the voucher it must carry. */
export interface BatchDepositPayload<A> {
  type: 'deposit';
  channelConfig: BatchChannelConfig;
  voucher: BatchVoucher;
  deposit: { amount: string; authorization: A };
}

export type Eip3009DepositPayload = BatchDepositPayload<{
  erc3009Authorization: {
    validAfter: string;
    validBefore: string;
    salt: Hex;
    signature: Hex;
  };
}>;

export type Permit2DepositPayload = BatchDepositPayload<{
  permit2Authorization: {
    from: string;
    permitted: { token: string; amount: string };
    spender: string;
    nonce: string;
    deadline: string;
    witness: { channelId: Hex };
    signature: Hex;
  };
}>;

// ---------------------------------------------------------------------------
// Channel config and id
// ---------------------------------------------------------------------------

/** The chain id of an `eip155:<id>` CAIP-2 network, or a {@link ConfigError}. */
export function evmChainIdOf(network: string): number {
  const match = /^eip155:(\d+)$/.exec(network);
  const chainId = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new ConfigError(
      `batch-settlement offer names ${network}, which is not an eip155 network`
    );
  }
  return chainId;
}

/**
 * The config of a NEW channel to the connector that made `offer`.
 *
 * The connector admits a channel only if `receiver` and `receiverAuthorizer` are
 * both its settlement address, `token` is one it settles in, and `withdrawDelay`
 * is at least its published minimum (ADR 0074 decision 2). An offer that breaks
 * the first rule is refused here: a channel whose `receiverAuthorizer` is someone
 * else hands that party the power to refund the connector's unclaimed earnings to
 * the payer (decision 5), and the connector would refuse every voucher on it.
 *
 * `payer`, `payerAuthorizer` and `salt` are the client's. A fresh random salt is
 * drawn unless one is given, because nothing at the client edge derives an x402
 * channel — the voucher names it.
 */
export function buildBatchChannelConfig(params: {
  payer: string;
  /** A session key that signs vouchers in place of `payer`. ECDSA only. */
  payerAuthorizer?: string;
  offer: BatchSettlementEvmOffer;
  /** Seconds; at least the offer's minimum. Defaults to that minimum. */
  withdrawDelay?: number;
  salt?: Hex;
}): BatchChannelConfig {
  const { offer } = params;
  if (offer.scheme !== 'batch-settlement') {
    throw new ConfigError(
      `offer scheme is ${String(offer.scheme)}, not batch-settlement`
    );
  }
  evmChainIdOf(offer.network);

  const receiver = getAddress(offer.payTo);
  const receiverAuthorizer = getAddress(offer.extra.receiverAuthorizer);
  if (receiverAuthorizer === ZERO_ADDRESS || receiverAuthorizer !== receiver) {
    throw new ConfigError(
      `batch-settlement offer's receiverAuthorizer ${receiverAuthorizer} is not its payTo ${receiver}; ` +
        'a connector never delegates it (connector ADR 0074 decision 5)'
    );
  }

  const minimum = offer.extra.withdrawDelay;
  const withdrawDelay = params.withdrawDelay ?? minimum;
  if (
    !Number.isInteger(withdrawDelay) ||
    withdrawDelay < MIN_WITHDRAW_DELAY_SECONDS ||
    withdrawDelay > MAX_WITHDRAW_DELAY_SECONDS
  ) {
    throw new ConfigError(
      `withdrawDelay ${withdrawDelay}s is outside the contract's ${MIN_WITHDRAW_DELAY_SECONDS}..${MAX_WITHDRAW_DELAY_SECONDS}s`
    );
  }
  if (withdrawDelay < minimum) {
    throw new ConfigError(
      `withdrawDelay ${withdrawDelay}s is below the connector's published minimum of ${minimum}s`
    );
  }

  return {
    payer: getAddress(params.payer),
    payerAuthorizer: getAddress(params.payerAuthorizer ?? params.payer),
    receiver,
    receiverAuthorizer,
    token: getAddress(offer.asset),
    withdrawDelay,
    salt: params.salt ?? randomBytes32(),
  };
}

/** `getChannelId(config)`: the EIP-712 hash of the config, bound to chain and contract. */
export function batchChannelId(
  config: BatchChannelConfig,
  chainId: number
): Hex {
  return hashTypedData({
    domain: batchSettlementDomain(chainId),
    types: CHANNEL_CONFIG_TYPES,
    primaryType: 'ChannelConfig',
    message: {
      payer: config.payer as Hex,
      payerAuthorizer: config.payerAuthorizer as Hex,
      receiver: config.receiver as Hex,
      receiverAuthorizer: config.receiverAuthorizer as Hex,
      token: config.token as Hex,
      withdrawDelay: config.withdrawDelay,
      salt: config.salt,
    },
  });
}

// ---------------------------------------------------------------------------
// Vouchers
// ---------------------------------------------------------------------------

function assertVoucherAmount(amount: bigint): void {
  if (amount < 0n || amount > MAX_VOUCHER_AMOUNT) {
    throw new ValidationError(
      `voucher amount ${amount} is outside 0..2^64-1, the most a connector's claim gate holds`
    );
  }
}

/**
 * `getVoucherDigest(channelId, maxClaimableAmount)` — the digest a voucher
 * signature covers. Exposed so a vector can be checked against the deployed
 * contract's own view function (ADR 0074 decision 7).
 */
export function batchVoucherDigest(
  chainId: number,
  channelId: Hex,
  maxClaimableAmount: bigint
): Hex {
  assertVoucherAmount(maxClaimableAmount);
  return hashTypedData({
    domain: batchSettlementDomain(chainId),
    types: VOUCHER_TYPES,
    primaryType: 'Voucher',
    message: { channelId, maxClaimableAmount },
  });
}

/**
 * Sign a cumulative voucher on `channelId`.
 *
 * The signer must be the channel's `payerAuthorizer` (or its `payer`, when the
 * authorizer is zero, which this client never builds). The connector checks it
 * against the config the client presented, never against anything in the claim.
 */
export async function signBatchVoucher(
  signer: TypedDataSigner,
  chainId: number,
  channelId: Hex,
  maxClaimableAmount: bigint
): Promise<BatchVoucher> {
  assertVoucherAmount(maxClaimableAmount);
  const signature = await signer.signTypedData({
    domain: batchSettlementDomain(chainId),
    types: VOUCHER_TYPES,
    primaryType: 'Voucher',
    message: { channelId, maxClaimableAmount },
  } as never);
  return {
    channelId,
    maxClaimableAmount: maxClaimableAmount.toString(),
    signature,
  };
}

// ---------------------------------------------------------------------------
// Deposits
// ---------------------------------------------------------------------------

interface DepositParams {
  /** The funding wallet — `config.payer`. */
  payer: TypedDataSigner;
  /** Signs the voucher; must be `config.payerAuthorizer`. Defaults to `payer`. */
  voucherSigner?: TypedDataSigner;
  offer: BatchSettlementEvmOffer;
  config: BatchChannelConfig;
  /** Atomic units moved into escrow. */
  amount: bigint;
  /**
   * The CUMULATIVE voucher the deposit carries, at least one unit: x402's
   * TypeScript and Python facilitators refuse a zero voucher on a fresh channel
   * (ADR 0074 prerequisite 1). On a first deposit the first packet's charge is
   * the natural choice, and that same voucher may then ride the first packet. On
   * a top-up it is the channel's running total, which may well exceed `amount`;
   * the facilitator bounds it by balance plus deposit, which only it can read.
   */
  voucherAmount: bigint;
}

async function depositVoucher(
  params: DepositParams,
  chainId: number,
  channelId: Hex
): Promise<BatchVoucher> {
  const { config, amount, voucherAmount } = params;
  if (amount <= 0n) {
    throw new ValidationError(`deposit amount must be positive, got ${amount}`);
  }
  if (voucherAmount < 1n) {
    throw new ValidationError(
      `a deposit's voucher must be at least 1 unit, got ${voucherAmount}`
    );
  }
  if (getAddress(params.payer.address) !== getAddress(config.payer)) {
    throw new ValidationError(
      `deposit signer ${params.payer.address} is not the channel payer ${config.payer}`
    );
  }
  const voucherSigner = params.voucherSigner ?? params.payer;
  if (
    getAddress(voucherSigner.address) !== getAddress(config.payerAuthorizer)
  ) {
    throw new ValidationError(
      `voucher signer ${voucherSigner.address} is not the channel's payerAuthorizer ${config.payerAuthorizer}`
    );
  }
  return signBatchVoucher(voucherSigner, chainId, channelId, voucherAmount);
}

/**
 * A deposit paid by ERC-3009 `receiveWithAuthorization` — fully gasless for the
 * payer, since a facilitator submits it. The authorization's nonce is
 * `keccak256(abi.encode(channelId, salt))` (`ERC3009DepositCollector.sol#L34-L51`),
 * so the payer's one signature binds the deposit to this channel and no other.
 *
 * The first deposit creates the channel; a later one on the same config is a
 * top-up, built the same way.
 */
export async function buildEip3009Deposit(
  params: DepositParams & {
    /** A 32-byte ERC-3009 salt; fresh and random by default. */
    salt?: Hex;
  }
): Promise<Eip3009DepositPayload> {
  const { offer, config, amount } = params;
  const chainId = evmChainIdOf(offer.network);
  const { name, version } = offer.extra;
  if (!name || !version) {
    throw new ConfigError(
      `batch-settlement offer for ${offer.asset} carries no EIP-712 domain (extra.name / extra.version) ` +
        'to sign an ERC-3009 authorization under'
    );
  }
  const channelId = batchChannelId(config, chainId);
  const voucher = await depositVoucher(params, chainId, channelId);

  const salt = params.salt ?? randomBytes32();
  const validBefore = BigInt(nowSeconds() + offer.maxTimeoutSeconds);
  const signature = await params.payer.signTypedData({
    domain: {
      name,
      version,
      chainId,
      verifyingContract: getAddress(offer.asset),
    },
    types: RECEIVE_WITH_AUTHORIZATION_TYPES,
    primaryType: 'ReceiveWithAuthorization',
    message: {
      from: getAddress(params.payer.address),
      to: ERC3009_DEPOSIT_COLLECTOR_ADDRESS,
      value: amount,
      validAfter: 0n,
      validBefore,
      nonce: keccak256(
        encodeAbiParameters(
          [{ type: 'bytes32' }, { type: 'uint256' }],
          [channelId, BigInt(salt)]
        )
      ),
    },
  } as never);

  return {
    type: 'deposit',
    channelConfig: config,
    voucher,
    deposit: {
      amount: amount.toString(),
      authorization: {
        erc3009Authorization: {
          validAfter: '0',
          validBefore: validBefore.toString(),
          salt,
          signature,
        },
      },
    },
  };
}

/**
 * A deposit paid by a Permit2 witness transfer, for a token without ERC-3009.
 * The witness is `DepositWitness(channelId)` (`Permit2DepositCollector.sol#L29-L33`).
 *
 * This is gasless only once the payer has approved Permit2 for the token, which
 * is a transaction of its own. On x402.org that approval was NOT sponsored in
 * practice (ADR 0074 prerequisite 2), so a client that holds no gas needs either
 * an ERC-3009 token or a facilitator that funds the approval itself.
 */
export async function buildPermit2Deposit(
  params: DepositParams & {
    /** A Permit2 unordered nonce; fresh and random by default. */
    nonce?: bigint;
  }
): Promise<Permit2DepositPayload> {
  const { offer, config, amount } = params;
  const chainId = evmChainIdOf(offer.network);
  const channelId = batchChannelId(config, chainId);
  const voucher = await depositVoucher(params, chainId, channelId);

  const nonce = params.nonce ?? BigInt(randomBytes32());
  const deadline = BigInt(nowSeconds() + offer.maxTimeoutSeconds);
  const token = getAddress(offer.asset);
  const signature = await params.payer.signTypedData({
    domain: { name: 'Permit2', chainId, verifyingContract: PERMIT2_ADDRESS },
    types: PERMIT2_WITNESS_TYPES,
    primaryType: 'PermitWitnessTransferFrom',
    message: {
      permitted: { token, amount },
      spender: PERMIT2_DEPOSIT_COLLECTOR_ADDRESS,
      nonce,
      deadline,
      witness: { channelId },
    },
  } as never);

  return {
    type: 'deposit',
    channelConfig: config,
    voucher,
    deposit: {
      amount: amount.toString(),
      authorization: {
        permit2Authorization: {
          from: getAddress(params.payer.address),
          permitted: { token, amount: amount.toString() },
          spender: PERMIT2_DEPOSIT_COLLECTOR_ADDRESS,
          nonce: nonce.toString(),
          deadline: deadline.toString(),
          witness: { channelId },
          signature,
        },
      },
    },
  };
}

function randomBytes32(): Hex {
  return toHex(globalThis.crypto.getRandomValues(new Uint8Array(32)));
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

// ---------------------------------------------------------------------------
// Reading a channel back
// ---------------------------------------------------------------------------

/** `channels(id)` and `pendingWithdrawals(id)` (`x402BatchSettlement.sol`). */
export const X402_BATCH_SETTLEMENT_READ_ABI = [
  {
    type: 'function',
    name: 'channels',
    stateMutability: 'view',
    inputs: [{ name: 'channelId', type: 'bytes32' }],
    outputs: [
      { name: 'balance', type: 'uint128' },
      { name: 'totalClaimed', type: 'uint128' },
    ],
  },
  {
    type: 'function',
    name: 'pendingWithdrawals',
    stateMutability: 'view',
    inputs: [{ name: 'channelId', type: 'bytes32' }],
    outputs: [
      { name: 'amount', type: 'uint128' },
      { name: 'initiatedAt', type: 'uint40' },
    ],
  },
] as const;

/** An EVM batch-settlement channel as the chain holds it. */
export interface EvmBatchChannelState {
  /** Everything ever deposited, less what has left through a withdrawal or refund. */
  balance: bigint;
  /** What the receiver has claimed — a floor under the connector's watermark. */
  totalClaimed: bigint;
  /** A timed withdrawal in flight, zero if none. */
  pendingWithdrawal: bigint;
  /** Unix seconds the pending withdrawal started, zero if none. */
  withdrawalInitiatedAt: number;
}

/** Anything with viem's `readContract`, such as a `PublicClient`. */
export interface ContractReader {
  readContract: (params: never) => Promise<unknown>;
}

/** Read `channelId`'s escrow and claim totals, and any pending withdrawal. */
export async function readEvmBatchChannel(
  client: ContractReader,
  channelId: Hex
): Promise<EvmBatchChannelState> {
  const read = (functionName: 'channels' | 'pendingWithdrawals') =>
    client.readContract({
      address: X402_BATCH_SETTLEMENT_ADDRESS,
      abi: X402_BATCH_SETTLEMENT_READ_ABI,
      functionName,
      args: [channelId],
    } as never) as Promise<readonly [bigint, bigint | number]>;
  const [[balance, totalClaimed], [pending, initiatedAt]] = await Promise.all([
    read('channels'),
    read('pendingWithdrawals'),
  ]);
  return {
    balance,
    totalClaimed: BigInt(totalClaimed),
    pendingWithdrawal: pending,
    withdrawalInitiatedAt: Number(initiatedAt),
  };
}
