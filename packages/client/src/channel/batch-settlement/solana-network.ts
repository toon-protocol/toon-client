/**
 * The Solana settlement network: solana-foundation's `payment-channels`
 * program on a `solana:` network (connector ADR 0074; toon-client#690).
 *
 * It opens a channel the receiving connector sponsors — the connector pays the
 * fee and the rent, and the payer needs no SOL at all — and, because that
 * sponsor opens channels and nothing else, covers a charge its deposit cannot
 * by replacing the channel with a fresh sponsored one (ADR 0003).
 *
 * Its voucher scheme is ed25519: a voucher signed by the channel's
 * `authorized_signer` over the channel and the cumulative amount, carried as
 * {@link solanaVoucherClaim}, and the claim-state challenge
 * {@link signSolanaChallenge}.
 */

import {
  ConfigError,
  InsufficientBalanceError,
  ValidationError,
} from '../../client/errors.js';
import { base58Encode } from '../../utils/base58.js';
import {
  deriveAssociatedTokenAccount,
  getLatestBlockhash,
  getTokenAccountBalance,
  solanaRpc,
  type Signer,
  type SolanaRpcTarget,
} from '../solana/payment-channel.js';
import {
  buildSponsoredOpen,
  buildSvmBatchChannelConfig,
  getSvmBatchChannel,
  signSvmVoucher,
  type BatchSettlementSvmOffer,
} from './svm.js';
import { requestSponsoredOpen } from './sponsor.js';
import { solanaVoucherClaim } from './claim.js';
import { signSolanaChallenge } from './challenge.js';
import { offerFromTerms, type BatchSettlementTerms } from './offers.js';
import type { BatchChannel } from './manager.js';
import type {
  Cover,
  OpenAmounts,
  PlannedOpen,
  SettlementNetwork,
} from './settlement-network.js';

export interface SolanaSettlementNetworkConfig {
  /** The funding wallet; also the channel's `authorized_signer`, which signs vouchers. */
  signer: Signer;
  /** The Solana JSON-RPC to read the slot, the blockhash and the accounts from. */
  rpc: SolanaRpcTarget;
  /** How the connector's sponsor endpoint is reached. */
  fetch: typeof fetch;
  /** The connector's client-edge URL, which a relative sponsor endpoint resolves against. */
  connector: string;
}

export class SolanaSettlementNetwork implements SettlementNetwork {
  readonly chain = 'solana' as const;
  readonly cover: Cover = {
    kind: 'replace',
    noTopUp:
      'a Solana batch-settlement channel is not topped up: the next payment it cannot cover opens a fresh sponsored one',
  };

  constructor(private readonly config: SolanaSettlementNetworkConfig) {}

  serves(network: string): boolean {
    return network.startsWith('solana:');
  }

  /**
   * A channel the receiving connector sponsors.
   *
   * The sponsor key is the one THIS connector published — the terms are read
   * off its own `GET /ilp` — so the refusal of any other sponsor that
   * {@link buildSponsoredOpen} enforces holds by construction here.
   */
  async open(
    terms: BatchSettlementTerms,
    amounts: OpenAmounts
  ): Promise<PlannedOpen> {
    const offer = this.offer(terms, amounts.charge);
    const { signer, rpc } = this.config;
    const { sponsorEndpoint, minDeposit, feePayer, tokenProgram } = offer.extra;
    if (!sponsorEndpoint) {
      throw new ConfigError(
        `the connector's Solana batch-settlement offer names no sponsorEndpoint to open a channel through`
      );
    }
    const payer = base58Encode(signer.publicKey);
    const floor = minDeposit !== undefined ? BigInt(minDeposit) : 0n;
    const deposit = [amounts.deposit, amounts.charge, floor].reduce((a, b) =>
      a > b ? a : b
    );

    // x402 SVM spec §4.1: the client confirms the token program against the
    // mint's on-chain owner rather than trusting the offer.
    const mintOwner = await accountOwner(rpc, offer.asset);
    if (mintOwner !== tokenProgram) {
      throw new ConfigError(
        `mint ${offer.asset} is owned by ${mintOwner ?? 'nothing'}, not the offer's tokenProgram ${tokenProgram}`
      );
    }
    const ata = deriveAssociatedTokenAccount(payer, offer.asset);
    const balance = await getTokenAccountBalance(rpc, ata);
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
      currentSlot(rpc),
      getLatestBlockhash(rpc),
    ]);
    const config = buildSvmBatchChannelConfig({ payer, offer, openSlot });
    const { transaction, channelId } = buildSponsoredOpen({
      payer: signer,
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
    return {
      channel,
      deposit,
      land: async () => {
        const opened = await requestSponsoredOpen({
          connector: this.config.connector,
          sponsorEndpoint,
          transaction,
          fetchImpl: this.config.fetch,
        });
        if (opened.channelId !== channelId) {
          // Left pending: the chain, not the sponsor's word, decides whether ours exists.
          throw new ValidationError(
            `the sponsor reports opening ${opened.channelId}, not the channel ${channelId} the payer signed for`
          );
        }
      },
    };
  }

  async read(
    channel: BatchChannel
  ): Promise<{ escrow: bigint | undefined; landed: bigint }> {
    const state = await getSvmBatchChannel(this.config.rpc, channel.channelId);
    return { escrow: state?.deposit, landed: state?.settled ?? 0n };
  }

  async voucher(
    channel: BatchChannel,
    cumulative: bigint
  ): Promise<Record<string, unknown>> {
    const { signer } = this.config;
    return solanaVoucherClaim(
      signSvmVoucher(signer, channel.channelId, cumulative),
      base58Encode(signer.publicKey)
    );
  }

  async challenge(
    channel: BatchChannel,
    expires: bigint
  ): Promise<Record<string, unknown>> {
    return signSolanaChallenge(this.config.signer, channel.channelId, expires);
  }

  /** The connector's terms, priced for a charge, as the offer the greeting would carry. */
  private offer(
    terms: BatchSettlementTerms,
    charge: bigint
  ): BatchSettlementSvmOffer {
    const priced = offerFromTerms(terms, charge);
    if (priced.chain !== 'solana') {
      throw new ConfigError(
        `the Solana settlement network cannot pay on ${terms.network}`
      );
    }
    return priced.offer;
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
