/**
 * Leaving an x402 `batch-settlement` channel, and getting the unspent deposit
 * back (connector ADR 0074, toon-client#691).
 *
 * A connector only ever receives on these channels: it never refunds
 * cooperatively, so both exits are the payer's own, unilateral, and cost the
 * payer native gas — the one step of this scheme that does. Both give the
 * connector a window to land its latest voucher first, and it watches for
 * exactly that (decision 5).
 *
 *   - **EVM** (`x402BatchSettlement.sol`): `initiateWithdraw(config, amount)`
 *     by the payer or its `payerAuthorizer`, then after `withdrawDelay`
 *     `finalizeWithdraw(config)`, which pays out what is still unclaimed.
 *   - **Solana** (payment-channels): `request_close` by the payer moves the
 *     channel to Closing; after `grace_period` anyone may `seal` it, and
 *     `withdraw_payer` returns `deposit − settled` to the payer's token account.
 */

import type { Hex, TransactionReceipt } from 'viem';
import { ValidationError } from '../../client/errors.js';
import {
  X402_BATCH_SETTLEMENT_ADDRESS,
  readEvmBatchChannel,
  type BatchChannelConfig,
  type ContractReader,
} from './evm.js';
import {
  PAYMENT_CHANNELS_PROGRAM_ID,
  getSvmBatchChannel,
  type SvmBatchChannelConfig,
} from './svm.js';
import {
  buildAndSendTransaction,
  deriveAssociatedTokenAccount,
  type RawInstruction,
  type Signer,
  type SolanaRpcTarget,
} from '../solana/payment-channel.js';
import { base58Encode } from '../../utils/base58.js';

const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const IX_REQUEST_CLOSE = 5;
const IX_SEAL = 6;
const IX_WITHDRAW_PAYER = 8;

const CHANNEL_CONFIG_TUPLE = {
  name: 'config',
  type: 'tuple',
  components: [
    { name: 'payer', type: 'address' },
    { name: 'payerAuthorizer', type: 'address' },
    { name: 'receiver', type: 'address' },
    { name: 'receiverAuthorizer', type: 'address' },
    { name: 'token', type: 'address' },
    { name: 'withdrawDelay', type: 'uint40' },
    { name: 'salt', type: 'bytes32' },
  ],
} as const;

/** `initiateWithdraw` and `finalizeWithdraw`. */
export const X402_BATCH_SETTLEMENT_EXIT_ABI = [
  {
    type: 'function',
    name: 'initiateWithdraw',
    stateMutability: 'nonpayable',
    inputs: [CHANNEL_CONFIG_TUPLE, { name: 'amount', type: 'uint128' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'finalizeWithdraw',
    stateMutability: 'nonpayable',
    inputs: [CHANNEL_CONFIG_TUPLE],
    outputs: [],
  },
] as const;

/** The viem clients an EVM exit needs: one to write, one to read and wait. */
export interface EvmExitClients {
  publicClient: ContractReader & {
    waitForTransactionReceipt: (params: {
      hash: Hex;
    }) => Promise<TransactionReceipt>;
  };
  walletClient: { writeContract: (params: never) => Promise<Hex> };
}

// ---------------------------------------------------------------------------
// EVM
// ---------------------------------------------------------------------------

/**
 * Start a timed withdrawal of everything the connector has not claimed. The
 * connector sees `WithdrawInitiated` and claims its latest voucher before the
 * delay ends, so what finally comes back is the deposit less what was spent.
 */
export async function initiateEvmBatchWithdraw(
  clients: EvmExitClients,
  channel: { channelId: string; config: BatchChannelConfig }
): Promise<{ transaction: Hex; amount: bigint; finalizeAfter: bigint }> {
  const state = await readEvmBatchChannel(
    clients.publicClient,
    channel.channelId as Hex
  );
  if (state.pendingWithdrawal > 0n) {
    throw new ValidationError(
      `channel ${channel.channelId} already has a withdrawal of ${state.pendingWithdrawal} pending`
    );
  }
  const amount = state.balance - state.totalClaimed;
  if (amount <= 0n) {
    throw new ValidationError(
      `channel ${channel.channelId} holds nothing unclaimed to withdraw`
    );
  }
  const transaction = await clients.walletClient.writeContract({
    address: X402_BATCH_SETTLEMENT_ADDRESS,
    abi: X402_BATCH_SETTLEMENT_EXIT_ABI,
    functionName: 'initiateWithdraw',
    args: [channelConfigArg(channel.config), amount],
  } as never);
  assertSucceeded(
    await clients.publicClient.waitForTransactionReceipt({ hash: transaction }),
    'initiateWithdraw'
  );
  // The chain's own start time, not this machine's clock.
  const started = await readEvmBatchChannel(
    clients.publicClient,
    channel.channelId as Hex
  );
  return {
    transaction,
    amount,
    finalizeAfter:
      BigInt(started.withdrawalInitiatedAt) +
      BigInt(channel.config.withdrawDelay),
  };
}

/** Finish a timed withdrawal once `withdrawDelay` has passed. */
export async function finalizeEvmBatchWithdraw(
  clients: EvmExitClients,
  channel: { channelId: string; config: BatchChannelConfig },
  now = BigInt(Math.floor(Date.now() / 1000))
): Promise<{ transaction: Hex }> {
  const state = await readEvmBatchChannel(
    clients.publicClient,
    channel.channelId as Hex
  );
  if (state.withdrawalInitiatedAt === 0) {
    throw new ValidationError(
      `channel ${channel.channelId} has no withdrawal pending`
    );
  }
  const finalizeAfter = BigInt(
    state.withdrawalInitiatedAt + channel.config.withdrawDelay
  );
  if (now < finalizeAfter) {
    throw new ValidationError(
      `channel ${channel.channelId}'s withdrawal can be finalized at ${finalizeAfter} (unix seconds), not yet`
    );
  }
  const transaction = await clients.walletClient.writeContract({
    address: X402_BATCH_SETTLEMENT_ADDRESS,
    abi: X402_BATCH_SETTLEMENT_EXIT_ABI,
    functionName: 'finalizeWithdraw',
    args: [channelConfigArg(channel.config)],
  } as never);
  assertSucceeded(
    await clients.publicClient.waitForTransactionReceipt({ hash: transaction }),
    'finalizeWithdraw'
  );
  return { transaction };
}

function channelConfigArg(config: BatchChannelConfig) {
  return {
    payer: config.payer as Hex,
    payerAuthorizer: config.payerAuthorizer as Hex,
    receiver: config.receiver as Hex,
    receiverAuthorizer: config.receiverAuthorizer as Hex,
    token: config.token as Hex,
    withdrawDelay: config.withdrawDelay,
    salt: config.salt,
  };
}

function assertSucceeded(receipt: TransactionReceipt, what: string): void {
  if (receipt.status !== 'success') {
    throw new ValidationError(`${what} reverted in ${receipt.transactionHash}`);
  }
}

// ---------------------------------------------------------------------------
// Solana
// ---------------------------------------------------------------------------

/** `request_close` (5): the payer starts the grace period. */
export function buildSvmRequestCloseInstruction(
  channelId: string,
  payer: string
): RawInstruction {
  return {
    programId: PAYMENT_CHANNELS_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: false },
      { pubkey: channelId, isSigner: false, isWritable: true },
    ],
    data: new Uint8Array([IX_REQUEST_CLOSE]),
  };
}

