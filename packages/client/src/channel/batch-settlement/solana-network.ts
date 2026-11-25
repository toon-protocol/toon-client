/**
 * The Solana settlement network: solana-foundation's `payment-channels`
 * program on a `solana:` network (connector ADR 0074; toon-client#690).
 *
 * It opens a channel the receiving connector sponsors — the connector pays the
 * fee and the rent, and the payer needs no SOL at all — and, because that
 * sponsor opens channels and nothing else, covers a charge its deposit cannot
 * by replacing the channel with a fresh sponsored one (ADR 0003).
 *
 * It leaves a channel with the payer's own `request_close`, which moves it to
 * Closing; after `grace_period` anyone may `seal` it, and `withdraw_payer`
 * returns `deposit − settled` to the payer's token account. A channel the
 * connector sealed first needs no close of ours.
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
  buildAndSendTransaction,
  deriveAssociatedTokenAccount,
  getLamports,
  getLatestBlockhash,
  getTokenAccountBalance,
  solanaRpc,
  type RawInstruction,
  type Signer,
  type SolanaRpcTarget,
} from '../solana/payment-channel.js';
import {
  PAYMENT_CHANNELS_PROGRAM_ID,
  buildSponsoredOpen,
  buildSvmBatchChannelConfig,
  getSvmBatchChannel,
  signSvmVoucher,
  type BatchSettlementSvmOffer,
  type SvmBatchChannelConfig,
  type SvmBatchChannelState,
} from './svm.js';
import { requestSponsoredOpen } from './sponsor.js';
import { solanaVoucherClaim } from './claim.js';
import { signSolanaChallenge } from './challenge.js';
import { offerFromTerms, type BatchSettlementTerms } from './offers.js';
import type { BatchChannel } from './manager.js';
import {
  requireExitGas,
  type ChannelStoredForm,
  type CloseOutcome,
  type Cover,
  type OpenAmounts,
  type PlannedOpen,
  type SettleOutcome,
  type SettlementNetwork,
} from './settlement-network.js';

type SolanaChannel = Extract<BatchChannel, { chain: 'solana' }>;

/**
 * A Solana channel in the channel record: its network, the connector's sponsor
 * key, and its config, with the u64 salt and open slot as decimal strings. A
 * PDA cannot be recomputed without them.
 */
export const solanaStoredForm: ChannelStoredForm = {
  serves: (network) => network.startsWith('solana:'),
  toStored(channel) {
    const solana = asSolanaChannel(channel);
    return {
      chain: 'solana',
      network: solana.network,
      sponsor: solana.sponsor,
      config: {
        ...solana.config,
        salt: solana.config.salt.toString(),
        openSlot: solana.config.openSlot.toString(),
      },
    };
  },
  fromStored(channelId, stored) {
    if (stored.chain !== 'solana') {
      throw new ConfigError(
        `channel ${channelId} is stored on ${stored.network}, not a Solana network`
      );
    }
    return {
      chain: 'solana',
      channelId,
      network: stored.network,
      sponsor: stored.sponsor,
      config: {
        ...stored.config,
        salt: BigInt(stored.config.salt),
        openSlot: BigInt(stored.config.openSlot),
      },
    };
  },
};

function asSolanaChannel(channel: BatchChannel): SolanaChannel {
  if (channel.chain !== 'solana') {
    throw new ConfigError(
      `channel ${channel.channelId} is on ${channel.network}, not a Solana network`
    );
  }
  return channel;
}

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

  readonly serves = solanaStoredForm.serves;
  readonly toStored = solanaStoredForm.toStored;
  readonly fromStored = solanaStoredForm.fromStored;

  constructor(private readonly config: SolanaSettlementNetworkConfig) {}

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

  /**
   * The payer's `request_close`: from here the channel accepts no new voucher,
   * and the connector lands its latest one with `settle_and_seal` before the
   * grace period ends. A channel already closing or sealed — by the connector,
   * or by an earlier run — needs no transaction.
   */
  async close(channel: BatchChannel, now: bigint): Promise<CloseOutcome> {
    const { rpc, signer } = this.config;
    const state = await getSvmBatchChannel(rpc, channel.channelId);
    if (state === null || isRefunded(state)) return { kind: 'done' };
    if (state.status !== 'open') {
      return {
        kind: 'closing',
        settleableAt:
          state.status === 'sealed'
            ? now
            : state.closureStartedAt + BigInt(state.gracePeriod),
      };
    }
    await this.requireSol('close');
    const started = await requestSvmBatchClose(
      rpc,
      signer,
      channel.channelId,
      now
    );
    return {
      kind: 'closing',
      transaction: started.transaction,
      settleableAt: started.settleableAt,
    };
  }

  /**
   * `seal` and `withdraw_payer` once the grace period has passed — or, with
   * no close of ours, as soon as the connector sealed the channel itself.
   */
  async settle(
    channel: BatchChannel,
    when: { due: boolean; now: bigint }
  ): Promise<SettleOutcome> {
    const { rpc, signer } = this.config;
    const solana = asSolanaChannel(channel);
    const state = await getSvmBatchChannel(rpc, solana.channelId);
    // Gone, or already refunded — `distribute` pays the payer too — is done.
    if (state === null || isRefunded(state)) return { kind: 'settled' };
    if (!when.due && state.status !== 'sealed') return { kind: 'not-yet' };
    await this.requireSol('settle');
    const { transaction } = await withdrawSvmBatchChannel(
      rpc,
      signer,
      solana.channelId,
      solana.config,
      when.now
    );
    return { kind: 'settled', transaction };
  }

  private async requireSol(step: 'close' | 'settle'): Promise<void> {
    const payer = base58Encode(this.config.signer.publicKey);
    await requireExitGas(
      'SOL',
      payer,
      getLamports(this.config.rpc, payer),
      step
    );
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

/** Whether a channel's deposit is already back with the payer. */
function isRefunded(state: SvmBatchChannelState): boolean {
  return state.payerWithdrawnAt !== 0n || state.status === 'distributed';
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

// ---------------------------------------------------------------------------
// Leaving a channel
// ---------------------------------------------------------------------------

const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const IX_REQUEST_CLOSE = 5;
const IX_SEAL = 6;
const IX_WITHDRAW_PAYER = 8;

/** `request_close` (5): the payer starts the grace period. */
export function buildSvmRequestCloseInstruction(
  channelId: string,
  payer: string
): RawInstruction {
  return {
    programId: PAYMENT_CHANNELS_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: false },
      { pubkey: channelId, isSigner: false, isWritable: true },
    ],
    data: new Uint8Array([IX_REQUEST_CLOSE]),
  };
}

