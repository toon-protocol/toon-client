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
      depositTotal,
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
    const found = this.findBinding(channelId);
    if (!found)
      throw new ValidationError(
        `no batch-settlement channel ${channelId} is held`
      );
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
   * The connector refused the voucher reserved for `charge`. A refusal that
   * says the amount did not advance means the connector already holds at least
   * that much, so it stays counted; any other refusal means nothing was
   * banked, and the charge is given back.
   */
  refused(
    channelId: string,
    charge: bigint,
    reason: { notAdvancing: boolean }
  ): void {
    if (reason.notAdvancing || charge <= 0n) return;
    const entry = this.entry(channelId);
    this.store.save(channelId, {
      ...entry,
      cumulativeAmount:
        entry.cumulativeAmount > charge ? entry.cumulativeAmount - charge : 0n,
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
