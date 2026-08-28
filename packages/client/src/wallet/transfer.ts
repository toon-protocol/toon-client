/**
 * Plain token transfer — send the settlement token or native gas from your own
 * key to an ARBITRARY address, on either chain this client supports. This is
 * the primitive underneath provisioning a second wallet: before a derived
 * address can open a payment channel, something has to send it USDC and native
 * gas.
 *
 * It has nothing to do with paying a connector. A paid request moves value by
 * signing a claim on a channel; this moves value by signing a chain
 * transaction, straight to `to`, non-custodially.
 *
 * Every send is confirmed by an OBSERVED balance delta at the destination,
 * never by the send call merely returning. The devnet faucet's Solana leg has
 * been seen returning success with a real transaction signature while
 * delivering 0 lamports (connector#691) — a send that trusted its own receipt
 * would report a funded wallet that in fact holds nothing.
 * {@link TransferNotDeliveredError} is exactly that failure mode, made loud
 * instead of silent.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
  type Hex,
} from 'viem';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base58Decode, base58Encode } from '../utils/base58.js';
import type { EvmSigner } from '../signing/evm-signer.js';
import {
  InsufficientBalanceError,
  InvalidAddressError,
  TransferNotDeliveredError,
  TransferUnsupportedError,
  UnknownChainError,
  ValidationError,
} from '../client/errors.js';
import {
  parseEvmChainId,
} from './balances.js';
import {
  buildAndSendTransaction,
  getLamports,
  getTokenAccountBalance,
  deriveAssociatedTokenAccount,
} from '../channel/solana/payment-channel.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Chains this client can send a plain transfer on. */
export type TransferChain = 'evm' | 'solana';

/** `'native'` — the chain's own gas token. `'token'` — the settlement token. */
export type TransferAssetKind = 'native' | 'token';

export interface SendTransferParams {
  chain: TransferChain;
  asset: TransferAssetKind;
  /** Destination address, in the target chain's native format. */
  to: string;
  /** Amount to send, in the asset's base units (wei, lamports, or the token's). */
  amount: string | bigint;
  /**
   * How long to wait for the destination's observed balance to reflect the
   * transfer before giving up with {@link TransferNotDeliveredError}. Default
   * 30 seconds on both chains.
   */
  confirmTimeoutMs?: number;
  /** Poll interval (ms) while waiting for the balance delta. Default 2000. */
  confirmPollIntervalMs?: number;
}

export interface SendTransferResult {
  chain: TransferChain;
  asset: TransferAssetKind;
  to: string;
  /** Base units actually requested (echoed back as a decimal string). */
  amount: string;
  /** Transaction hash / signature of the send. */
  txHash: string;
  /** Destination's observed balance immediately before the send. */
  balanceBefore: string;
  /** Destination's observed balance once the delta was confirmed. */
  balanceAfter: string;
}

/** Per-chain config a caller supplies to {@link sendTransfer}. */
export interface EvmTransferConfig {
  /** Chain key, e.g. `'evm:base-sepolia:84532'` (used for chainId + RPC). */
  chainKey: string;
  rpcUrl: string;
  signer: EvmSigner;
  /** ERC-20 settlement-token address. Required only for `asset: 'token'`. */
  tokenAddress?: string;
}

export interface SolanaTransferConfig {
  rpcUrl: string;
  /** Ed25519 signing seed (32 bytes) or a 64-byte seed||pubkey keypair. */
  keypair: Uint8Array;
  /** SPL settlement-token mint. Required only for `asset: 'token'`. */
  tokenMint?: string;
}

export interface TransferConfig {
  evm?: EvmTransferConfig;
  solana?: SolanaTransferConfig;
}

// ---------------------------------------------------------------------------
// Address validation — checked BEFORE any transaction is built, so a typo
// never costs gas/fees or risks sending funds into a black hole.
// ---------------------------------------------------------------------------

