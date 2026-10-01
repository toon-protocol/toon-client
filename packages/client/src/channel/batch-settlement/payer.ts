/**
 * Paying a connector from an x402 `batch-settlement` channel: the one object
 * {@link ../../client/send.js!send} asks for a voucher — the only way this
 * client pays (connector ADRs 0074, 0075; toon-client#689, #690, #692).
 *
 * For each paid packet it:
 *
 *   1. finds the node's `batch-settlement` terms on the chain this client pays
 *      from — none, and it steps aside: the node cannot be paid there;
 *   2. resolves the channel it holds with this node there — settling any
 *      deposit whose answer was lost, and rebuilding a lost or doubtful
 *      watermark from the chain and the connector's `claim-state` — or onboards one with no native gas: on EVM a deposit through an
 *      x402 facilitator, on Solana an open the connector sponsors;
 *   3. tops the channel up when its deposit cannot cover the next voucher: a
 *      further deposit on EVM, a fresh sponsored channel on Solana;
 *   4. reserves the next cumulative amount — persisted before anything is
 *      signed — and signs the voucher;
 *   5. hands back the claim, and learns the packet's fate from the caller.
 *
 * **Nothing leaves before it is recorded.** A deposit or sponsored open is
 * written down as pending first, because the facilitator or sponsor may land
 * it and then fail to answer: on EVM the contract never gives a config back,
 * and a Solana PDA cannot be recomputed without its salt and slot, so a
 * channel not recorded first is a deposit lost. The next use reads the chain
 * and settles the pending deposit either way.
 */

import type { Hex } from 'viem';
import type { NodeSelfDescription } from '../../connector/self-description.js';
import {
  ChannelNotOpenError,
  ConfigError,
  FacilitatorError,
  InsufficientBalanceError,
  NetworkError,
  SponsorRefusedError,
  ValidationError,
} from '../../client/errors.js';
import {
  batchChannelId,
  buildBatchChannelConfig,
  buildEip3009Deposit,
  buildPermit2Deposit,
  evmChainIdOf,
  readEvmBatchChannel,
  signBatchVoucher,
  type BatchSettlementEvmOffer,
  type ContractReader,
  type TypedDataSigner,
} from './evm.js';
import { settleDeposit } from './facilitator.js';
import {
  ERC20_APPROVAL_GAS_SPONSORING,
  EIP2612_GAS_SPONSORING,
  approvePermit2,
  depositDirectly,
  eip2612Nonce,
  facilitatorExtensions,
  permit2Allowance,
  signEip2612GasSponsoring,
  signErc20ApprovalGasSponsoring,
  type DepositExtensions,
  type EvmWalletAccess,
} from './deposit-gas.js';
import { chooseBatchSettlement, offerFromTerms } from './offers.js';
import { evmVoucherClaim, solanaVoucherClaim } from './claim.js';
import {
  buildSponsoredOpen,
  buildSvmBatchChannelConfig,
  getSvmBatchChannel,
  signSvmVoucher,
  type BatchSettlementSvmOffer,
} from './svm.js';
import { requestSponsoredOpen } from './sponsor.js';
import { signEvmChallenge, signSolanaChallenge } from './challenge.js';
import { defaultFacilitatorFor } from '../../presets.js';
import {
  deriveAssociatedTokenAccount,
  getLatestBlockhash,
  getTokenAccountBalance,
  solanaRpc,
  type Signer,
  type SolanaRpcTarget,
} from '../solana/payment-channel.js';
import { base58Encode } from '../../utils/base58.js';
import type { BatchChannel, BatchChannelManager } from './manager.js';

