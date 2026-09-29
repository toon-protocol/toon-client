/**
 * `client.channel` — the x402 `batch-settlement` channels this client pays a
 * connector from (connector ADRs 0074, 0075): listing them, opening and topping
 * one up by hand, and leaving them.
 *
 * Paying needs nothing from here: `send()` onboards and vouchers on its own
 * unless `autoOpenChannel` is off. Exit is always by hand: it is the payer's
 * own transaction on its own chain account, the one step of the scheme that
 * costs native gas.
 *
 * Exit walks EVERY channel this client holds with the node, not only the one it
 * pays from now: a channel archived by a newer one — replaced when exhausted,
 * or left behind by a lost binding — still holds a deposit.
 */

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { NodeSelfDescription } from '../connector/self-description.js';
import type {
  BatchChannel,
  BatchChannelManager,
} from '../channel/batch-settlement/manager.js';
import type { BatchSettlementPayer } from '../channel/batch-settlement/payer.js';
import {
  evmChainIdOf,
  readEvmBatchChannel,
} from '../channel/batch-settlement/evm.js';
import { getSvmBatchChannel } from '../channel/batch-settlement/svm.js';
import { chooseBatchSettlement } from '../channel/batch-settlement/offers.js';
import {
  finalizeEvmBatchWithdraw,
  initiateEvmBatchWithdraw,
  requestSvmBatchClose,
  withdrawSvmBatchChannel,
  type EvmExitClients,
} from '../channel/batch-settlement/exit.js';
import {
  getLamports,
  type Signer,
  type SolanaRpcTarget,
} from '../channel/solana/payment-channel.js';
import { base58Encode } from '../utils/base58.js';
import { rpcTransport } from '../transport/rpc.js';
import {
  ChannelNotOpenError,
  ConfigError,
  InsufficientBalanceError,
} from './errors.js';
import type { ChainKind } from './types.js';

/** One batch-settlement channel, as this client records it. */
export interface BatchChannelSummary {
  channel: BatchChannel;
  depositTotal: bigint;
  /** The cumulative amount this client has signed on it. */
  signed: bigint;
  /** Unix seconds this client started leaving it. */
  closedAt?: bigint;
  /** Unix seconds its unspent deposit can be taken back. */
  settleableAt?: bigint;
  /** Unix seconds the unspent deposit came back. */
  settledAt?: bigint;
}

/** What one exit step did to one channel. */
export interface BatchExitResult {
  channelId: string;
  /** The transaction sent, when one was. A channel already done needs none. */
  transaction?: string;
  /** For a close: unix seconds its deposit can be taken back. */
  settleableAt?: bigint;
  /** Why this channel was left as it was. Other channels are still attempted. */
  error?: string;
}

export interface ChannelFacade {
  /** Every x402 channel this client holds with the connector, live or archived. */
  channels(): BatchChannelSummary[];
  /** The channel a paid `send()` would draw on now, or `undefined` before one is open. */
  current(): Promise<BatchChannelSummary | undefined>;
  /**
   * Open a channel now rather than on the first paid `send()` — a deposit
   * through the facilitator on Base, a sponsored open on Solana — or return
   * the one already open.
   */
  open(): Promise<BatchChannelSummary>;
  /** Deposit `amount` more into the Base channel this client pays from. */
  deposit(amount: bigint): Promise<BatchChannelSummary>;
  /**
   * Start leaving every channel still open with the node: on EVM a timed
   * withdrawal of everything unclaimed, on Solana `request_close`. The next
   * paid `send()` onboards a fresh channel.
   */
  close(): Promise<BatchExitResult[]>;
  /**
   * Take back the unspent deposit of every channel whose exit window has
   * passed — including a Solana channel the connector sealed first. Channels
   * still inside their window are left for a later call; one that fails does
   * not stop the rest.
   */
  settle(): Promise<BatchExitResult[]>;
}

export interface ChannelFacadeDeps {
  connector: string;
  payer: BatchSettlementPayer;
  chain: ChainKind;
  manager: BatchChannelManager;
  describe(): Promise<NodeSelfDescription>;
  evm?: { privateKey: Uint8Array; rpcUrl: string; rpcDispatcher: unknown };
  solana?: { signer: Signer; rpc: SolanaRpcTarget };
  now?: () => bigint;
}

export class ClientChannelFacade implements ChannelFacade {
  constructor(private readonly deps: ChannelFacadeDeps) {}

  channels(): BatchChannelSummary[] {
    return this.deps.manager.channels(this.deps.connector);
  }

