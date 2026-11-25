/**
 * Paying a connector from an x402 `batch-settlement` channel: the one object
 * {@link ../../client/send.js!send} asks for a voucher — the only way this
 * client pays (connector ADRs 0074, 0075; toon-client#689, #690, #692).
 *
 * The payer is chain-blind. Everything chain-specific — opening, covering,
 * reading the chain, and the voucher scheme — is the
 * {@link SettlementNetwork}'s for the channel's network. For each paid packet it:
 *
 *   1. finds the node's `batch-settlement` terms on the chain this client pays
 *      from — none, and it steps aside: the node cannot be paid there;
 *   2. resolves the channel it holds with this node there — settling any
 *      deposit whose answer was lost, and rebuilding a lost or doubtful
 *      watermark from the chain and the connector's `claim-state` — or has the
 *      network open one;
 *   3. covers a charge the channel's deposit cannot: the network tops it up,
 *      or the payer replaces it with a fresh one (ADR 0003);
 *   4. reserves the next cumulative amount — persisted before anything is
 *      signed — and has the network's voucher scheme sign it;
 *   5. hands back the claim, and learns the packet's fate from the caller.
 *
 * **Nothing leaves before it is recorded.** A deposit or sponsored open is
 * written down as pending first, because the facilitator or sponsor may land
 * it and then fail to answer: on EVM the contract never gives a config back,
 * and a Solana PDA cannot be recomputed without its salt and slot, so a
 * channel not recorded first is a deposit lost. The next use reads the chain
 * and settles the pending deposit either way.
 */

import type { NodeSelfDescription } from '../../connector/self-description.js';
import {
  ChannelNotOpenError,
  ConfigError,
  FacilitatorError,
  SponsorRefusedError,
  ValidationError,
} from '../../client/errors.js';
import { chooseBatchSettlement, type BatchSettlementTerms } from './offers.js';
import type { BatchChannel, BatchChannelManager } from './manager.js';
import {
  settlementNetworkFor,
  type PlannedOpen,
  type SettlementNetwork,
} from './settlement-network.js';

/** What became of a packet that carried a voucher. */
export type VoucherOutcome =
  | { kind: 'banked' }
  /**
   * A transport error or timeout: it may or may not have arrived. The channel
   * is marked in doubt, so the next voucher resyncs before it is signed.
   */
  | { kind: 'unknown' }
  /** The connector refused the voucher; `message` is its reject's own text. */
  | { kind: 'refused'; message?: string };

/** A voucher ready to ride one packet. */
export interface PreparedVoucher {
  chain: 'evm' | 'solana';
  channelId: string;
  /** The client-edge claim, for the carriage to attach. */
  claim: Record<string, unknown>;
  /** The cumulative amount it signs for. */
  cumulative: bigint;
  /** Report the packet's fate, so the watermark follows it. */
  settle(outcome: VoucherOutcome): void;
}

export interface BatchSettlementPayerConfig {
  /** The connector's client-edge URL — what channels are bound to. */
  connector: string;
  manager: BatchChannelManager;
  /** Atomic units deposited on onboarding, and again on each top-up. */
  deposit: bigint;
  /**
   * The settlement networks this client pays on, one per network: each opens,
   * covers, reads and signs for its own channels.
   */
  networks: readonly SettlementNetwork[];
  /**
   * The connector's own watermark for a channel (`POST /ilp/claim-state`),
   * asked with the voucher challenge this payer signs. It recovers a lost
   * watermark, and settles one a refusal left in doubt. Without it, the chain's
   * landed figure — a floor — is all there is.
   */
  connectorWatermark?: (
    entry: Record<string, unknown>
  ) => Promise<bigint | undefined>;
  /**
   * Whether a paid packet may open, top up or replace a channel on its own.
   * Default `true`. `false` leaves every such step to {@link BatchSettlementPayer.open}
   * and {@link BatchSettlementPayer.topUp}, and a packet that needs one throws
   * {@link ChannelNotOpenError} instead.
   */
  autoOpen?: boolean;
}

/**
 * What a voucher's refusal says about the connector's watermark, read from its
 * reject message (`connector-client-edge`'s `ClaimIngestRejection::message`):
 *
 *   - `advances value by A, less than this route's price` — an underpayment,
 *     which names how far the voucher for `voucherAmount` advanced the
 *     watermark, so the watermark is `voucherAmount − A`;
 *   - `cumulative amount goes backwards` — the connector holds at least
 *     `voucherAmount`, and says no more.
 */
