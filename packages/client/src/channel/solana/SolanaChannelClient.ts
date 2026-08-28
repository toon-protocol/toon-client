/**
 * The Solana half of the channel lifecycle, as one object.
 *
 * `payment-channel.ts` below is deliberately a bag of pure functions: it is what
 * the wire vectors and the on-chain lifecycle suite are checked against, and
 * free functions are what those can call without standing up a client. This
 * class is the other half of that split — the per-channel state a caller would
 * otherwise thread through every call by hand (which RPC, which program, which
 * mint, whose key), bound once so a chain-agnostic caller can say `open`,
 * `deposit`, `close`, `settle` without knowing any of it.
 *
 * Nothing here re-implements the wire. Every method delegates to the builders in
 * `./payment-channel.js`, which are the single definition of what the program
 * accepts.
 */

import {
  claimFromSolanaChannel,
  closeSolanaChannel,
  depositSolanaChannel,
  deriveAssociatedTokenAccount,
  deriveChannelPDA,
  deriveVaultPDA,
  getChannelAccountState,
  openSolanaChannel,
  settleSolanaChannel,
  settleableAt,
  type SolanaChannelAccountState,
} from './payment-channel.js';
import type { ChainMetadata } from '../../signing/types.js';

export interface SolanaChannelClientConfig {
  rpcUrl: string;
  /** The settlement program. Bound into every balance proof (ADR 0053). */
  programId: string;
  /** The SPL mint this client settles in — part of the channel PDA's seeds. */
  tokenMint: string;
  /** This client's 32-byte Ed25519 seed. Signs opens, deposits and proofs. */
  payerSeed: Uint8Array;
  /** This client's base58 pubkey. */
  payerPubkey: string;
  /**
   * Challenge-period seconds a channel this client OPENS is created with.
   * Defaults to an hour, matching the EVM side's floor: the window is the
   * counterparty's chance to redeem a newer proof before settlement divides the
   * vault, so a zero here would hand the closer a free race.
   */
  challengeDuration?: bigint;
  /**
   * The cluster this client's claims declare. A routing hint the connector
   * cross-checks against its own RPC, never a security boundary — a Solana
   * program cannot learn which cluster it runs on, so no signature can bind it.
   */
  cluster?: string;
}

/** An on-chain channel plus the two figures a caller actually acts on. */
export interface SolanaChannelState extends SolanaChannelAccountState {
  /** This client's own collateral — what bounds its claims, not the vault. */
  ownDeposit: bigint;
  /** This client's own on-chain nonce watermark. The next claim must exceed it. */
  ownNonce: bigint;
  /** Unix seconds `settle` becomes legal; `undefined` unless closed. */
  settleableAt?: bigint;
}

const DEFAULT_CHALLENGE_DURATION = 3600n;

export class SolanaChannelClient {
  constructor(private readonly config: SolanaChannelClientConfig) {}

  /**
   * The channel PDA for a counterparty — the claim's `channelAccount`, and the
   * account the connector reads. Deterministic from the pair and the mint, and
   * order-independent: the program sorts participants, so both sides derive the
   * same address without agreeing on who opened it.
   */
  channelId(counterparty: string): string {
    return deriveChannelPDA(
      this.config.payerPubkey,
      counterparty,
      this.config.tokenMint,
      this.config.programId
    ).pda;
  }

  /** The vault the deposits sit in, for a given channel. */
  vaultId(channelPDA: string): string {
    return deriveVaultPDA(channelPDA, this.config.programId).pda;
  }

  /**
   * The domain a claim on this deployment is signed under. Handed to
   * `SolanaSigner.signBalanceProof` so the program id in the signed bytes comes
   * from configuration rather than from anything a claim declares.
   */
  claimMetadata(): ChainMetadata {
    return {
      chainType: 'solana',
      programId: this.config.programId,
      tokenMint: this.config.tokenMint,
      ...(this.config.cluster ? { cluster: this.config.cluster } : {}),
    };
  }

  /**
   * Open the channel to `counterparty` and bring its collateral to `deposit`.
   *
   * Idempotent in the only sense that matters: an existing channel is never
   * re-initialized, but it IS topped up — so the outcome, "an open channel
   * holding `deposit`", is the same either way. A channel this client has
   * already CLOSED is returned untouched, since the program refuses a deposit
   * on one.
   */
  async open(params: {
    counterparty: string;
    deposit?: bigint;
    /** The funded token account collateral is pulled from; defaults to the ATA. */
    payerTokenAccount?: string;
  }): Promise<{
    channelId: string;
    opened: boolean;
    depositTotal?: bigint;
  }> {
    const deposit =
      params.deposit && params.deposit > 0n
        ? {
            amount: params.deposit,
            payerTokenAccount:
              params.payerTokenAccount ?? this.ownTokenAccount(),
          }
        : undefined;

    const result = await openSolanaChannel({
      rpcUrl: this.config.rpcUrl,
      programId: this.config.programId,
      tokenMint: this.config.tokenMint,
      payerSeed: this.config.payerSeed,
      payerPubkey: this.config.payerPubkey,
      peerPubkey: params.counterparty,
      challengeDuration:
        this.config.challengeDuration ?? DEFAULT_CHALLENGE_DURATION,
      ...(deposit ? { deposit } : {}),
    });

    return {
      channelId: result.channelPDA,
      opened: result.opened,
      ...(result.depositTotal !== undefined
        ? { depositTotal: result.depositTotal }
        : {}),
    };
  }