/** What became of a packet that carried a voucher. */
export type VoucherOutcome =
  | { kind: 'banked' }
  /** A transport error or timeout: it may or may not have arrived. */
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
  evm?: {
    /** The funding wallet; also signs vouchers unless `voucherSigner` is set. */
    account: TypedDataSigner;
    /** Signs vouchers as the channel's `payerAuthorizer`. */
    voucherSigner?: TypedDataSigner;
    /**
     * The x402 facilitator that relays deposits and pays their gas. Defaults
     * to the devnet's own on Base Sepolia (`defaultFacilitatorFor`).
     */
    facilitatorUrl?: string;
    /**
     * How a deposit moves the token: `eip3009` for a token with ERC-3009,
     * `permit2` for any other ERC-20. Defaults to what the connector's offer
     * names (`assetTransferMethod`), and to `eip3009` when it names nothing.
     */
    depositMethod?: 'eip3009' | 'permit2';
    /**
     * Who pays a deposit's gas, and a Permit2 token's one-time approval's:
     *
     *   - `auto` (the default): the facilitator, when there is one and it will;
     *     otherwise the payer, when it holds ETH;
     *   - `facilitator`: only ever the facilitator — the payer's ETH is never
     *     spent;
     *   - `self`: always the payer, and no facilitator is contacted at all.
     */
    depositGas?: 'auto' | 'facilitator' | 'self';
    /**
     * The payer's own chain access: what a self-paid deposit or approval, and
     * an approval the facilitator sponsors, are signed and sent with. Without
     * it the payer can only use a facilitator, and only for tokens it needs no
     * approval for.
     */
    wallet?: EvmWalletAccess;
    /**
     * Reads the escrow back, to settle a deposit whose answer was lost and to
     * rebuild a lost watermark. Without one, either of those is an error
     * rather than a guess.
     */
    reader?: ContractReader;
  };
  solana?: {
    /** The funding wallet; also the channel's `authorized_signer`, which signs vouchers. */
    signer: Signer;
    /** The Solana JSON-RPC to read the slot, the blockhash and the accounts from. */
    rpc: SolanaRpcTarget;
  };
  /** How the connector's sponsor endpoint and the facilitator are reached. */
  fetch?: typeof fetch;
  /**
   * The connector's own watermark for a channel (`POST /ilp/claim-state`),
   * asked with the voucher challenge this payer signs. It recovers a lost
   * watermark, and settles one a refusal left in doubt. Without it, the chain's
   * landed figure — a floor — is all there is.
   */
  connectorWatermark?: (entry: Record<string, unknown>) => Promise<bigint | undefined>;
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

type EvmPayerConfig = NonNullable<BatchSettlementPayerConfig['evm']>;
type SolanaPayerConfig = NonNullable<BatchSettlementPayerConfig['solana']>;

