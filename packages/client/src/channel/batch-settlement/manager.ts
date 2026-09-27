/**
 * The watermark and the config of this client's x402 `batch-settlement`
 * channels (connector ADR 0074, toon-client#688), persisted in the same
 * {@link ChannelStore} as its `toon-channel` ones.
 *
 * It is not {@link ../ChannelManager.js!ChannelManager}, because a voucher is
 * not a balance proof:
 *
 *   - **There is no nonce.** The connector orders vouchers by amount alone and
 *     accepts one only if it strictly exceeds the channel's watermark by at
 *     least the charge, so the one number to keep is the cumulative amount.
 *   - **Nothing is derived.** The channel id travels in every voucher, so the
 *     whole config is what must survive a restart: on EVM the contract stores a
 *     channel by id and never gives the config back.
 *   - **More than one channel to one connector is legal** (decision 2), so a
 *     newer channel on the same connector, network and asset retires the older
 *     binding into the archive rather than overwriting it — whatever that
 *     channel still holds on chain stays findable.
 *
 * ## Resynchronization
 *
 * `POST /ilp/claim-state` does not answer for a voucher channel (the connector
 * resolves it only against `TokenNetwork` and TOON-program channels), and a
 * voucher refusal does not carry the connector's watermark. So there is no
 * connector figure to adopt, and the rules are built so that none is needed:
 *
 *   - the amount is persisted BEFORE a voucher is signed, so a crash never
 *     re-signs below something already handed out;
 *   - a voucher whose fate is unknown stays counted, so the next one exceeds it
 *     whether or not it arrived — at the cost of at most one charge if it did
 *     not;
 *   - only a definite refusal gives a charge back, and `amount_not_advancing`
 *     is not one: it says the connector already holds at least that amount;
 *   - a lost store is recovered, as a LOWER bound, from what the chain has
 *     landed ({@link BatchChannelManager.recoverFromChain}).
 */

import type { Hex } from 'viem';
import type {
  BatchSettlementBinding,
  ChannelStore,
  ChannelStoreEntry,
} from '../ChannelStore.js';
import { InMemoryChannelStore } from '../ChannelStore.js';
import type { BatchChannelConfig } from './evm.js';
import { evmChainIdOf, X402_BATCH_SETTLEMENT_ADDRESS } from './evm.js';
import type { SvmBatchChannelConfig } from './svm.js';
import { PAYMENT_CHANNELS_PROGRAM_ID } from './svm.js';
import { nextVoucherAmount } from './claim.js';
import { ValidationError } from '../../client/errors.js';

/** One batch-settlement channel this client holds. */
export type BatchChannel =
  | {
      chain: 'evm';
      channelId: string;
      network: string;
      config: BatchChannelConfig;
    }
  | {
      chain: 'solana';
      channelId: string;
      network: string;
      /** The receiving connector's sponsor key. */
      sponsor: string;
      config: SvmBatchChannelConfig;
    };

const KEY_PREFIX = 'batch|';

export class BatchChannelManager {
  private readonly store: ChannelStore;

  constructor(store: ChannelStore = new InMemoryChannelStore()) {
    this.store = store;
  }

  /** Where the binding for `connector`'s channel on `network` in `asset` lives. */
  static bindingKey(connector: string, network: string, asset: string): string {
    // EVM addresses are case-insensitive, base58 is not.
    const a = network.startsWith('eip155:') ? asset.toLowerCase() : asset;
    return `${KEY_PREFIX}${connector}|${network}|${a}`;
  }

  /**
   * Record a channel this client just opened or deposited into (and so owns),
   * with the deposit it holds. A new channel starts at a watermark of zero; a
   * channel already known keeps its own.
   */
  adopt(connector: string, channel: BatchChannel, depositTotal: bigint): void {
    this.bind(connector, channel, { depositTotal });
  }

  /**
   * Record a channel BEFORE its first deposit or sponsored open leaves, with
   * that deposit pending. A facilitator or sponsor that times out after the
   * transaction landed must not lose the channel: on EVM the contract never
   * gives a config back, and a Solana PDA cannot be recomputed without its
   * salt and slot. {@link confirmDeposit} or {@link abandon} settles it.
   */
  adoptPending(
    connector: string,
    channel: BatchChannel,
    pendingDeposit: bigint
  ): void {
    this.bind(connector, channel, { depositTotal: 0n, pendingDeposit });
  }