function assertValidEvmAddress(address: string): void {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new InvalidAddressError(
      `"${address}" is not a valid EVM address (expected 0x + 40 hex chars).`
    );
  }
}

function assertValidSolanaAddress(address: string): void {
  let decoded: Uint8Array;
  try {
    decoded = base58Decode(address);
  } catch (err) {
    throw new InvalidAddressError(
      `"${address}" is not valid base58 for a Solana address.`,
      err instanceof Error ? err : undefined
    );
  }
  if (decoded.length !== 32) {
    throw new InvalidAddressError(
      `"${address}" decodes to ${decoded.length} bytes, not the 32 a Solana address requires.`
    );
  }
}

// ---------------------------------------------------------------------------
// Balance-delta confirmation — the core guarantee of this module. Never trust
// the send call returning; re-read the destination and wait for it to move.
// ---------------------------------------------------------------------------

const DEFAULT_POLL_INTERVAL_MS = 2000;

/**
 * Poll `readBalance` until it reports at least `before + minDelta`, or
 * `timeoutMs` elapses. Returns the last-observed balance either way — the
 * caller decides whether the final delta was enough (see each chain's
 * sender, which throws {@link TransferNotDeliveredError} when it wasn't).
 */
async function waitForBalanceDelta(opts: {
  readBalance: () => Promise<bigint>;
  before: bigint;
  minDelta: bigint;
  timeoutMs: number;
  pollIntervalMs?: number;
}): Promise<bigint> {
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    const current = await opts.readBalance();
    if (current - opts.before >= opts.minDelta) return current;
    if (Date.now() >= deadline) return current;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

/**
 * {@link waitForBalanceDelta}, then throw {@link TransferNotDeliveredError}
 * if the final observed balance still doesn't reflect the transfer — the
 * shared tail end of every chain's send path below.
 */
async function confirmDelivered(opts: {
  readBalance: () => Promise<bigint>;
  before: bigint;
  amount: bigint;
  timeoutMs: number;
  pollIntervalMs?: number;
  notDeliveredMessage: (observedDelta: bigint) => string;
}): Promise<bigint> {
  const after = await waitForBalanceDelta({
    readBalance: opts.readBalance,
    before: opts.before,
    minDelta: opts.amount,
    timeoutMs: opts.timeoutMs,
    pollIntervalMs: opts.pollIntervalMs,
  });
  if (after - opts.before < opts.amount) {
    throw new TransferNotDeliveredError(
      opts.notDeliveredMessage(after - opts.before)
    );
  }
  return after;
}

function buildResult(
  chain: TransferChain,
  asset: TransferAssetKind,
  to: string,
  amount: bigint,
  txHash: string,
  before: bigint,
  after: bigint
): SendTransferResult {
  return {
    chain,
    asset,
    to,
    amount: amount.toString(),
    txHash,
    balanceBefore: before.toString(),
    balanceAfter: after.toString(),
  };
}

// ---------------------------------------------------------------------------
// EVM
// ---------------------------------------------------------------------------

const DEFAULT_EVM_CONFIRM_TIMEOUT_MS = 30_000;

const ERC20_TRANSFER_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'transfer',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const;

function evmClients(cfg: EvmTransferConfig) {
  const chainId = parseEvmChainId(cfg.chainKey);
  const viemChain = defineChain({
    id: chainId,
    name: cfg.chainKey,
    nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
  });
  const publicClient = createPublicClient({
    transport: http(cfg.rpcUrl),
    chain: viemChain,
  });
  const walletClient = createWalletClient({
    account: cfg.signer.account,
    transport: http(cfg.rpcUrl),
    chain: viemChain,
  });
  return { publicClient, walletClient };
}

async function sendEvmTransfer(
  cfg: EvmTransferConfig,
  params: SendTransferParams,
  amount: bigint
): Promise<SendTransferResult> {
  const { publicClient, walletClient } = evmClients(cfg);
  const from = cfg.signer.address as Hex;
  const to = params.to as Hex;
  const timeoutMs = params.confirmTimeoutMs ?? DEFAULT_EVM_CONFIRM_TIMEOUT_MS;

  if (params.asset === 'native') {
    const senderBalance = await publicClient.getBalance({ address: from });
    if (senderBalance < amount) {
      throw new InsufficientBalanceError(
        `EVM wallet ${from} holds ${senderBalance} wei, short of the ${amount} wei transfer (before gas).`
      );
    }
    const readDest = () => publicClient.getBalance({ address: to });
    const before = await readDest();
    const txHash = await walletClient.sendTransaction({ to, value: amount });
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
    });
    if (receipt.status === 'reverted') {
      throw new TransferNotDeliveredError(
        `EVM native transfer ${txHash} reverted on-chain — no funds reached ${to}.`
      );
    }
    const after = await confirmDelivered({
      readBalance: readDest,
      before,
      amount,
      timeoutMs,
      pollIntervalMs: params.confirmPollIntervalMs,
      notDeliveredMessage: (delta) =>
        `EVM native transfer ${txHash} confirmed on-chain, but ${to}'s balance only rose by ` +
        `${delta} wei (expected ${amount}) within the wait window.`,
    });
    return buildResult('evm', 'native', params.to, amount, txHash, before, after);
  }

  // Settlement token (ERC-20).
  if (!cfg.tokenAddress) {
    throw new TransferUnsupportedError(
      `No settlement-token address configured for EVM chain "${cfg.chainKey}" — cannot send the token leg.`
    );
  }
  const tokenAddr = cfg.tokenAddress as Hex;
  const readSenderBalance = () =>
    publicClient.readContract({
      address: tokenAddr,
      abi: ERC20_TRANSFER_ABI,
      functionName: 'balanceOf',
      args: [from],
    }) as Promise<bigint>;
  const readDest = () =>
    publicClient.readContract({
      address: tokenAddr,
      abi: ERC20_TRANSFER_ABI,
      functionName: 'balanceOf',
      args: [to],
    }) as Promise<bigint>;

  const senderBalance = await readSenderBalance();
  if (senderBalance < amount) {
    throw new InsufficientBalanceError(
      `EVM wallet ${from} holds ${senderBalance} base units of ${tokenAddr}, short of the ${amount} transfer.`
    );
  }
  const before = await readDest();
  const txHash = await walletClient.writeContract({
    address: tokenAddr,
    abi: ERC20_TRANSFER_ABI,
    functionName: 'transfer',
    args: [to, amount],
  });
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
  });
  if (receipt.status === 'reverted') {
    throw new TransferNotDeliveredError(
      `EVM token transfer ${txHash} reverted on-chain — no funds reached ${to}.`
    );
  }
  const after = await confirmDelivered({
    readBalance: readDest,
    before,
    amount,
    timeoutMs,
    pollIntervalMs: params.confirmPollIntervalMs,
    notDeliveredMessage: (delta) =>
      `EVM token transfer ${txHash} confirmed on-chain, but ${to}'s balance only rose by ` +
      `${delta} base units (expected ${amount}) within the wait window.`,
  });
  return buildResult('evm', 'token', params.to, amount, txHash, before, after);
}