export function readVoucherRefusal(
  message: string | undefined,
  voucherAmount: bigint
): { notAdvancing: boolean; connectorWatermark?: bigint } {
  if (message === undefined) return { notAdvancing: false };
  const advancedBy = /advances value by (\d+),/.exec(message)?.[1];
  if (advancedBy !== undefined) {
    const advanced = BigInt(advancedBy);
    const watermark = voucherAmount > advanced ? voucherAmount - advanced : 0n;
    return { notAdvancing: advanced === 0n, connectorWatermark: watermark };
  }
  return { notAdvancing: message.includes('cumulative amount goes backwards') };
}

/** How a missing adapter is named, by the chain the terms are on. */
const CHAIN_NAME: Record<BatchChannel['chain'], string> = {
  evm: 'EVM',
  solana: 'Solana',
};

export class BatchSettlementPayer {
  /** Onboardings in flight, so concurrent first sends open one channel, not two. */
  private readonly onboarding = new Map<string, Promise<BatchChannel>>();

  constructor(private readonly config: BatchSettlementPayerConfig) {
    if (config.deposit <= 0n) {
      throw new ConfigError(
        `a batch-settlement deposit must be positive, got ${config.deposit}`
      );
    }
  }

  /**
   * A voucher for one packet charging `amount` on `chain`, or `undefined` when
   * this node offers no `batch-settlement` there — and so cannot be paid on
   * `chain` at all.
   */
  async claimFor(
    description: NodeSelfDescription,
    chain: 'evm' | 'solana',
    amount: bigint
  ): Promise<PreparedVoucher | undefined> {
    const terms = chooseBatchSettlement(description, chain);
    if (terms === undefined) return undefined;
    const network = this.network(terms.network, terms.chain);
    const channel = await this.channelFor(network, terms, amount);
    return this.voucher(network, channel, amount);
  }

  /**
   * Open a channel to this node on `chain` now, rather than on the first paid
   * packet — or return the one already open there. `undefined` when the node
   * offers no `batch-settlement` on `chain`.
   *
   * On EVM the deposit must carry a voucher of at least one unit (ADR 0074
   * prerequisite 1). It is signed for one unit and handed only to the
   * facilitator, which cannot claim it — `receiverAuthorizer` is the
   * connector's — and the first real voucher supersedes it.
   */
  async open(
    description: NodeSelfDescription,
    chain: 'evm' | 'solana'
  ): Promise<BatchChannel | undefined> {
    const terms = chooseBatchSettlement(description, chain);
    if (terms === undefined) return undefined;
    const network = this.network(terms.network, terms.chain);
    const live = await this.live(terms.network, terms.asset);
    if (live !== undefined) return live;
    return this.onboard(terms, () => this.openThrough(network, terms, 1n));
  }

  /**
   * Deposit `amount` more into the channel this client pays the node from, on a
   * network that tops channels up. One that replaces them instead (Solana's,
   * whose sponsor opens channels and nothing else) refuses.
   */
  async topUp(
    description: NodeSelfDescription,
    chain: 'evm' | 'solana',
    amount: bigint
  ): Promise<BatchChannel> {
    const terms = chooseBatchSettlement(description, chain);
    const network = terms && this.network(terms.network, terms.chain);
    if (network?.cover.kind === 'replace') {
      throw new ConfigError(network.cover.noTopUp);
    }
    if (terms === undefined || network === undefined) {
      throw new ConfigError(
        `${this.config.connector} offers no batch-settlement channel on ${chain}`
      );
    }
    const channel = await this.live(terms.network, terms.asset);
    if (channel === undefined) {
      throw new ChannelNotOpenError(
        `no batch-settlement channel to ${this.config.connector} is open to top up`
      );
    }
    await this.deposit(
      network,
      channel,
      terms,
      amount,
      this.config.manager.signedSoFar(channel.channelId) + 1n,
      1n
    );
    return channel;
  }

  // ─── The channel for a packet ────────────────────────────────────────────

