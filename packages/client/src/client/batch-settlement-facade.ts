/**
 * `client.batchSettlement` — leaving the x402 `batch-settlement` channels this
 * client pays from (connector ADR 0074, toon-client#691), and seeing them.
 *
 * Paying needs nothing from here: `send()` onboards and vouchers on its own.
 * What a caller does by hand is exit, which is the payer's own transaction on
 * its own chain account and the one step of the scheme that costs native gas.
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
import { chooseBatchSettlement } from '../channel/batch-settlement/offers.js';
import { evmChainIdOf } from '../channel/batch-settlement/evm.js';
import {
  finalizeEvmBatchWithdraw,
  initiateEvmBatchWithdraw,
  requestSvmBatchClose,
  withdrawSvmBatchChannel,
  type EvmExitClients,
} from '../channel/batch-settlement/exit.js';
import type {
  Signer,
  SolanaRpcTarget,
} from '../channel/solana/payment-channel.js';
import { rpcTransport } from '../transport/rpc.js';
import { ChannelNotOpenError, ConfigError } from './errors.js';
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

export interface BatchSettlementFacade {
  /** Every batch-settlement channel this client holds with the connector. */
  channels(): BatchChannelSummary[];
  /**
   * Open a channel now rather than on the first paid `send()`: a deposit
   * through the facilitator on Base, a sponsored open on Solana.
   */
  open(): Promise<BatchChannelSummary>;
  /**
   * Start leaving the channel this client currently pays from: on EVM a timed
   * withdrawal of everything unclaimed, on Solana `request_close`. The next
   * paid `send()` onboards a fresh channel.
   */
  close(): Promise<{
    channelId: string;
    transaction: string;
    settleableAt: bigint;
  }>;
  /**
   * Take back the unspent deposit of every channel whose exit window has
   * passed. Channels still inside it are left for a later call.
   */
  settle(): Promise<{ channelId: string; transaction: string }[]>;
}

export interface BatchSettlementFacadeDeps {
  connector: string;
  payer: BatchSettlementPayer;
  chain: ChainKind;
  manager: BatchChannelManager;
  describe(): Promise<NodeSelfDescription>;
  evm?: { privateKey: Uint8Array; rpcUrl: string; rpcDispatcher: unknown };
  solana?: { signer: Signer; rpc: SolanaRpcTarget };
  now?: () => bigint;
}

export class ClientBatchSettlementFacade implements BatchSettlementFacade {
  constructor(private readonly deps: BatchSettlementFacadeDeps) {}

  channels(): BatchChannelSummary[] {
    return this.deps.manager.channels(this.deps.connector);
  }

  async open(): Promise<BatchChannelSummary> {
    const channel = await this.deps.payer.open(
      await this.deps.describe(),
      this.deps.chain
    );
    if (channel === undefined) {
      throw new ConfigError(
        `${this.deps.connector} offers no batch-settlement channel on ${this.deps.chain}`
      );
    }
    const summary = this.channels().find(
      (c) => c.channel.channelId === channel.channelId
    );
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- `open` adopted it
    return summary!;
  }

  async close(): Promise<{
    channelId: string;
    transaction: string;
    settleableAt: bigint;
  }> {
    const terms = chooseBatchSettlement(
      await this.deps.describe(),
      this.deps.chain
    );
    const channel =
      terms &&
      this.deps.manager.resolve(
        this.deps.connector,
        terms.network,
        terms.asset
      );
    if (!channel || this.deps.manager.isClosing(channel.channelId)) {
      throw new ChannelNotOpenError(
        `this client pays ${this.deps.connector} from no open batch-settlement channel on ${this.deps.chain}`
      );
    }
    const now = this.now();
    if (channel.chain === 'evm') {
      const started = await initiateEvmBatchWithdraw(
        this.evmClients(channel.network),
        channel
      );
      this.deps.manager.markClosing(
        channel.channelId,
        now,
        started.finalizeAfter
      );
      return {
        channelId: channel.channelId,
        transaction: started.transaction,
        settleableAt: started.finalizeAfter,
      };
    }
    const solana = this.requireSolana();
    const started = await requestSvmBatchClose(
      solana.rpc,
      solana.signer,
      channel.channelId
    );
    this.deps.manager.markClosing(channel.channelId, now, started.settleableAt);
    return {
      channelId: channel.channelId,
      transaction: started.transaction,
      settleableAt: started.settleableAt,
    };
  }

  async settle(): Promise<{ channelId: string; transaction: string }[]> {
    const now = this.now();
    const due = this.channels().filter(
      (c) =>
        c.closedAt !== undefined &&
        c.settledAt === undefined &&
        c.settleableAt !== undefined &&
        c.settleableAt <= now
    );
    const settled: { channelId: string; transaction: string }[] = [];
    for (const { channel } of due) {
      const transaction =
        channel.chain === 'evm'
          ? (
              await finalizeEvmBatchWithdraw(
                this.evmClients(channel.network),
                channel,
                now
              )
            ).transaction
          : (
              await withdrawSvmBatchChannel(
                this.requireSolana().rpc,
                this.requireSolana().signer,
                channel.channelId,
                channel.config,
                now
              )
            ).transaction;
      this.deps.manager.markSettled(channel.channelId, now);
      settled.push({ channelId: channel.channelId, transaction });
    }
    return settled;
  }

  private evmClients(network: string): EvmExitClients {
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

function toHexKey(key: Uint8Array): Hex {
  return `0x${Buffer.from(key).toString('hex')}`;
}