  private bind(
    connector: string,
    channel: BatchChannel,
    deposit: { depositTotal: bigint; pendingDeposit?: bigint }
  ): void {
    const key = BatchChannelManager.bindingKey(
      connector,
      channel.network,
      channel.config.token
    );
    const existing = this.store.loadBinding?.(key);
    if (existing && existing.channelId !== channel.channelId) {
      this.store.supersedeBinding?.(key);
    }
    this.store.saveBinding?.(key, {
      channelId: channel.channelId,
      context: {
        chainType: channel.chain,
        chainId: channel.chain === 'evm' ? evmChainIdOf(channel.network) : 0,
        tokenNetworkAddress:
          channel.chain === 'evm'
            ? X402_BATCH_SETTLEMENT_ADDRESS
            : PAYMENT_CHANNELS_PROGRAM_ID,
        tokenAddress: channel.config.token,
        recipient: channel.config.receiver,
      },
      depositTotal: deposit.depositTotal,
      ...(deposit.pendingDeposit !== undefined
        ? { pendingDeposit: deposit.pendingDeposit }
        : {}),
      batchSettlement: toBinding(channel),
    });
    if (!this.store.load(channel.channelId)) {
      this.store.save(channel.channelId, {
        nonce: 0,
        cumulativeAmount: 0n,
        signedCeiling: 0n,
      });
    }
  }

  /** A deposit on `channelId` whose fate is not yet known, if there is one. */
  pendingDeposit(channelId: string): bigint | undefined {
    return this.findBinding(channelId)?.binding.pendingDeposit;
  }

  /** Record a top-up about to leave, before it does. */
  setPendingDeposit(channelId: string, amount: bigint): void {
    const found = this.requireBinding(channelId);
    this.store.saveBinding?.(found.key, {
      ...found.binding,
      pendingDeposit: amount,
    });
  }

  /**
   * Settle a pending deposit against what the chain holds: `onChain` is the
   * channel's escrow as the chain reports it (EVM `channels(id).balance`,
   * Solana `deposit`), which is the deposit from here on.
   */
  confirmDeposit(channelId: string, onChain: bigint): void {
    const found = this.requireBinding(channelId);
    const { pendingDeposit: _settled, ...rest } = found.binding;
    this.store.saveBinding?.(found.key, { ...rest, depositTotal: onChain });
  }

  /**
   * Forget a channel whose first deposit definitely did not land: nothing is
   * on chain under it, so there is nothing to keep.
   */
  abandon(channelId: string): void {
    const found = this.findBinding(channelId);
    if (!found || (found.binding.depositTotal ?? 0n) > 0n) return;
    this.store.deleteBinding?.(found.key);
    this.store.delete(channelId);
  }

  /** The channel this client pays `connector` from on `network` in `asset`, if it holds one. */
  resolve(
    connector: string,
    network: string,
    asset: string
  ): BatchChannel | undefined {
    const binding = this.store.loadBinding?.(
      BatchChannelManager.bindingKey(connector, network, asset)
    );
    if (!binding?.batchSettlement) return undefined;
    return fromBinding(binding.channelId, binding.batchSettlement);
  }

  /** The deposit recorded for `channelId`. */
  depositTotal(channelId: string): bigint {
    return this.findBinding(channelId)?.binding.depositTotal ?? 0n;
  }

  /** Record a top-up of `amount` on `channelId`. */
  addDeposit(channelId: string, amount: bigint): void {
    const found = this.requireBinding(channelId);
    this.store.saveBinding?.(found.key, {
      ...found.binding,
      depositTotal: (found.binding.depositTotal ?? 0n) + amount,
    });
  }

  /** The cumulative amount this client counts as signed on `channelId`. */
  signedSoFar(channelId: string): bigint {
    return this.entry(channelId).cumulativeAmount;
  }