  async current(): Promise<BatchChannelSummary | undefined> {
    const terms = chooseBatchSettlement(await this.deps.describe(), this.deps.chain);
    if (terms === undefined) return undefined;
    const channel = this.deps.manager.resolve(this.deps.connector, terms.network, terms.asset);
    if (channel === undefined || this.deps.manager.isClosing(channel.channelId)) return undefined;
    return this.summary(channel.channelId);
  }

  async open(): Promise<BatchChannelSummary> {
    const channel = await this.deps.payer.open(
      await this.deps.describe(),
      this.deps.chain
    );
    if (channel === undefined) {
      throw new ConfigError(
        `${this.deps.connector} offers no x402 channel on ${this.deps.chain}`
      );
    }
    return this.summary(channel.channelId);
  }

  async deposit(amount: bigint): Promise<BatchChannelSummary> {
    const channel = await this.deps.payer.topUp(
      await this.deps.describe(),
      this.deps.chain,
      amount
    );
    return this.summary(channel.channelId);
  }

  async close(): Promise<BatchExitResult[]> {
    const open = this.deps.manager.openChannels(this.deps.connector);
    if (open.length === 0) {
      throw new ChannelNotOpenError(
        `this client holds no open channel with ${this.deps.connector}`
      );
    }
    const results: BatchExitResult[] = [];
    for (const channel of open) {
      results.push(
        await this.attempt(channel.channelId, () => this.closeOne(channel))
      );
    }
    return results;
  }

  async settle(): Promise<BatchExitResult[]> {
    const now = this.now();
    const results: BatchExitResult[] = [];
    for (const summary of this.channels()) {
      if (summary.settledAt !== undefined) continue;
      const due =
        summary.settleableAt !== undefined && summary.settleableAt <= now;
      // A Solana channel the connector sealed first is settleable with no
      // close of ours; an EVM one never is.
      if (!due && summary.channel.chain !== 'solana') continue;
      const result = await this.attempt(summary.channel.channelId, () =>
        this.settleOne(summary, due, now)
      );
      if (result !== undefined) results.push(result);
    }
    return results;
  }

  private async closeOne(channel: BatchChannel): Promise<BatchExitResult> {
    const now = this.now();
    const manager = this.deps.manager;
    if (channel.chain === 'evm') {
      const clients = this.evmClients(channel.network);
      const state = await readEvmBatchChannel(
        clients.publicClient,
        channel.channelId as Hex
      );
      if (
        state.balance <= state.totalClaimed &&
        state.pendingWithdrawal === 0n
      ) {
        // Nothing left to take back: everything deposited was claimed.
        manager.markClosing(channel.channelId, now, now);
        manager.markSettled(channel.channelId, now);
        return { channelId: channel.channelId };
      }
      await requireGas('ETH', clients.address, clients.nativeBalance(), 'close');
      const started = await initiateEvmBatchWithdraw(clients, channel);
      manager.markClosing(channel.channelId, now, started.finalizeAfter);
      return {
        channelId: channel.channelId,
        transaction: started.transaction,
        settleableAt: started.finalizeAfter,
      };
    }
    const solana = this.requireSolana();
    const state = await getSvmBatchChannel(solana.rpc, channel.channelId);
    if (
      state === null ||
      state.payerWithdrawnAt !== 0n ||
      state.status === 'distributed'
    ) {
      manager.markClosing(channel.channelId, now, now);
      manager.markSettled(channel.channelId, now);
      return { channelId: channel.channelId };
    }
    if (state.status !== 'open') {
      // Already closing or sealed — by the connector, or by an earlier run.
      const settleableAt =
        state.status === 'sealed'
          ? now
          : state.closureStartedAt + BigInt(state.gracePeriod);
      manager.markClosing(channel.channelId, now, settleableAt);
      return { channelId: channel.channelId, settleableAt };
    }
    await requireGas(
      'SOL',
      base58Encode(solana.signer.publicKey),
      getLamports(solana.rpc, base58Encode(solana.signer.publicKey)),
      'close'
    );
    const started = await requestSvmBatchClose(
      solana.rpc,
      solana.signer,
      channel.channelId
    );
    manager.markClosing(channel.channelId, now, started.settleableAt);
    return {
      channelId: channel.channelId,
      transaction: started.transaction,
      settleableAt: started.settleableAt,
    };
  }

