/**
 * Paying a connector from an x402 `batch-settlement` channel: the one object
 * {@link ../../client/send.js!send} asks for a voucher instead of a
 * `toon-channel` claim, when the caller opted in (connector ADR 0074,
 * toon-client#689, #690).
 *
 * For each paid packet it:
 *
 *   1. finds the node's `batch-settlement` terms on the chain this client pays
 *      from — none, and it steps aside and the packet pays over `toon-channel`
 *      exactly as it always has;
 *   2. resolves the channel it holds with this node there, or onboards one with
 *      no native gas: on EVM a deposit through an x402 facilitator;
 *   3. tops the channel up the same way when its deposit cannot cover the next
 *      voucher;
 *   4. reserves the next cumulative amount — persisted before anything is
 *      signed — and signs the voucher;
 *   5. hands back the claim, and learns the packet's fate from the caller.
 */

import type { Hex } from 'viem';
import type { NodeSelfDescription } from '../../connector/self-description.js';
import {
  ConfigError,
  FacilitatorError,
  InsufficientBalanceError,
  ValidationError,
} from '../../client/errors.js';
import {
  batchChannelId,
  buildBatchChannelConfig,
  buildEip3009Deposit,
  buildPermit2Deposit,
  evmChainIdOf,
  signBatchVoucher,
  type BatchSettlementEvmOffer,
  type TypedDataSigner,
} from './evm.js';
import { settleDeposit } from './facilitator.js';
import { chooseBatchSettlement, offerFromTerms } from './offers.js';
import { evmVoucherClaim, solanaVoucherClaim } from './claim.js';
import {
  buildSponsoredOpen,
  buildSvmBatchChannelConfig,
  signSvmVoucher,
  type BatchSettlementSvmOffer,
} from './svm.js';
import { requestSponsoredOpen } from './sponsor.js';
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
  | { kind: 'refused'; notAdvancing: boolean };

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
    /** The x402 facilitator that relays deposits and pays their gas. */
    facilitatorUrl?: string;
    /**
     * `eip3009` (the default) for a token with ERC-3009, gasless outright;
     * `permit2` for one without, which needs the payer's one-time Permit2
     * approval first.
     */
    depositMethod?: 'eip3009' | 'permit2';
  };
  solana?: {
    /** The funding wallet; also the channel's `authorized_signer`, which signs vouchers. */
    signer: Signer;
    /** The Solana JSON-RPC to read the slot, the blockhash and the accounts from. */
    rpc: SolanaRpcTarget;
  };
  /** How the connector's sponsor endpoint and the facilitator are reached. */
  fetch?: typeof fetch;
}

/**
 * Whether a voucher's refusal says the connector already holds at least its
 * amount — `amount_not_advancing`, or an underpayment that advanced by
 * nothing (a byte-identical retransmission against a charge) — rather than
 * that nothing was banked. The connector's own sentences
 * (`connector-client-edge`'s `ClaimIngestRejection::message`).
 */
export function voucherRefusalIsNotAdvancing(
  message: string | undefined
): boolean {
  if (message === undefined) return false;
  return (
    message.includes('cumulative amount goes backwards') ||
    /advances value by 0,/.test(message)
  );
}

type EvmPayerConfig = NonNullable<BatchSettlementPayerConfig['evm']>;
type SolanaPayerConfig = NonNullable<BatchSettlementPayerConfig['solana']>;

export class BatchSettlementPayer {
  constructor(private readonly config: BatchSettlementPayerConfig) {
    if (config.deposit <= 0n) {
      throw new ConfigError(
        `a batch-settlement deposit must be positive, got ${config.deposit}`
      );
    }
  }

  /**
   * A voucher for one packet charging `amount` on `chain`, or `undefined` when
   * this node offers no `batch-settlement` there — the packet then pays over
   * `toon-channel`.
   */
  async claimFor(
    description: NodeSelfDescription,
    chain: 'evm' | 'solana',
    amount: bigint
  ): Promise<PreparedVoucher | undefined> {
    const terms = chooseBatchSettlement(description, chain);
    if (terms === undefined) return undefined;
    const priced = offerFromTerms(terms, amount);
    if (priced.chain === 'evm') return this.evmVoucher(priced.offer, amount);
    return this.solanaVoucher(priced.offer, amount);
  }

  private async solanaVoucher(
    offer: BatchSettlementSvmOffer,
    charge: bigint
  ): Promise<PreparedVoucher> {
    const solana = this.config.solana;
    if (!solana) {
      throw new ConfigError(
        'this client holds no Solana key to pay a batch-settlement channel with'
      );
    }
    const manager = this.config.manager;
    let channel = manager.resolve(
      this.config.connector,
      offer.network,
      offer.asset
    );
    // The sponsor endpoint opens channels and nothing else, so a Solana top-up
    // would cost the payer SOL. A channel its deposit cannot cover is instead
    // replaced by a fresh sponsored one, and its binding archived: what little
    // is left in it returns to the payer when the connector closes it.
    if (
      channel === undefined ||
      manager.signedSoFar(channel.channelId) + charge >
        manager.depositTotal(channel.channelId)
    ) {
      channel = await this.solanaOnboard(solana, offer, charge);
    }

    const cumulative = manager.reserve(channel.channelId, charge);
    if (cumulative === undefined) {
      throw new ValidationError(
        'a free route carries no voucher; send it unpaid'
      );
    }
    const channelId = channel.channelId;
    const voucher = signSvmVoucher(solana.signer, channelId, cumulative);
    return {
      chain: 'solana',
      channelId,
      claim: solanaVoucherClaim(voucher, base58Encode(solana.signer.publicKey)),
      cumulative,
      settle: (outcome) => {
        if (outcome.kind === 'refused') {
          manager.refused(channelId, charge, {
            notAdvancing: outcome.notAdvancing,
          });
        }
      },
    };
  }

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