export class BatchSettlementPayer {
  /** Onboardings in flight, so concurrent first sends open one channel, not two. */
  private readonly onboarding = new Map<string, Promise<BatchChannel>>();
  /** Channels whose last refusal said the connector holds more, without saying how much. */
  private readonly inDoubt = new Set<string>();

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
    const priced = offerFromTerms(terms, amount);
    const channel =
      priced.chain === 'evm'
        ? await this.evmChannelFor(this.requireEvm(), priced.offer, amount)
        : await this.solanaChannelFor(
            this.requireSolana(),
            priced.offer,
            amount
          );
    return this.voucher(channel, amount);
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
    const priced = offerFromTerms(terms, 1n);
    const live = await this.live(priced.offer.network, priced.offer.asset);
    if (live !== undefined) return live;
    return priced.chain === 'evm'
      ? this.onboard(priced.offer, () =>
          this.evmOnboard(this.requireEvm(), priced.offer, 1n)
        )
      : this.onboard(priced.offer, () =>
          this.solanaOnboard(this.requireSolana(), priced.offer, 1n)
        );
  }

  /**
   * Deposit `amount` more into the Base channel this client pays the node
   * from. A Solana channel has no top-up that costs no SOL, so it is replaced
   * by a fresh sponsored one instead, and this refuses.
   */
  async topUp(
    description: NodeSelfDescription,
    chain: 'evm' | 'solana',
    amount: bigint
  ): Promise<BatchChannel> {
    if (chain !== 'evm') {
      throw new ConfigError(
        'a Solana batch-settlement channel is not topped up: the next payment it cannot cover opens a fresh sponsored one'
      );
    }
    const terms = chooseBatchSettlement(description, 'evm');
    if (terms === undefined) {
      throw new ConfigError(
        `${this.config.connector} offers no batch-settlement channel on evm`
      );
    }
    const priced = offerFromTerms(terms, 1n);
    if (priced.chain !== 'evm') throw new Error('unreachable');
    const channel = await this.live(priced.offer.network, priced.offer.asset);
    if (channel === undefined || channel.chain !== 'evm') {
      throw new ChannelNotOpenError(
        `no batch-settlement channel to ${this.config.connector} is open to top up`
      );
    }
    const manager = this.config.manager;
    await this.evmDeposit(
      this.requireEvm(),
      channel,
      priced.offer,
      amount,
      manager.signedSoFar(channel.channelId) + 1n
    );
    return channel;
  }

  // ─── The channel for a packet ────────────────────────────────────────────

  private async evmChannelFor(
    evm: EvmPayerConfig,
    offer: BatchSettlementEvmOffer,
    charge: bigint
  ): Promise<BatchChannel> {
    const manager = this.config.manager;
    let channel = await this.live(offer.network, offer.asset);
    if (channel === undefined) {
      this.assertMayOpen('a batch-settlement channel', 'channel open');
      channel = await this.onboard(offer, () =>
        this.evmOnboard(evm, offer, charge)
      );
    } else {
      const needed = manager.signedSoFar(channel.channelId) + charge;
      if (needed > manager.depositTotal(channel.channelId)) {
        this.assertMayOpen(
          'a top-up of its batch-settlement channel',
          'channel deposit'
        );
        const shortfall = needed - manager.depositTotal(channel.channelId);
        const amount =
          this.config.deposit > shortfall ? this.config.deposit : shortfall;
        await this.evmDeposit(evm, channel, offer, amount, needed);
      }
    }
    return channel;
  }

  private async solanaChannelFor(
    solana: SolanaPayerConfig,
    offer: BatchSettlementSvmOffer,
    charge: bigint
  ): Promise<BatchChannel> {
    const manager = this.config.manager;
    const channel = await this.live(offer.network, offer.asset);
    // The sponsor endpoint opens channels and nothing else, so a Solana top-up
    // would cost the payer SOL. A channel its deposit cannot cover is instead
    // replaced by a fresh sponsored one, and its binding archived: it stays
    // listed, and `close` / `settle` take what is left in it back.
    if (
      channel !== undefined &&
      manager.signedSoFar(channel.channelId) + charge <=
        manager.depositTotal(channel.channelId)
    ) {
      return channel;
    }
    this.assertMayOpen(
      'a fresh sponsored batch-settlement channel',
      // `open` returns the live channel however little is left in it; leaving
      // it first is what makes the next open a fresh one, and takes back the rest.
      channel === undefined ? 'channel open' : 'channel close`, then `toon-client channel open'
    );
    return this.onboard(
      offer,
      () => this.solanaOnboard(solana, offer, charge),
      channel?.channelId
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
        (await this.readChain(channel)).landed
      );
      await this.resync(channel, { recovering: true });
    } else if (this.inDoubt.has(channel.channelId)) {
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
  private async resync(channel: BatchChannel, options: { recovering?: boolean } = {}): Promise<void> {
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
    this.config.manager.adoptConnectorWatermark(channel.channelId, watermark, options);
    this.inDoubt.delete(channel.channelId);
  }

  /**
   * The voucher claim-state challenge for `channel`, signed by its voucher
   * signer: what `POST /ilp/claim-state` and BTP auth's `channelChallenge`
   * take to prove this client controls the channel (ADR 0075).
   */
  async challenge(channel: BatchChannel, expires: bigint): Promise<Record<string, unknown>> {
    if (channel.chain === 'evm') {
      const evm = this.requireEvm();
      return signEvmChallenge(
        evm.voucherSigner ?? evm.account,
        evmChainIdOf(channel.network),
        channel.config,
        channel.channelId as Hex,
        expires
      );
    }
    return signSolanaChallenge(this.requireSolana().signer, channel.channelId, expires);
  }

  /** Settle a pending deposit against the chain: kept if it landed, dropped if not. */
  private async reconcile(channel: BatchChannel): Promise<void> {
    const manager = this.config.manager;
    const onChain = await this.readChain(channel);
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

  /**
   * What the chain holds for `channel`: its escrow (`undefined` when there is
   * no such channel yet), and what has landed — a floor under the connector's
   * watermark.
   */
  private async readChain(
    channel: BatchChannel
  ): Promise<{ escrow: bigint | undefined; landed: bigint }> {
    if (channel.chain === 'evm') {
      const reader = this.config.evm?.reader;
      if (!reader) {
        throw new ConfigError(
          `channel ${channel.channelId} needs reading back from the chain, and this payer has no EVM reader`
        );
      }
      const state = await readEvmBatchChannel(reader, channel.channelId as Hex);
      return {
        escrow:
          state.balance > 0n || state.totalClaimed > 0n
            ? state.balance
            : undefined,
        landed: state.totalClaimed,
      };
    }
    const state = await getSvmBatchChannel(
      this.requireSolana().rpc,
      channel.channelId
    );
    return { escrow: state?.deposit, landed: state?.settled ?? 0n };
  }

  /** Run one onboarding per network and asset at a time; concurrent callers share it. */
  private async onboard(
    offer: { network: string; asset: string },
    run: () => Promise<BatchChannel>,
    replacing?: string
  ): Promise<BatchChannel> {
    const key = `${offer.network}|${offer.asset}|${replacing ?? ''}`;
    const inFlight = this.onboarding.get(key);
    if (inFlight) return inFlight;
    const started = run().finally(() => this.onboarding.delete(key));
    this.onboarding.set(key, started);
    return started;
  }

  // ─── Vouchers ────────────────────────────────────────────────────────────

  private async voucher(
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
    let claim: Record<string, unknown>;
    if (channel.chain === 'evm') {
      const evm = this.requireEvm();
      const voucher = await signBatchVoucher(
        evm.voucherSigner ?? evm.account,
        evmChainIdOf(channel.network),
        channelId as Hex,
        cumulative
      );
      claim = evmVoucherClaim(voucher, channel.config);
    } else {
      const solana = this.requireSolana();
      claim = solanaVoucherClaim(
        signSvmVoucher(solana.signer, channelId, cumulative),
        base58Encode(solana.signer.publicKey)
      );
    }
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
          return;
        }
        const reading = readVoucherRefusal(outcome.message, cumulative);
        manager.refused(channelId, cumulative, charge, reading);
        if (reading.notAdvancing && reading.connectorWatermark === undefined) {
          this.inDoubt.add(channelId);
        }
      },
    };
  }

  // ─── EVM ─────────────────────────────────────────────────────────────────

  /**
   * Open a channel by depositing into it through the facilitator. The deposit's
   * own voucher is the first packet's charge, so the first packet can carry the
   * very same voucher (ADR 0074 prerequisite 1).
   */
  private async evmOnboard(
    evm: EvmPayerConfig,
    offer: BatchSettlementEvmOffer,
    charge: bigint
  ): Promise<BatchChannel> {
    const config = buildBatchChannelConfig({
      payer: evm.account.address,
      payerAuthorizer: (evm.voucherSigner ?? evm.account).address,
      offer,
    });
    const channel: BatchChannel = {
      chain: 'evm',
      channelId: batchChannelId(config, evmChainIdOf(offer.network)),
      network: offer.network,
      config,
    };
    const deposit = this.config.deposit > charge ? this.config.deposit : charge;
    const manager = this.config.manager;
    manager.adoptPending(this.config.connector, channel, deposit);
    try {
      await this.evmSettle(evm, offer, channel, deposit, charge);
    } catch (err) {
      if (isDefinitiveRefusal(err)) manager.abandon(channel.channelId);
      throw err;
    }
    manager.confirmDeposit(channel.channelId, deposit);
    return channel;
  }

  /** Deposit `amount` more into `channel`, carrying the running cumulative `voucherAmount`. */
  private async evmDeposit(
    evm: EvmPayerConfig,
    channel: BatchChannel,
    offer: BatchSettlementEvmOffer,
    amount: bigint,
    voucherAmount: bigint
  ): Promise<void> {
    const manager = this.config.manager;
    const before = manager.depositTotal(channel.channelId);
    manager.setPendingDeposit(channel.channelId, amount);
    try {
      // The deposit carries the running cumulative: a voucher at or below
      // what the chain has claimed would be refused by the facilitator.
      await this.evmSettle(evm, offer, channel, amount, voucherAmount);
    } catch (err) {
      if (isDefinitiveRefusal(err))
        manager.confirmDeposit(channel.channelId, before);
      throw err;
    }
    manager.confirmDeposit(channel.channelId, before + amount);
  }

  /**
   * Put a deposit of `amount`, carrying the voucher for `voucherAmount`, on
   * chain — through the facilitator, or from the payer's own ETH, as
   * `depositGas` and what is available decide (toon-client#695).
   */
  private async evmSettle(
    evm: EvmPayerConfig,
    offer: BatchSettlementEvmOffer,
    channel: BatchChannel,
    amount: bigint,
    voucherAmount: bigint
  ): Promise<void> {
    if (channel.chain !== 'evm') throw new Error('unreachable');
    const mode = evm.depositGas ?? 'auto';
    const method = evm.depositMethod ?? offer.extra.assetTransferMethod ?? 'eip3009';
    // An empty `facilitatorUrl` is the caller saying "none", not "the default".
    const facilitatorUrl =
      mode === 'self' || evm.facilitatorUrl === ''
        ? undefined
        : (evm.facilitatorUrl ?? offer.extra.facilitator ?? defaultFacilitatorFor(offer.network));
    if (facilitatorUrl === undefined && mode === 'facilitator') {
      throw new ConfigError(
        `depositing into a channel on ${offer.network} needs \`facilitatorUrl\`: the x402 ` +
          'facilitator that relays the deposit and pays its gas. This connector names none.'
      );
    }

    const build = method === 'permit2' ? buildPermit2Deposit : buildEip3009Deposit;
    const payload = await build({
      payer: evm.account,
      ...(evm.voucherSigner ? { voucherSigner: evm.voucherSigner } : {}),
      offer: {
        ...offer,
        extra: { ...offer.extra, withdrawDelay: channel.config.withdrawDelay },
      },
      config: channel.config,
      amount,
      voucherAmount,
    });

    // A Permit2 token needs Permit2 approved for the amount first.
    let extensions: DepositExtensions | undefined;
    // Without a reader the allowance is unknown, and the facilitator decides.
    if (method === 'permit2' && evm.reader) {
      const allowance = await permit2Allowance(evm.reader, offer.asset, evm.account.address);
      if (allowance < amount) {
        extensions = facilitatorUrl
          ? await this.sponsoredApproval(evm, offer, facilitatorUrl, amount, payload)
          : undefined;
        if (extensions === undefined) {
          if (mode === 'facilitator') {
            throw new FacilitatorError(
              `${offer.asset} has no ERC-3009, so its deposit goes through Permit2, which needs ` +
                `a one-time approval from ${evm.account.address}; the facilitator sponsors none, ` +
                "and depositGas 'facilitator' will not spend this wallet's ETH on it.",
              'permit2_allowance_required'
            );
          }
          await this.payOwnGas(evm, `a one-time Permit2 approval of ${offer.asset}`, facilitatorUrl);
          await approvePermit2(this.requireWallet(evm), offer.asset, {
            reader: evm.reader,
            owner: evm.account.address,
            atLeast: amount,
          });
        }
      }
    }

    if (facilitatorUrl === undefined) {
      await this.payOwnGas(evm, 'the deposit', facilitatorUrl, offer.network);
      await depositDirectly(this.requireWallet(evm), payload, method);
      return;
    }
    try {
      await settleDeposit({
        facilitatorUrl,
        // The facilitator checks the payload against the requirements' method,
        // so they name the one signed, which the caller may have overridden.
        offer: { ...offer, extra: { ...offer.extra, assetTransferMethod: method } },
        payload,
        ...(extensions ? { extensions } : {}),
        ...(this.config.fetch ? { fetchImpl: this.config.fetch } : {}),
      });
    } catch (err) {
      // The same signed payload can go on chain from the payer's own wallet,
      // and its nonce is single-use: if the facilitator's did land after all,
      // this one reverts rather than depositing twice. An approval the
      // facilitator was to fund is not ours to redo, so that case rethrows.
      const retry =
        mode === 'auto' &&
        extensions === undefined &&
        facilitatorCannotHandle(err) &&
        (await holdsEth(evm.wallet));
      if (!retry) throw explainPermit2(err, offer, evm);
      await depositDirectly(this.requireWallet(evm), payload, method);
    }
  }

  /**
   * One of x402's gas-sponsoring extensions for a Permit2 approval, when the
   * facilitator offers one this token can use; `undefined` otherwise.
   */
  private async sponsoredApproval(
    evm: EvmPayerConfig,
    offer: BatchSettlementEvmOffer,
    facilitatorUrl: string,
    amount: bigint,
    payload: { deposit: unknown }
  ): Promise<DepositExtensions | undefined> {
    let offered: string[];
    try {
      offered = await facilitatorExtensions(facilitatorUrl, this.config.fetch);
    } catch {
      return undefined;
    }
    const chainId = evmChainIdOf(offer.network);
    if (offered.includes(EIP2612_GAS_SPONSORING) && offer.extra.name && offer.extra.version) {
      const nonce = await eip2612Nonce(this.requireReader(evm), offer.asset, evm.account.address);
      if (nonce !== undefined) {
        const auth = (payload.deposit as {
          authorization: { permit2Authorization: { deadline: string } };
        }).authorization.permit2Authorization;
        return signEip2612GasSponsoring({
          payer: evm.account,
          token: offer.asset,
          name: offer.extra.name,
          version: offer.extra.version,
          chainId,
          nonce,
          amount,
          deadline: auth.deadline,
        });
      }
    }
    if (offered.includes(ERC20_APPROVAL_GAS_SPONSORING) && evm.wallet) {
      return signErc20ApprovalGasSponsoring({
        payerAddress: evm.account.address,
        wallet: evm.wallet,
        token: offer.asset,
        chainId,
      });
    }
    return undefined;
  }

  /** Refuse, naming what would work, unless the payer holds ETH to pay `what` with. */
  private async payOwnGas(
    evm: EvmPayerConfig,
    what: string,
    facilitatorUrl: string | undefined,
    network?: string
  ): Promise<void> {
    const wallet = evm.wallet;
    const eth = wallet ? await wallet.getBalance() : 0n;
    if (eth > 0n) return;
    if (network !== undefined && facilitatorUrl === undefined && evm.depositGas !== 'self') {
      throw new ConfigError(
        `depositing into a channel on ${network} needs either \`facilitatorUrl\` — an x402 ` +
          'facilitator that pays the gas, which this connector names none of — or ETH in ' +
          `${evm.account.address} to deposit directly.`
      );
    }
    throw new InsufficientBalanceError(
      `${what} costs gas, ${
        facilitatorUrl ? 'the facilitator does not sponsor it, ' : ''
      }and ${evm.account.address} holds no ETH to pay for it. Send it a little ETH, or use a ` +
        (what.includes('Permit2')
          ? 'facilitator that sponsors Permit2 approvals.'
          : 'facilitator.')
    );
  }

  private requireReader(evm: EvmPayerConfig): ContractReader {
    if (!evm.reader) {
      throw new ConfigError('this payer has no EVM reader to read the token with');
    }
    return evm.reader;
  }

  private requireWallet(evm: EvmPayerConfig): EvmWalletAccess {
    if (!evm.wallet) {
      throw new ConfigError("paying a deposit's gas from this wallet needs its EVM chain access");
    }
    return evm.wallet;
  }

  // ─── Solana ──────────────────────────────────────────────────────────────

  /**
   * Open a channel the receiving connector sponsors: the connector pays the fee
   * and the rent, and the payer needs no SOL at all.
   *
   * The sponsor key is the one THIS connector published — the offer is read off
   * its own `GET /ilp` — so the refusal of any other sponsor that
   * {@link buildSponsoredOpen} enforces holds by construction here.
   */
  private async solanaOnboard(
    solana: SolanaPayerConfig,
    offer: BatchSettlementSvmOffer,
    charge: bigint
  ): Promise<BatchChannel> {
    const { sponsorEndpoint, minDeposit, feePayer, tokenProgram } = offer.extra;
    if (!sponsorEndpoint) {
      throw new ConfigError(
        `the connector's Solana batch-settlement offer names no sponsorEndpoint to open a channel through`
      );
    }
    const payer = base58Encode(solana.signer.publicKey);
    const floor = minDeposit !== undefined ? BigInt(minDeposit) : 0n;
    const deposit = [this.config.deposit, charge, floor].reduce((a, b) =>
      a > b ? a : b
    );

    // x402 SVM spec §4.1: the client confirms the token program against the
    // mint's on-chain owner rather than trusting the offer.
    const mintOwner = await accountOwner(solana.rpc, offer.asset);
    if (mintOwner !== tokenProgram) {
      throw new ConfigError(
        `mint ${offer.asset} is owned by ${mintOwner ?? 'nothing'}, not the offer's tokenProgram ${tokenProgram}`
      );
    }
    const ata = deriveAssociatedTokenAccount(payer, offer.asset);
    const balance = await getTokenAccountBalance(solana.rpc, ata);
    if (balance === null) {
      throw new InsufficientBalanceError(
        `${payer} has no token account for ${offer.asset} (${ata}); the channel's deposit is drawn from it, and it must exist before the connector will sponsor an open`
      );
    }
    if (balance < deposit) {
      throw new InsufficientBalanceError(
        `${payer} holds ${balance} of ${offer.asset}; a sponsored open deposits ${deposit}`
      );
    }

    const [openSlot, recentBlockhash] = await Promise.all([
      currentSlot(solana.rpc),
      getLatestBlockhash(solana.rpc),
    ]);
    const config = buildSvmBatchChannelConfig({ payer, offer, openSlot });
    const { transaction, channelId } = buildSponsoredOpen({
      payer: solana.signer,
      config,
      offer,
      connectorSponsor: feePayer,
      deposit,
      recentBlockhash,
    });
    const channel: BatchChannel = {
      chain: 'solana',
      channelId,
      network: offer.network,
      sponsor: feePayer,
      config,
    };

    const manager = this.config.manager;
    manager.adoptPending(this.config.connector, channel, deposit);
    let opened;
    try {
      opened = await requestSponsoredOpen({
        connector: this.config.connector,
        sponsorEndpoint,
        transaction,
        ...(this.config.fetch ? { fetchImpl: this.config.fetch } : {}),
      });
    } catch (err) {
      if (isDefinitiveRefusal(err)) manager.abandon(channelId);
      throw err;
    }
    if (opened.channelId !== channelId) {
      // Left pending: the chain, not the sponsor's word, decides whether ours exists.
      throw new ValidationError(
        `the sponsor reports opening ${opened.channelId}, not the channel ${channelId} the payer signed for`
      );
    }
    manager.confirmDeposit(channelId, deposit);
    return channel;
  }

  // ─── Keys and rules ──────────────────────────────────────────────────────

  private requireEvm(): EvmPayerConfig {
    if (!this.config.evm) {
      throw new ConfigError(
        'this client holds no EVM key to pay a batch-settlement channel with'
      );
    }
    return this.config.evm;
  }

  private requireSolana(): SolanaPayerConfig {
    if (!this.config.solana) {
      throw new ConfigError(
        'this client holds no Solana key to pay a batch-settlement channel with'
      );
    }
    return this.config.solana;
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
    return err.reason !== 'unreadable_response' && err.reason !== 'settlement_pending';
  if (err instanceof SponsorRefusedError) return err.status !== 502;
  return false;
}