  /**
   * Reserve the next voucher on `channelId` for a packet charging `charge`, and
   * persist it before anything is signed. Returns the cumulative amount to sign,
   * or `undefined` when the packet should carry no voucher (a free route).
   *
   * @throws {ValidationError} when the channel's deposit cannot cover it — the
   *   connector would refuse it, so the caller tops up first.
   */
  reserve(channelId: string, charge: bigint): bigint | undefined {
    const entry = this.entry(channelId);
    const amount = nextVoucherAmount(entry.cumulativeAmount, charge);
    if (amount === undefined) return undefined;
    const deposit = this.depositTotal(channelId);
    if (amount > deposit) {
      throw new ValidationError(
        `a voucher for ${amount} exceeds channel ${channelId}'s deposit of ${deposit}; top it up first`
      );
    }
    this.store.save(channelId, {
      ...entry,
      cumulativeAmount: amount,
      signedCeiling:
        entry.signedCeiling === undefined || amount > entry.signedCeiling
          ? amount
          : entry.signedCeiling,
    });
    return amount;
  }

  /**
   * The connector refused the voucher for `voucherAmount`, reserved for
   * `charge`. What the refusal says about the connector's watermark decides:
   *
   *   - **it named the watermark** — an underpayment says how far the voucher
   *     advanced it, so the watermark is `voucherAmount − advanced`. That is
   *     adopted exactly (never above what this client ever signed), and the
   *     next voucher is priced from it rather than refused the same way again;
   *   - **it did not advance** — the connector holds at least this much, and
   *     can hold no more than this client ever signed, so the count moves to
   *     that ceiling and the next voucher clears whatever it holds;
   *   - **anything else** banked nothing, and the charge is given back — but
   *     only if no later voucher has already superseded this one, since a
   *     concurrent send may have been banked above it.
   */
  refused(
    channelId: string,
    voucherAmount: bigint,
    charge: bigint,
    reason: { notAdvancing: boolean; connectorWatermark?: bigint }
  ): void {
    const entry = this.entry(channelId);
    const ceiling = entry.signedCeiling ?? entry.cumulativeAmount;
    let cumulative = entry.cumulativeAmount;
    if (reason.connectorWatermark !== undefined) {
      cumulative =
        reason.connectorWatermark > ceiling
          ? ceiling
          : reason.connectorWatermark;
    } else if (reason.notAdvancing) {
      cumulative = ceiling > cumulative ? ceiling : cumulative;
    } else if (entry.cumulativeAmount === voucherAmount && charge > 0n) {
      cumulative = voucherAmount > charge ? voucherAmount - charge : 0n;
    }
    if (cumulative === entry.cumulativeAmount) return;
    this.store.save(channelId, { ...entry, cumulativeAmount: cumulative });
  }

  /** Whether this client still holds the watermark for `channelId`. */
  hasWatermark(channelId: string): boolean {
    return this.store.load(channelId) !== undefined;
  }

  /**
   * Rebuild a lost watermark for a channel whose binding survived — the two
   * live in separate files — from what the chain shows landed. The connector
   * holds at least that much; until connector#1364 lets `claim-state` answer
   * for a voucher channel, it is the best floor there is.
   */
  restoreWatermark(channelId: string, landed: bigint): void {
    if (this.store.load(channelId)) return;
    this.store.save(channelId, {
      nonce: 0,
      cumulativeAmount: landed,
      signedCeiling: landed,
    });
  }

  /**
   * Raise the watermark to what the chain shows landed on `channelId` — EVM
   * `channels(id).totalClaimed`, Solana `settled` — when the store lost it. The
   * connector has banked at least that much, so it is a floor, never a ceiling:
   * a figure below what this client counts moves nothing.
   */
  recoverFromChain(channelId: string, landed: bigint): void {
    const entry = this.entry(channelId);
    if (landed <= entry.cumulativeAmount) return;
    this.store.save(channelId, {
      ...entry,
      cumulativeAmount: landed,
      signedCeiling:
        entry.signedCeiling === undefined || landed > entry.signedCeiling
          ? landed
          : entry.signedCeiling,
    });
  }