// ---------------------------------------------------------------------------
// Solana — raw System/SPL-Token instructions over the same connector-parity
// transaction wire format `solana-payment-channel.ts` already builds and
// tests against (`buildAndSendTransaction`).
// ---------------------------------------------------------------------------

const DEFAULT_SOLANA_CONFIRM_TIMEOUT_MS = 30_000;
const SOLANA_SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
const SOLANA_TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SOLANA_ASSOCIATED_TOKEN_PROGRAM_ID =
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
/** Base fee per signature (lamports) — every tx here carries exactly one. */
const SOLANA_LAMPORTS_PER_SIGNATURE = 5_000n;

function writeU64LE(buf: Uint8Array, offset: number, value: bigint): void {
  for (let i = 0; i < 8; i++) {
    buf[offset + i] = Number((value >> BigInt(i * 8)) & 0xffn);
  }
}

async function sendSolanaTransfer(
  cfg: SolanaTransferConfig,
  params: SendTransferParams,
  amount: bigint
): Promise<SendTransferResult> {
  const payerSeed = cfg.keypair.slice(0, 32);
  const payerPubkey = base58Encode(
    new Uint8Array(ed25519.getPublicKey(payerSeed))
  );
  const payer = { publicKey: base58Decode(payerPubkey), privateKey: payerSeed };
  const timeoutMs =
    params.confirmTimeoutMs ?? DEFAULT_SOLANA_CONFIRM_TIMEOUT_MS;

  if (params.asset === 'native') {
    const lamports = await getLamports(cfg.rpcUrl, payerPubkey);
    const need = amount + SOLANA_LAMPORTS_PER_SIGNATURE;
    if (lamports < need) {
      throw new InsufficientBalanceError(
        `Solana wallet ${payerPubkey} holds ${lamports} lamports, short of the ${amount}-lamport ` +
          `transfer plus the ${SOLANA_LAMPORTS_PER_SIGNATURE}-lamport signature fee.`
      );
    }
    const readDest = () => getLamports(cfg.rpcUrl, params.to);
    const before = await readDest();

    // SystemProgram::Transfer — Borsh enum: u32 LE variant(2) + u64 LE lamports.
    const data = new Uint8Array(12);
    new DataView(data.buffer).setUint32(0, 2, true);
    writeU64LE(data, 4, amount);

    const txHash = await buildAndSendTransaction(cfg.rpcUrl, payer, [
      {
        programId: SOLANA_SYSTEM_PROGRAM_ID,
        keys: [
          { pubkey: payerPubkey, isSigner: true, isWritable: true },
          { pubkey: params.to, isSigner: false, isWritable: true },
        ],
        data,
      },
    ]);

    const after = await confirmDelivered({
      readBalance: readDest,
      before,
      amount,
      timeoutMs,
      pollIntervalMs: params.confirmPollIntervalMs,
      notDeliveredMessage: (delta) =>
        `Solana native transfer ${txHash} confirmed on-chain, but ${params.to}'s balance only rose by ` +
        `${delta} lamports (expected ${amount}) within the wait window — the devnet ` +
        `faucet's Solana leg has shown exactly this shape (connector#691): a real transaction ` +
        `signature with 0 lamports delivered.`,
    });
    return buildResult(
      'solana',
      'native',
      params.to,
      amount,
      txHash,
      before,
      after
    );
  }

  // Settlement token (SPL).
  if (!cfg.tokenMint) {
    throw new TransferUnsupportedError(
      'No settlement-token mint configured for Solana — cannot send the token leg.'
    );
  }
  const senderAta = deriveAssociatedTokenAccount(payerPubkey, cfg.tokenMint);
  const senderBalance = await getTokenAccountBalance(cfg.rpcUrl, senderAta);
  if (senderBalance === null || senderBalance < amount) {
    throw new InsufficientBalanceError(
      `Solana token account ${senderAta} holds ${senderBalance ?? 0n} base units of ${cfg.tokenMint}, ` +
        `short of the ${amount} transfer.`
    );
  }
  const lamports = await getLamports(cfg.rpcUrl, payerPubkey);
  if (lamports < SOLANA_LAMPORTS_PER_SIGNATURE) {
    throw new InsufficientBalanceError(
      `Solana wallet ${payerPubkey} holds ${lamports} lamports, below the ` +
        `${SOLANA_LAMPORTS_PER_SIGNATURE}-lamport fee this token transfer needs.`
    );
  }

  const destAta = deriveAssociatedTokenAccount(params.to, cfg.tokenMint);
  const readDest = async () =>
    (await getTokenAccountBalance(cfg.rpcUrl, destAta)) ?? 0n;
  const before = await readDest();

  // Associated-Token-Account "CreateIdempotent" (variant 1, no-op if it
  // already exists) — a freshly-derived agent address has no token account
  // yet, so the destination ATA must be created before it can receive SPL
  // tokens. Idempotent so this never fails on an already-funded destination.
  const createAtaIx = {
    programId: SOLANA_ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payerPubkey, isSigner: true, isWritable: true },
      { pubkey: destAta, isSigner: false, isWritable: true },
      { pubkey: params.to, isSigner: false, isWritable: false },
      { pubkey: cfg.tokenMint, isSigner: false, isWritable: false },
      { pubkey: SOLANA_SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SOLANA_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: new Uint8Array([1]),
  };

  // SPL Token "Transfer" (variant 3): u8 tag + u64 LE amount.
  const transferData = new Uint8Array(9);
  transferData[0] = 3;
  writeU64LE(transferData, 1, amount);
  const transferIx = {
    programId: SOLANA_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: senderAta, isSigner: false, isWritable: true },
      { pubkey: destAta, isSigner: false, isWritable: true },
      { pubkey: payerPubkey, isSigner: true, isWritable: false },
    ],
    data: transferData,
  };

  const txHash = await buildAndSendTransaction(cfg.rpcUrl, payer, [
    createAtaIx,
    transferIx,
  ]);

  const after = await confirmDelivered({
    readBalance: readDest,
    before,
    amount,
    timeoutMs,
    pollIntervalMs: params.confirmPollIntervalMs,
    notDeliveredMessage: (delta) =>
      `Solana token transfer ${txHash} confirmed on-chain, but ${destAta}'s balance only rose by ` +
      `${delta} base units (expected ${amount}) within the wait window (connector#691 shape).`,
  });
  return buildResult('solana', 'token', params.to, amount, txHash, before, after);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Send `params.amount` base units of `params.asset` to `params.to` on
 * `params.chain`, using whichever chain config in `config` matches. Confirms
 * delivery by re-reading the destination's balance (see module docs) rather
 * than trusting the send call's own success signal.
 *
 * @throws {UnknownChainError} `params.chain` is unrecognized, or this client
 *   has no configuration for it.
 * @throws {InvalidAddressError} `params.to` is malformed for the chain.
 * @throws {InsufficientBalanceError} the sender cannot cover the amount
 *   (plus fees, where applicable) — checked before anything is submitted.
 * @throws {TransferNotDeliveredError} the send was accepted (a landed,
 *   non-reverted transaction / a node-accepted payment) but the destination
 *   balance never reflected it within the wait window.
 * @throws {TransferUnsupportedError} this chain/asset combination has no
 *   configuration on this client — an `asset: 'token'` send with no token
 *   address or mint given for the chain.
 */
export async function sendTransfer(
  config: TransferConfig,
  params: SendTransferParams
): Promise<SendTransferResult> {
  const amount =
    typeof params.amount === 'string' ? BigInt(params.amount) : params.amount;
  if (amount <= 0n) {
    throw new ValidationError('sendTransfer: amount must be positive.');
  }

  switch (params.chain) {
    case 'evm': {
      if (!config.evm) {
        throw new UnknownChainError(
          'sendTransfer: no EVM chain configured on this client (no RPC URL or no EVM key).'
        );
      }
      assertValidEvmAddress(params.to);
      return sendEvmTransfer(config.evm, params, amount);
    }
    case 'solana': {
      if (!config.solana) {
        throw new UnknownChainError(
          'sendTransfer: no Solana chain configured on this client (no RPC URL, or no Solana key ' +
            '— construct the client from a mnemonic or pass solanaSecretKey).'
        );
      }
      assertValidSolanaAddress(params.to);
      return sendSolanaTransfer(config.solana, params, amount);
    }
    default:
      throw new UnknownChainError(
        `sendTransfer: unknown chain "${String(params.chain)}". Supported: evm, solana.`
      );
  }
}
