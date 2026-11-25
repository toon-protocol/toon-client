/**
 * A **settlement network**: one adapter per network this client pays on, which
 * owns everything chain-specific about an x402 `batch-settlement` channel
 * there (connector #1684, #1685; toon-client#777).
 *
 * The payer asks it, and never asks "which chain is this?" itself:
 *
 *   - to open a channel from the connector's terms ({@link SettlementNetwork.open});
 *   - to cover a charge the deposit cannot: an EVM channel is topped up, a
 *     Solana one replaced (ADR 0003) — {@link SettlementNetwork.cover};
 *   - to read a channel's escrow and what has landed ({@link SettlementNetwork.read});
 *   - and, through its **voucher scheme**, to sign a voucher into the claim a
 *     packet carries ({@link SettlementNetwork.voucher}) and to sign the
 *     claim-state challenge ({@link SettlementNetwork.challenge}).
 *
 * The channel facade asks it to leave a channel ({@link SettlementNetwork.close},
 * {@link SettlementNetwork.settle}), and the manager asks its stored form to
 * turn a channel to and from the channel record ({@link ChannelStoredForm}).
 *
 * Each is built once, at client creation, from the chain's key and its RPC
 * route: `evm-network.ts` and `solana-network.ts`.
 */

import type { BatchSettlementBinding } from '../ChannelStore.js';
import { ConfigError, InsufficientBalanceError } from '../../client/errors.js';
import type { BatchChannel } from './manager.js';
import type { BatchSettlementTerms } from './offers.js';

/**
 * A channel built and ready to open, not yet sent. The payer records it as
 * pending before {@link land} sends it: a facilitator or sponsor may land the
 * deposit and lose the answer, and a channel not recorded first is a deposit
 * lost.
 */
export interface PlannedOpen {
  channel: BatchChannel;
  /** The deposit the open locks: what the payer records as pending. */
  deposit: bigint;
  /** Send the open. A throw leaves it pending unless it is a definite refusal. */
  land(): Promise<void>;
}

/** What a charge, a deposit and the running total come to. */
export interface OpenAmounts {
  /** The deposit the client is configured to lock. */
  deposit: bigint;
  /** The charge of the packet the channel is opened for (`1` for an open on request). */
  charge: bigint;
}

export interface TopUpAmounts {
  /** How much more to deposit. */
  amount: bigint;
  /** The running cumulative the deposit's voucher carries. */
  voucherAmount: bigint;
  /** The charge of the packet it is for (`1` for a top-up on request). */
  charge: bigint;
}

/**
 * How a network covers a charge its channel's deposit cannot (ADR 0003):
 * `top-up` deposits more into the same channel; `replace` opens a fresh one
 * and archives the old, and refuses a top-up with `noTopUp`.
 */
export type Cover =
  | {
      kind: 'top-up';
      /** Deposit more into `channel`, carrying the voucher for `voucherAmount`. */
      deposit(
        channel: BatchChannel,
        terms: BatchSettlementTerms,
        amounts: TopUpAmounts
      ): Promise<void>;
    }
  | { kind: 'replace'; noTopUp: string };

/**
 * How a network's channels are kept in the channel record: what must survive a
 * restart to pay from or leave the channel again. It needs no key, so a channel
 * on a network this client holds no key for still reads back.
 */
export interface ChannelStoredForm {
  /** Whether this adapter pays on `network`, a CAIP-2 id. */
  serves(network: string): boolean;
  /** `channel` as the channel record stores it. */
  toStored(channel: BatchChannel): BatchSettlementBinding;
  /** The channel `stored` under `channelId` describes. */
  fromStored(channelId: string, stored: BatchSettlementBinding): BatchChannel;
}

/**
 * Where leaving a channel stands after {@link SettlementNetwork.close}:
 * `done` when the chain holds nothing left to take back, `closing` when the
 * unspent deposit can be taken back from `settleableAt` (unix seconds).
 */
export type CloseOutcome =
  | { kind: 'done' }
  | { kind: 'closing'; settleableAt: bigint; transaction?: string };

/**
 * What {@link SettlementNetwork.settle} did: `settled` when the unspent
 * deposit is back (with the transaction, when one was needed), `not-yet` when
 * the channel cannot be settled yet.
 */
export type SettleOutcome =
  | { kind: 'settled'; transaction?: string }
  | { kind: 'not-yet' };

export interface SettlementNetwork extends ChannelStoredForm {
  /** The kind of chain, which labels a voucher and names a missing key. */
  readonly chain: BatchChannel['chain'];
  /** Build a channel to the connector from its `terms`, ready to be recorded and sent. */
  open(terms: BatchSettlementTerms, amounts: OpenAmounts): Promise<PlannedOpen>;
  readonly cover: Cover;
  /**
   * What the chain holds for `channel`: its escrow (`undefined` when there is
   * no such channel yet), and what has landed — a floor under the connector's
   * watermark.
   */
  read(
    channel: BatchChannel
  ): Promise<{ escrow: bigint | undefined; landed: bigint }>;
  /** The voucher scheme: sign `cumulative` on `channel`, as the claim a packet carries. */
  voucher(
    channel: BatchChannel,
    cumulative: bigint
  ): Promise<Record<string, unknown>>;
  /**
   * The voucher scheme's claim-state challenge for `channel`, signed by its
   * voucher signer (ADR 0075).
   */
  challenge(
    channel: BatchChannel,
    expires: bigint
  ): Promise<Record<string, unknown>>;
  /**
   * Start leaving `channel` with the payer's own transaction, which gives the
   * connector a window to land its latest voucher first. `now` is unix seconds.
   */
  close(channel: BatchChannel, now: bigint): Promise<CloseOutcome>;
  /**
   * Take back `channel`'s unspent deposit. `due` says this client's own close
   * window has passed; whether a channel is settleable before that is the
   * network's answer, not the caller's.
   */
  settle(
    channel: BatchChannel,
    when: { due: boolean; now: bigint }
  ): Promise<SettleOutcome>;
}

/**
 * Leaving is the one step of the scheme that costs native gas, and a payer that
 * onboarded gaslessly may well hold none. Say so plainly, before a transaction
 * is built, rather than let the node's "gas required exceeds allowance" stand
 * in for the reason.
 */
export async function requireExitGas(
  gas: string,
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

/** The adapter that pays on `network`, or `undefined` when this client holds none. */
export function settlementNetworkFor(
  networks: readonly SettlementNetwork[],
  network: string
): SettlementNetwork | undefined {
  return networks.find((n) => n.serves(network));
}

/** The stored form for `network`. A channel no adapter stores is an error. */
export function storedFormFor(
  forms: readonly ChannelStoredForm[],
  network: string
): ChannelStoredForm {
  const found = forms.find((f) => f.serves(network));
  if (found === undefined) {
    throw new ConfigError(
      `this client keeps no batch-settlement channels on ${network}`
    );
  }
  return found;
}