/** `seal` (6): permissionless, once the grace period has elapsed. */
export function buildSvmSealInstruction(channelId: string): RawInstruction {
  return {
    programId: PAYMENT_CHANNELS_PROGRAM_ID,
    keys: [{ pubkey: channelId, isSigner: false, isWritable: true }],
    data: new Uint8Array([IX_SEAL]),
  };
}

/** `withdraw_payer` (8): `deposit − settled` back to the payer, from a Sealed channel. */
export function buildSvmWithdrawPayerInstruction(
  channelId: string,
  config: Pick<SvmBatchChannelConfig, 'payer' | 'token'>
): RawInstruction {
  return {
    programId: PAYMENT_CHANNELS_PROGRAM_ID,
    keys: [
      { pubkey: config.payer, isSigner: true, isWritable: false },
      { pubkey: channelId, isSigner: false, isWritable: true },
      {
        pubkey: deriveAssociatedTokenAccount(channelId, config.token),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: deriveAssociatedTokenAccount(config.payer, config.token),
        isSigner: false,
        isWritable: true,
      },
      { pubkey: config.token, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: new Uint8Array([IX_WITHDRAW_PAYER]),
  };
}

/**
 * The payer's `request_close` of an Open channel. It can be settled from
 * `settleableAt`: `now` plus the channel's grace period.
 */
export async function requestSvmBatchClose(
  rpc: SolanaRpcTarget,
  payer: Signer,
  channelId: string,
  now = BigInt(Math.floor(Date.now() / 1000))
): Promise<{ transaction: string; settleableAt: bigint }> {
  const state = await getSvmBatchChannel(rpc, channelId);
  if (state === null)
    throw new ValidationError(`channel ${channelId} does not exist`);
  if (state.status !== 'open') {
    throw new ValidationError(
      `channel ${channelId} is ${state.status}, not open`
    );
  }
  const transaction = await buildAndSendTransaction(rpc, payer, [
    buildSvmRequestCloseInstruction(channelId, base58Encode(payer.publicKey)),
  ]);
  return { transaction, settleableAt: now + BigInt(state.gracePeriod) };
}

/**
 * Take the unspent deposit back: `seal` a Closing channel whose grace period
 * has passed (unless the connector already sealed it), then `withdraw_payer`,
 * in one transaction.
 */
export async function withdrawSvmBatchChannel(
  rpc: SolanaRpcTarget,
  payer: Signer,
  channelId: string,
  config: Pick<SvmBatchChannelConfig, 'payer' | 'token'>,
  now = BigInt(Math.floor(Date.now() / 1000))
): Promise<{ transaction: string }> {
  const state = await getSvmBatchChannel(rpc, channelId);
  if (state === null)
    throw new ValidationError(`channel ${channelId} does not exist`);
  if (state.payerWithdrawnAt !== 0n) {
    throw new ValidationError(
      `channel ${channelId}'s deposit was already withdrawn`
    );
  }
  const instructions: RawInstruction[] = [];
  if (state.status === 'closing') {
    const deadline = state.closureStartedAt + BigInt(state.gracePeriod);
    if (now < deadline) {
      throw new ValidationError(
        `channel ${channelId} can be sealed at ${deadline} (unix seconds), not yet`
      );
    }
    instructions.push(buildSvmSealInstruction(channelId));
  } else if (state.status !== 'sealed') {
    throw new ValidationError(
      `channel ${channelId} is ${state.status}; request its close first`
    );
  }
  instructions.push(buildSvmWithdrawPayerInstruction(channelId, config));
  return {
    transaction: await buildAndSendTransaction(rpc, payer, instructions),
  };
}
