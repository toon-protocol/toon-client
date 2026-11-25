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
 * Leaving a channel is its settlement network's to do: this facade walks the
 * channels and records what each network answered, and never asks which chain
 * a channel is on.
 *
 * Exit walks EVERY channel this client holds with the node, not only the one it
 * pays from now: a channel archived by a newer one — replaced when exhausted,
 * or left behind by a lost binding — still holds a deposit.
 */

import type { NodeSelfDescription } from '../connector/self-description.js';
import type {
  BatchChannel,
  BatchChannelManager,
} from '../channel/batch-settlement/manager.js';
import type { BatchSettlementPayer } from '../channel/batch-settlement/payer.js';
import { chooseBatchSettlement } from '../channel/batch-settlement/offers.js';
import {
  settlementNetworkFor,
  type SettlementNetwork,
} from '../channel/batch-settlement/settlement-network.js';
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
  /** The settlement networks this client holds a key for, which leave its channels. */
  networks: readonly SettlementNetwork[];
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
      const network = settlementNetworkFor(
        this.deps.networks,
        summary.channel.network
      );
      // Nothing is due, and no network here can say otherwise.
      if (!due && network === undefined) continue;
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
    const outcome = await this.networkOf(channel).close(channel, now);
    if (outcome.kind === 'done') {
      // Nothing left on chain to take back.
      manager.markClosing(channel.channelId, now, now);
      manager.markSettled(channel.channelId, now);
      return { channelId: channel.channelId };
    }
    manager.markClosing(channel.channelId, now, outcome.settleableAt);
    return {
      channelId: channel.channelId,
      ...(outcome.transaction !== undefined
        ? { transaction: outcome.transaction }
        : {}),
      settleableAt: outcome.settleableAt,
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
    const outcome = await this.networkOf(channel).settle(channel, { due, now });
    if (outcome.kind === 'not-yet') return undefined;
    // A channel settled with no close of ours (sealed by the connector, or
    // gone) is recorded as closed now.
    if (summary.closedAt === undefined)
      manager.markClosing(channel.channelId, now, now);
    manager.markSettled(channel.channelId, now);
    return {
      channelId: channel.channelId,
      ...(outcome.transaction !== undefined
        ? { transaction: outcome.transaction }
        : {}),
    };
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

  /** The settlement network that leaves `channel`, or a refusal naming its network. */
  private networkOf(channel: BatchChannel): SettlementNetwork {
    const network = settlementNetworkFor(this.deps.networks, channel.network);
    if (network === undefined) {
      throw new ConfigError(
        `this client holds no key to leave a batch-settlement channel on ${channel.network}`
      );
    }
    return network;
  }

  private now(): bigint {
    return this.deps.now?.() ?? BigInt(Math.floor(Date.now() / 1000));
  }
}