  /**
   * The channel to pay a packet charging `charge` from: the live one, covered
   * if its deposit falls short, or a fresh one.
   */
  private async channelFor(
    network: SettlementNetwork,
    terms: BatchSettlementTerms,
    charge: bigint
  ): Promise<BatchChannel> {
    const manager = this.config.manager;
    const channel = await this.live(terms.network, terms.asset);
    if (channel === undefined) {
      this.assertMayOpen('a batch-settlement channel', 'channel open');
      return this.onboard(terms, () =>
        this.openThrough(network, terms, charge)
      );
    }
    const needed = manager.signedSoFar(channel.channelId) + charge;
    const held = manager.depositTotal(channel.channelId);
    if (needed <= held) return channel;
    if (network.cover.kind === 'top-up') {
      this.assertMayOpen(
        'a top-up of its batch-settlement channel',
        'channel deposit'
      );
      const shortfall = needed - held;
      const amount =
        this.config.deposit > shortfall ? this.config.deposit : shortfall;
      await this.deposit(network, channel, terms, amount, needed, charge);
      return channel;
    }
    // A network that cannot top up without costing the payer native gas
    // replaces the channel with a fresh one instead, and its binding is
    // archived: it stays listed, and `close` / `settle` take what is left in
    // it back.
    this.assertMayOpen(
      'a fresh sponsored batch-settlement channel',
      // `open` returns the live channel however little is left in it; leaving
      // it first is what makes the next open a fresh one, and takes back the rest.
      'channel close`, then `toon-client channel open'
    );
    return this.onboard(
      terms,
      () => this.openThrough(network, terms, charge),
      channel.channelId
    );
  }

  /**
   * The channel this client pays the node from on `network` in `asset`, once
   * any deposit whose answer was lost is settled and any lost watermark is
   * rebuilt — or `undefined` when there is none it can still pay from.
   */
  private async live(
    network: string,
    asset: string
  ): Promise<BatchChannel | undefined> {
    const manager = this.config.manager;
    const channel = manager.resolve(this.config.connector, network, asset);
    if (channel === undefined) return undefined;
    if (manager.pendingDeposit(channel.channelId) !== undefined) {
      await this.reconcile(channel);
      if (manager.resolve(this.config.connector, network, asset) === undefined)
        return undefined;
    }
    if (!manager.hasWatermark(channel.channelId)) {
      // The chain's figure is a floor; the connector's, when it will say, is
      // the one that decides — and with the local record gone, it may exceed
      // anything this client can still show it signed.
      manager.restoreWatermark(
        channel.channelId,
        (await this.networkOf(channel).read(channel)).landed
      );
      await this.resync(channel, { recovering: true });
    } else if (manager.inDoubt(channel.channelId)) {
      await this.resync(channel);
    }
    if (manager.isClosing(channel.channelId)) return undefined;
    return channel;
  }

  /**
   * Ask the connector where it stands on `channel` and adopt its figure — the
   * one that decides. Best effort: a connector that cannot answer leaves the
   * local figure as it was, and the doubt standing.
   */
  private async resync(
    channel: BatchChannel,
    options: { recovering?: boolean } = {}
  ): Promise<void> {
    const ask = this.config.connectorWatermark;
    if (!ask) return;
    let watermark: bigint | undefined;
    try {
      const expires = BigInt(Math.floor(Date.now() / 1000) + 60);
      watermark = await ask(await this.challenge(channel, expires));
    } catch {
      return;
    }
    if (watermark === undefined) return;
    this.config.manager.adoptConnectorWatermark(
      channel.channelId,
      watermark,
      options
    );
  }

  /**
   * The voucher claim-state challenge for `channel`, signed by its voucher
   * signer: what `POST /ilp/claim-state` and BTP auth's `channelChallenge`
   * take to prove this client controls the channel (ADR 0075).
   */
  async challenge(
    channel: BatchChannel,
    expires: bigint
  ): Promise<Record<string, unknown>> {
    return this.networkOf(channel).challenge(channel, expires);
  }

  /** Settle a pending deposit against the chain: kept if it landed, dropped if not. */
  private async reconcile(channel: BatchChannel): Promise<void> {
    const manager = this.config.manager;
    const onChain = await this.networkOf(channel).read(channel);
    if (onChain.escrow === undefined) {
      // Never landed, and nothing else was ever deposited: forget the channel.
      manager.abandon(channel.channelId);
      if (manager.pendingDeposit(channel.channelId) !== undefined) {
        manager.confirmDeposit(
          channel.channelId,
          manager.depositTotal(channel.channelId)
        );
      }
      return;
    }
    manager.confirmDeposit(channel.channelId, onChain.escrow);
  }

  /** Run one onboarding per network and asset at a time; concurrent callers share it. */
  private async onboard(
    terms: { network: string; asset: string },
    run: () => Promise<BatchChannel>,
    replacing?: string
  ): Promise<BatchChannel> {
    const key = `${terms.network}|${terms.asset}|${replacing ?? ''}`;
    const inFlight = this.onboarding.get(key);
    if (inFlight) return inFlight;
    const started = run().finally(() => this.onboarding.delete(key));
    this.onboarding.set(key, started);
    return started;
  }