  /**
   * Record that this client started leaving `channelId` at `closedAt`, and can
   * take its deposit back from `settleableAt` (unix seconds). A closing channel
   * takes no more vouchers: the connector stops accepting them the moment the
   * chain says the payer is leaving.
   */
  markClosing(channelId: string, closedAt: bigint, settleableAt: bigint): void {
    this.store.save(channelId, {
      ...this.entry(channelId),
      closedAt,
      settleableAt,
    });
  }

  /** Record that `channelId`'s unspent deposit is back with the payer. */
  markSettled(channelId: string, settledAt: bigint): void {
    this.store.save(channelId, { ...this.entry(channelId), settledAt });
  }

  /** Whether this client has started leaving `channelId`. */
  isClosing(channelId: string): boolean {
    return this.store.load(channelId)?.closedAt !== undefined;
  }

  /**
   * Every channel this client holds on `connector`, live or archived, with its
   * exit state — what `toon channel settle` walks to take deposits back.
   */
  channels(connector: string): {
    channel: BatchChannel;
    depositTotal: bigint;
    signed: bigint;
    closedAt?: bigint;
    settleableAt?: bigint;
    settledAt?: bigint;
  }[] {
    const prefix = `${KEY_PREFIX}${connector}|`;
    return (this.store.listBindings?.() ?? [])
      .filter(
        ({ key, binding }) => key.startsWith(prefix) && binding.batchSettlement
      )
      .map(({ binding }) => {
        const entry = this.store.load(binding.channelId);
        return {
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- filtered above
          channel: fromBinding(binding.channelId, binding.batchSettlement!),
          depositTotal: binding.depositTotal ?? 0n,
          signed: entry?.cumulativeAmount ?? 0n,
          ...(entry?.closedAt !== undefined
            ? { closedAt: entry.closedAt }
            : {}),
          ...(entry?.settleableAt !== undefined
            ? { settleableAt: entry.settleableAt }
            : {}),
          ...(entry?.settledAt !== undefined
            ? { settledAt: entry.settledAt }
            : {}),
        };
      });
  }

  /**
   * The channels on `connector` this client can still pay from or leave: not
   * yet closing, whether live or archived by a newer one.
   */
  openChannels(connector: string): BatchChannel[] {
    return this.channels(connector)
      .filter((c) => c.closedAt === undefined && c.settledAt === undefined)
      .map((c) => c.channel);
  }

  private requireBinding(channelId: string) {
    const found = this.findBinding(channelId);
    if (!found)
      throw new ValidationError(
        `no batch-settlement channel ${channelId} is held`
      );
    return found;
  }

  private entry(channelId: string): ChannelStoreEntry {
    const entry = this.store.load(channelId);
    if (!entry)
      throw new ValidationError(
        `no batch-settlement channel ${channelId} is held`
      );
    return entry;
  }

  /**
   * The binding that records `channelId`, live or archived: a channel retired by
   * a newer one on the same connector still holds its deposit, and still needs
   * its watermark to exit.
   */
  private findBinding(channelId: string) {
    return this.store
      .listBindings?.()
      .find(
        ({ key, binding }) =>
          key.startsWith(KEY_PREFIX) &&
          binding.batchSettlement !== undefined &&
          binding.channelId === channelId
      );
  }
}

function toBinding(channel: BatchChannel): BatchSettlementBinding {
  if (channel.chain === 'evm') {
    return {
      chain: 'evm',
      network: channel.network,
      config: { ...channel.config },
    };
  }
  return {
    chain: 'solana',
    network: channel.network,
    sponsor: channel.sponsor,
    config: {
      ...channel.config,
      salt: channel.config.salt.toString(),
      openSlot: channel.config.openSlot.toString(),
    },
  };
}

function fromBinding(
  channelId: string,
  b: BatchSettlementBinding
): BatchChannel {
  if (b.chain === 'evm') {
    return {
      chain: 'evm',
      channelId,
      network: b.network,
      config: { ...b.config, salt: b.config.salt as Hex },
    };
  }
  return {
    chain: 'solana',
    channelId,
    network: b.network,
    sponsor: b.sponsor,
    config: {
      ...b.config,
      salt: BigInt(b.config.salt),
      openSlot: BigInt(b.config.openSlot),
    },
  };
}