  /** Add collateral to an existing channel. Incremental, not a target. */
  async deposit(
    channelId: string,
    amount: bigint,
    payerTokenAccount?: string
  ): Promise<{ txSignature: string }> {
    const { depositTxSignature } = await depositSolanaChannel({
      rpcUrl: this.config.rpcUrl,
      programId: this.config.programId,
      channelPDA: channelId,
      payerSeed: this.config.payerSeed,
      payerPubkey: this.config.payerPubkey,
      payerTokenAccount: payerTokenAccount ?? this.ownTokenAccount(),
      amount,
    });
    return { txSignature: depositTxSignature };
  }

  /**
   * Close the channel, starting the challenge period. The channel is still
   * claimable while it runs — that is what the period is for.
   */
  async close(
    channelId: string
  ): Promise<{ txSignature: string; settleableAt?: bigint }> {
    const { closeTxSignature } = await closeSolanaChannel({
      rpcUrl: this.config.rpcUrl,
      programId: this.config.programId,
      channelPDA: channelId,
      closerSeed: this.config.payerSeed,
      closerPubkey: this.config.payerPubkey,
    });
    const after = await this.read(channelId);
    return {
      txSignature: closeTxSignature,
      ...(after.settleableAt !== undefined
        ? { settleableAt: after.settleableAt }
        : {}),
    };
  }

  /**
   * Settle a closed channel whose challenge period has elapsed, paying each
   * side `deposit − sent + received` and reclaiming the accounts' rent.
   *
   * Payout destinations default to each participant's ATA for the channel's
   * mint. The program checks that each destination it pays into is owned by
   * that participant and holds this mint, so supplying the wrong one is refused
   * on chain rather than misdelivered.
   */
  async settle(
    channelId: string,
    options: {
      force?: boolean;
      participantATokenAccount?: string;
      participantBTokenAccount?: string;
    } = {}
  ): Promise<{ txSignature: string }> {
    const account = await this.read(channelId);
    if (!account.exists) {
      throw new Error(
        `Solana channel ${channelId} does not exist on chain — a settled channel's ` +
          `account is zeroed by the program, so it cannot be settled twice.`
      );
    }
    const mint = account.tokenMint ?? this.config.tokenMint;
    const { settleTxSignature } = await settleSolanaChannel({
      rpcUrl: this.config.rpcUrl,
      programId: this.config.programId,
      channelPDA: channelId,
      callerSeed: this.config.payerSeed,
      callerPubkey: this.config.payerPubkey,
      participantATokenAccount:
        options.participantATokenAccount ??
        deriveAssociatedTokenAccount(account.participantA ?? '', mint),
      participantBTokenAccount:
        options.participantBTokenAccount ??
        deriveAssociatedTokenAccount(account.participantB ?? '', mint),
      ...(options.force ? { force: true } : {}),
    });
    return { txSignature: settleTxSignature };
  }

  /**
   * Redeem a counterparty's signed balance proof — the receive side. The
   * counterparty never co-signs; its authorization is the proof itself.
   */
  async redeem(params: {
    channelId: string;
    claimer: string;
    nonce: bigint;
    transferredAmount: bigint;
    signature: Uint8Array;
  }): Promise<{ txSignature: string }> {
    const { claimTxSignature } = await claimFromSolanaChannel({
      rpcUrl: this.config.rpcUrl,
      programId: this.config.programId,
      channelPDA: params.channelId,
      claimerPubkey: params.claimer,
      feePayerPubkey: this.config.payerPubkey,
      feePayerSeed: this.config.payerSeed,
      nonce: params.nonce,
      transferredAmount: params.transferredAmount,
      signature: params.signature,
    });
    return { txSignature: claimTxSignature };
  }

  /**
   * Read the channel, with THIS client's side of it resolved.
   *
   * Participants are stored sorted on chain, so which slot is "ours" is a
   * lexicographic fact about the two keys. Resolving it here is the difference
   * between reading our own collateral and reading the counterparty's — and the
   * program bounds a claim by the CLAIMER's own deposit, so getting it wrong
   * reads an amply-funded vault as our own headroom.
   */
  async read(channelId: string): Promise<SolanaChannelState> {
    const account = await getChannelAccountState(this.config.rpcUrl, channelId);
    const weAreA = account.participantA === this.config.payerPubkey;
    const deadline = settleableAt(account);
    return {
      ...account,
      ownDeposit: (weAreA ? account.depositA : account.depositB) ?? 0n,
      ownNonce: (weAreA ? account.nonceA : account.nonceB) ?? 0n,
      ...(deadline !== undefined ? { settleableAt: deadline } : {}),
    };
  }

  /** This client's associated token account for the configured mint. */
  private ownTokenAccount(): string {
    return deriveAssociatedTokenAccount(
      this.config.payerPubkey,
      this.config.tokenMint
    );
  }
}