/** `seal` (6): permissionless, once the grace period has elapsed. */
export function buildSvmSealInstruction(channelId: string): RawInstruction {
  return {
    programId: PAYMENT_CHANNELS_PROGRAM_ID,
    keys: [{ pubkey: channelId, isSigner: false, isWritable: true }],
    data: new Uint8Array([IX_SEAL]),
  };
}

/** `withdraw_payer` (8): `deposit − settled` back to the payer, from a Sealed channel. */
export function buildSvmWithdrawPayerInstruction(
  channelId: string,
  config: Pick<SvmBatchChannelConfig, 'payer' | 'token'>
): RawInstruction {
  return {
    programId: PAYMENT_CHANNELS_PROGRAM_ID,
    keys: [
      { pubkey: config.payer, isSigner: true, isWritable: false },
      { pubkey: channelId, isSigner: false, isWritable: true },
      {
        pubkey: deriveAssociatedTokenAccount(channelId, config.token),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: deriveAssociatedTokenAccount(config.payer, config.token),
        isSigner: false,
        isWritable: true,
      },
      { pubkey: config.token, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: new Uint8Array([IX_WITHDRAW_PAYER]),
  };
}

/**
 * The payer's `request_close`. From here the channel accepts no new voucher,
 * and the connector lands its latest one with `settle_and_seal` before the
 * grace period ends.
 */
export async function requestSvmBatchClose(
  rpc: SolanaRpcTarget,
  payer: Signer,
  channelId: string
): Promise<{ transaction: string; settleableAt: bigint }> {
  const state = await getSvmBatchChannel(rpc, channelId);
  if (state === null)
    throw new ValidationError(`channel ${channelId} does not exist`);
  if (state.status !== 'open') {
    throw new ValidationError(
      `channel ${channelId} is ${state.status}, not open`
    );
  }
  const transaction = await buildAndSendTransaction(rpc, payer, [
    buildSvmRequestCloseInstruction(channelId, base58Encode(payer.publicKey)),
  ]);
  return {
    transaction,
    settleableAt:
      BigInt(Math.floor(Date.now() / 1000)) + BigInt(state.gracePeriod),
  };
}

/**
 * Take the unspent deposit back: `seal` a Closing channel whose grace period
 * has passed (unless the connector already sealed it), then `withdraw_payer`,
 * in one transaction.
 */
export async function withdrawSvmBatchChannel(
  rpc: SolanaRpcTarget,
  payer: Signer,
  channelId: string,
  config: Pick<SvmBatchChannelConfig, 'payer' | 'token'>,
  now = BigInt(Math.floor(Date.now() / 1000))
): Promise<{ transaction: string }> {
  const state = await getSvmBatchChannel(rpc, channelId);
  if (state === null)
    throw new ValidationError(`channel ${channelId} does not exist`);
  if (state.payerWithdrawnAt !== 0n) {
    throw new ValidationError(
      `channel ${channelId}'s deposit was already withdrawn`
    );
  }
  const instructions: RawInstruction[] = [];
  if (state.status === 'closing') {
    const deadline = state.closureStartedAt + BigInt(state.gracePeriod);
    if (now < deadline) {
      throw new ValidationError(
        `channel ${channelId} can be sealed at ${deadline} (unix seconds), not yet`
      );
    }
    instructions.push(buildSvmSealInstruction(channelId));
  } else if (state.status !== 'sealed') {
    throw new ValidationError(
      `channel ${channelId} is ${state.status}; request its close first`
    );
  }
  instructions.push(buildSvmWithdrawPayerInstruction(channelId, config));
  return {
    transaction: await buildAndSendTransaction(rpc, payer, instructions),
  };
}