/** The program that owns `address`, or `null` when there is no such account. */
async function accountOwner(
  rpc: SolanaRpcTarget,
  address: string
): Promise<string | null> {
  const result = (await solanaRpc(rpc, 'getAccountInfo', [
    address,
    { encoding: 'base64', commitment: 'confirmed' },
  ])) as { value: { owner: string } | null };
  return result.value?.owner ?? null;
}

/**
 * The cluster's current confirmed slot: the channel's `open_slot`, which the
 * program refuses once it is more than 1,500 slots old.
 */
async function currentSlot(rpc: SolanaRpcTarget): Promise<bigint> {
  const slot = (await solanaRpc(rpc, 'getSlot', [
    { commitment: 'confirmed' },
  ])) as number;
  return BigInt(slot);
}

/** A facilitator's Permit2-allowance refusal, explained; any other error as it was. */
function explainPermit2(
  err: unknown,
  offer: BatchSettlementEvmOffer,
  evm: { account: { address: string } }
): unknown {
  if (err instanceof FacilitatorError && err.reason.includes('permit2_allowance')) {
    return new FacilitatorError(
      `${offer.asset} has no Permit2 allowance from ${evm.account.address}. A Permit2 ` +
        'deposit needs a one-time `approve(Permit2, …)` from the payer, which costs ' +
        'native gas unless the facilitator sponsors it; hold a little ETH, use a ' +
        'facilitator that sponsors approvals, or use a token with ERC-3009.',
      err.reason,
      err
    );
  }
  return err;
}

/**
 * Whether a failed facilitator call leaves the deposit for the payer to send
 * itself: the facilitator did not answer, answered with something that is not
 * a settle result (a 500 — x402's "no facilitator registered for this scheme
 * and network"), or said it cannot handle this kind of deposit. A refusal of
 * the deposit itself (a balance, a voucher, a deadline) would fail on chain
 * just the same, and `settlement_pending` means the facilitator's own
 * transaction may yet land.
 */
function facilitatorCannotHandle(err: unknown): boolean {
  if (err instanceof NetworkError) return true;
  if (!(err instanceof FacilitatorError)) return false;
  return err.reason === 'unreadable_response' || err.reason.startsWith('unsupported_');
}

/** Whether the payer holds any ETH; an unreadable balance counts as none. */
async function holdsEth(wallet: EvmWalletAccess | undefined): Promise<boolean> {
  if (!wallet) return false;
  try {
    return (await wallet.getBalance()) > 0n;
  } catch {
    return false;
  }
}