  /** `undefined` when there is nothing to do yet for this channel. */
  private async settleOne(
    summary: BatchChannelSummary,
    due: boolean,
    now: bigint
  ): Promise<BatchExitResult | undefined> {
    const { channel } = summary;
    const manager = this.deps.manager;
    if (channel.chain === 'evm') {
      const clients = this.evmClients(channel.network);
      const state = await readEvmBatchChannel(
        clients.publicClient,
        channel.channelId as Hex
      );
      if (
        state.pendingWithdrawal === 0n &&
        state.balance <= state.totalClaimed
      ) {
        manager.markSettled(channel.channelId, now);
        return { channelId: channel.channelId };
      }
      await requireGas('ETH', clients.address, clients.nativeBalance(), 'settle');
      const { transaction } = await finalizeEvmBatchWithdraw(
        clients,
        channel,
        now
      );
      manager.markSettled(channel.channelId, now);
      return { channelId: channel.channelId, transaction };
    }

    const solana = this.requireSolana();
    const state = await getSvmBatchChannel(solana.rpc, channel.channelId);
    // Gone, or already refunded — `distribute` pays the payer too — is done.
    if (
      state === null ||
      state.payerWithdrawnAt !== 0n ||
      state.status === 'distributed'
    ) {
      if (summary.closedAt === undefined)
        manager.markClosing(channel.channelId, now, now);
      manager.markSettled(channel.channelId, now);
      return { channelId: channel.channelId };
    }
    const sealedByConnector = state.status === 'sealed';
    if (!due && !sealedByConnector) return undefined;
    await requireGas(
      'SOL',
      base58Encode(solana.signer.publicKey),
      getLamports(solana.rpc, base58Encode(solana.signer.publicKey)),
      'settle'
    );
    const { transaction } = await withdrawSvmBatchChannel(
      solana.rpc,
      solana.signer,
      channel.channelId,
      channel.config,
      now
    );
    if (summary.closedAt === undefined)
      manager.markClosing(channel.channelId, now, now);
    manager.markSettled(channel.channelId, now);
    return { channelId: channel.channelId, transaction };
  }

  /** Run one channel's step, turning a failure into that channel's result. */
  private async attempt<T extends BatchExitResult | undefined>(
    channelId: string,
    step: () => Promise<T>
  ): Promise<T | BatchExitResult> {
    try {
      return await step();
    } catch (err) {
      return {
        channelId,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private summary(channelId: string): BatchChannelSummary {
    const found = this.channels().find(
      (c) => c.channel.channelId === channelId
    );
    if (found === undefined)
      throw new Error(`channel ${channelId} is not recorded`);
    return found;
  }

  private evmClients(network: string): EvmExitClients & {
    address: string;
    nativeBalance(): Promise<bigint>;
  } {
    const evm = this.deps.evm;
    if (!evm) {
      throw new ConfigError(
        'leaving a Base batch-settlement channel needs this client’s EVM key'
      );
    }
    const chain = defineChain({
      id: evmChainIdOf(network),
      name: network,
      nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [evm.rpcUrl] } },
    });
    const account = privateKeyToAccount(toHexKey(evm.privateKey));
    const transport = rpcTransport(evm.rpcUrl, evm.rpcDispatcher);
    const publicClient = createPublicClient({ chain, transport });
    const walletClient = createWalletClient({ account, chain, transport });
    return {
      publicClient: publicClient as unknown as EvmExitClients['publicClient'],
      walletClient: walletClient as unknown as EvmExitClients['walletClient'],
      address: account.address,
      nativeBalance: () => publicClient.getBalance({ address: account.address }),
    };
  }

  private requireSolana(): { signer: Signer; rpc: SolanaRpcTarget } {
    if (!this.deps.solana) {
      throw new ConfigError(
        'leaving a Solana batch-settlement channel needs this client’s Solana key'
      );
    }
    return this.deps.solana;
  }

  private now(): bigint {
    return this.deps.now?.() ?? BigInt(Math.floor(Date.now() / 1000));
  }
}

/**
 * Leaving is the one step of the scheme that costs native gas, and a payer that
 * onboarded gaslessly may well hold none. Say so plainly, before a transaction
 * is built, rather than let the node's "gas required exceeds allowance" stand
 * in for the reason.
 */
async function requireGas(
  gas: 'ETH' | 'SOL',
  address: string,
  balance: Promise<bigint>,
  step: 'close' | 'settle'
): Promise<void> {
  if ((await balance) > 0n) return;
  throw new InsufficientBalanceError(
    `leaving a channel needs ${gas} for the fee, and ${address} holds none. Opening and ` +
      `paying never did, so a wallet funded only with USDC has none yet: send it a little ` +
      `${gas}, then run ${step} again.`
  );
}

function toHexKey(key: Uint8Array): Hex {
  return `0x${Buffer.from(key).toString('hex')}`;
}