    const opened = await requestSponsoredOpen({
      connector: this.config.connector,
      sponsorEndpoint,
      transaction,
      ...(this.config.fetch ? { fetchImpl: this.config.fetch } : {}),
    });
    if (opened.channelId !== channelId) {
      throw new ValidationError(
        `the sponsor reports opening ${opened.channelId}, not the channel ${channelId} the payer signed for`
      );
    }

    const channel: BatchChannel = {
      chain: 'solana',
      channelId,
      network: offer.network,
      sponsor: feePayer,
      config,
    };
    this.config.manager.adopt(this.config.connector, channel, deposit);
    return channel;
  }

  private async evmVoucher(
    offer: BatchSettlementEvmOffer,
    charge: bigint
  ): Promise<PreparedVoucher> {
    const evm = this.config.evm;
    if (!evm) {
      throw new ConfigError(
        'this client holds no EVM key to pay a batch-settlement channel with'
      );
    }
    const chainId = evmChainIdOf(offer.network);
    const voucherSigner = evm.voucherSigner ?? evm.account;
    const manager = this.config.manager;

    let channel = manager.resolve(
      this.config.connector,
      offer.network,
      offer.asset
    );
    if (channel === undefined) {
      channel = await this.evmOnboard(evm, offer, charge);
    } else if (
      manager.signedSoFar(channel.channelId) + charge >
      manager.depositTotal(channel.channelId)
    ) {
      await this.evmDeposit(
        evm,
        channel,
        offer,
        manager.signedSoFar(channel.channelId) + charge
      );
    }
    if (channel.chain !== 'evm')
      throw new Error('unreachable: an EVM offer resolved a Solana channel');

    const cumulative = manager.reserve(channel.channelId, charge);
    if (cumulative === undefined) {
      throw new ValidationError(
        'a free route carries no voucher; send it unpaid'
      );
    }
    const voucher = await signBatchVoucher(
      voucherSigner,
      chainId,
      channel.channelId as Hex,
      cumulative
    );
    const channelId = channel.channelId;
    return {
      chain: 'evm',
      channelId,
      claim: evmVoucherClaim(voucher, channel.config),
      cumulative,
      settle: (outcome) => {
        if (outcome.kind === 'refused') {
          manager.refused(channelId, charge, {
            notAdvancing: outcome.notAdvancing,
          });
        }
      },
    };
  }

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
    await this.evmSettle(evm, offer, channel, deposit, charge);
    this.config.manager.adopt(this.config.connector, channel, deposit);
    return channel;
  }

  /** Top an existing channel up by the configured deposit, or by enough to cover `needed`. */
  private async evmDeposit(
    evm: EvmPayerConfig,
    channel: BatchChannel,
    offer: BatchSettlementEvmOffer,
    needed: bigint
  ): Promise<void> {
    const manager = this.config.manager;
    const shortfall = needed - manager.depositTotal(channel.channelId);
    const amount =
      this.config.deposit > shortfall ? this.config.deposit : shortfall;
    // The deposit carries the running cumulative: a voucher at or below what
    // the chain has claimed would be refused by the facilitator.
    await this.evmSettle(evm, offer, channel, amount, needed);
    manager.addDeposit(channel.channelId, amount);
  }

  private async evmSettle(
    evm: EvmPayerConfig,
    offer: BatchSettlementEvmOffer,
    channel: BatchChannel,
    amount: bigint,
    voucherAmount: bigint
  ): Promise<void> {
    if (channel.chain !== 'evm') throw new Error('unreachable');
    if (!evm.facilitatorUrl) {
      throw new ConfigError(
        'depositing into a Base batch-settlement channel needs `batchSettlement.facilitatorUrl`: ' +
          'the x402 facilitator that relays the deposit and pays its gas'
      );
    }
    const build =
      evm.depositMethod === 'permit2'
        ? buildPermit2Deposit
        : buildEip3009Deposit;
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
    try {
      await settleDeposit({
        facilitatorUrl: evm.facilitatorUrl,
        offer,
        payload,
        ...(this.config.fetch ? { fetchImpl: this.config.fetch } : {}),
      });
    } catch (err) {
      if (
        err instanceof FacilitatorError &&
        err.reason.includes('permit2_allowance')
      ) {
        throw new FacilitatorError(
          `${offer.asset} has no Permit2 allowance from ${evm.account.address}. A Permit2 ` +
            'deposit needs a one-time `approve(Permit2, …)` from the payer, which costs ' +
            'native gas unless the facilitator sponsors it; approve once, or use a token ' +
            'with ERC-3009 and `depositMethod: "eip3009"`.',
          err.reason,
          err
        );
      }
      throw err;
    }
  }
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
