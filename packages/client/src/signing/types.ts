import type { SignedBalanceProof } from '../client/types.js';
import type { EVMClaimMessage } from './evm-signer.js';

/**
 * The domain a claim is signed under, per chain.
 *
 * This is the part a signature commits to *besides* the numbers, and it is what
 * stops a claim being replayed somewhere else. On EVM the chain id and the
 * `TokenNetwork` ride in the EIP-712 domain separator; on Solana the settlement
 * program id is bound into the signed message itself (connector ADR 0053), so a
 * claim signed for one deployment cannot be redeemed at another.
 *
 * The connector never takes these from the claim. It rebuilds them from its own
 * record of the channel, so a claim has no say in what it is checked against —
 * which is why signing under the wrong domain fails to verify rather than
 * quietly succeeding.
 */
export type ChainMetadata =
  | {
      chainType: 'evm';
      chainId: number;
      /** The `TokenNetwork` — the EIP-712 `verifyingContract`. */
      tokenNetworkAddress: string;
      tokenAddress?: string;
    }
  | {
      chainType: 'solana';
      /** The settlement program the channel account lives under. */
      programId: string;
      tokenMint?: string;
      /** The cluster this claim declares. Cross-checked, never trusted. */
      cluster?: string;
    };

/** Signing a balance proof, without the caller knowing which chain it is. */
export interface ChainSigner {
  readonly chainType: 'evm' | 'solana';
  readonly signerIdentifier: string;
  signBalanceProof(params: {
    channelId: string;
    nonce: number;
    transferredAmount: bigint;
    lockedAmount: bigint;
    locksRoot: string;
    /**
     * The counterparty this proof is bound to.
     *
     * Neither chain's signed message folds it in — which side gets paid is fixed
     * by the channel's own participants — so it is carried only so it reaches
     * {@link ChainSigner.buildClaimMessage}.
     */
    recipient: string;
    metadata: ChainMetadata;
  }): Promise<SignedBalanceProof>;
  buildClaimMessage(proof: SignedBalanceProof, senderId: string): ClaimMessage;
}

export type ClaimMessage = EVMClaimMessage | SolanaClaimMessage;

/**
 * A Solana payment-channel claim, exactly as the connector's `parse_solana`
 * reads it (`client-edge-spec.md` §1.3).
 *
 * `nonce` is a JSON **number** while `transferredAmount` is a decimal
 * **string** — an inconsistency of the wire, not of this type: an amount past
 * 2^53 is a real figure and a JSON number would round it.
 */
export interface SolanaClaimMessage {
  version: '1.0';
  blockchain: 'solana';
  messageId: string;
  timestamp: string;
  senderId: string;
  /** The channel's PDA (base58). */
  channelAccount: string;
  nonce: number;
  /** Cumulative, in the mint's base units. */
  transferredAmount: string;
  /** Base64 of the 64-byte Ed25519 signature over the balance-proof message. */
  signature: string;
  /** Base58 Ed25519 public key of the signer. Rides the wire; carries no authority. */
  signerPublicKey: string;
  /**
   * The settlement program the `channelAccount` lives under — the same 32 bytes
   * the signature covers. Not a free-form label: a claim naming any other
   * program names a program no channel of the payer's lives under.
   */
  programId: string;
  /**
   * The cluster this claim is for.
   *
   * Optional, and the one field naming a chain that no signature can bind — a
   * Solana program cannot learn which cluster it runs on, so it can never
   * rebuild a message containing one. The connector compares it against the
   * cluster it settles on and refuses a mismatch outright, because a claim
   * naming a chain the connector is not on is wrong, not merely unverifiable.
   */
  cluster?: string;
}