  /**
   * Have `network` build a channel, record it as pending, then send it: kept
   * pending if the answer is lost, forgotten only on a definite refusal.
   */
  private async openThrough(
    network: SettlementNetwork,
    terms: BatchSettlementTerms,
    charge: bigint
  ): Promise<BatchChannel> {
    const planned: PlannedOpen = await network.open(terms, {
      deposit: this.config.deposit,
      charge,
    });
    const { channel, deposit } = planned;
    const manager = this.config.manager;
    manager.adoptPending(this.config.connector, channel, deposit);
    try {
      await planned.land();
    } catch (err) {
      if (isDefinitiveRefusal(err)) manager.abandon(channel.channelId);
      throw err;
    }
    manager.confirmDeposit(channel.channelId, deposit);
    return channel;
  }

  /** Deposit `amount` more into `channel`, carrying the running cumulative `voucherAmount`. */
  private async deposit(
    network: SettlementNetwork,
    channel: BatchChannel,
    terms: BatchSettlementTerms,
    amount: bigint,
    voucherAmount: bigint,
    charge: bigint
  ): Promise<void> {
    if (network.cover.kind !== 'top-up')
      throw new ConfigError(network.cover.noTopUp);
    const manager = this.config.manager;
    const before = manager.depositTotal(channel.channelId);
    manager.setPendingDeposit(channel.channelId, amount);
    try {
      // The deposit carries the running cumulative: a voucher at or below
      // what the chain has claimed would be refused by the facilitator.
      await network.cover.deposit(channel, terms, {
        amount,
        voucherAmount,
        charge,
      });
    } catch (err) {
      if (isDefinitiveRefusal(err))
        manager.confirmDeposit(channel.channelId, before);
      throw err;
    }
    manager.confirmDeposit(channel.channelId, before + amount);
  }

  // ─── Vouchers ────────────────────────────────────────────────────────────

  private async voucher(
    network: SettlementNetwork,
    channel: BatchChannel,
    charge: bigint
  ): Promise<PreparedVoucher> {
    const manager = this.config.manager;
    const cumulative = manager.reserve(channel.channelId, charge);
    if (cumulative === undefined) {
      throw new ValidationError(
        'a free route carries no voucher; send it unpaid'
      );
    }
    const channelId = channel.channelId;
    const claim = await network.voucher(channel, cumulative);
    return {
      chain: channel.chain,
      channelId,
      claim,
      cumulative,
      settle: (outcome) => {
        if (outcome.kind !== 'refused') {
          // Possibly — or certainly — the connector's latest: what a probe resends.
          manager.recordVoucher(channelId, JSON.stringify(claim), cumulative);
          if (outcome.kind === 'banked') manager.banked(channelId, cumulative);
          // A lost answer is never resent (ADR 0007): the next voucher asks the
          // connector where it stands before it is signed.
          else manager.lost(channelId);
          return;
        }
        const reading = readVoucherRefusal(outcome.message, cumulative);
        manager.refused(channelId, cumulative, charge, reading);
      },
    };
  }

  // ─── Networks and rules ──────────────────────────────────────────────────

  /** The settlement network for `network`, or a refusal naming the key this client lacks. */
  private network(
    network: string,
    chain: BatchChannel['chain']
  ): SettlementNetwork {
    const found = settlementNetworkFor(this.config.networks, network);
    if (found === undefined) {
      throw new ConfigError(
        `this client holds no ${CHAIN_NAME[chain]} key to pay a batch-settlement channel with`
      );
    }
    return found;
  }

  private networkOf(channel: BatchChannel): SettlementNetwork {
    return this.network(channel.network, channel.chain);
  }

  /** Refuse an open, top-up or replacement a packet needs, when that is not its to do. */
  private assertMayOpen(what: string, command: string): void {
    if (this.config.autoOpen === false) {
      throw new ChannelNotOpenError(
        `paying ${this.config.connector} needs ${what} first, and this client does not ` +
          `open channels on its own; run \`toon-client ${command}\``
      );
    }
  }
}

/**
 * Whether a failed deposit or sponsored open is KNOWN not to have landed: the
 * facilitator or sponsor answered, readably, with a refusal. A transport
 * failure, an unreadable answer, or a sponsor's `502` (sent and not confirmed)
 * proves nothing, and leaves the deposit pending for the chain to decide.
 */
function isDefinitiveRefusal(err: unknown): boolean {
  // `settlement_pending`: x402's "I broadcast it; the receipt timed out". It
  // may well land, so the channel is kept and settled against the chain.
  if (err instanceof FacilitatorError)
    return (
      err.reason !== 'unreadable_response' &&
      err.reason !== 'settlement_pending'
    );
  if (err instanceof SponsorRefusedError) return err.status !== 502;
  return false;
}
