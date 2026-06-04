import type { SignedBalanceProof } from '../types.js';
import type { EVMClaimMessage } from './evm-signer.js';

/**
 * Chain-specific metadata (discriminated union).
 */
export type ChainMetadata =
  | {
      chainType: 'evm';
      chainId: number;
      tokenNetworkAddress: string;
      tokenAddress?: string;
    }
  | { chainType: 'solana'; programId: string; tokenMint?: string }
  | { chainType: 'mina'; zkAppAddress: string; tokenId?: string };

/**
 * Chain-agnostic signing interface for balance proofs.
 */
export interface ChainSigner {
  readonly chainType: 'evm' | 'solana' | 'mina';
  readonly signerIdentifier: string;
  signBalanceProof(params: {
    channelId: string;
    nonce: number;
    transferredAmount: bigint;
    lockedAmount: bigint;
    locksRoot: string;
    /**
     * Counterparty settlement address the proof is bound to. Required for
     * Solana/Mina (folded into the canonical balance-proof message); the EVM
     * adapter ignores it (EIP-712 has no recipient term).
     */
    recipient: string;
    metadata: ChainMetadata;
  }): Promise<SignedBalanceProof>;
  buildClaimMessage(proof: SignedBalanceProof, senderId: string): ClaimMessage;
}

export type ClaimMessage =
  | EVMClaimMessage
  | SolanaClaimMessage
  | MinaClaimMessage;

/**
 * Solana payment-channel claim — wire-compatible with the connector's
 * `SolanaClaimMessage` (`@toon-protocol/connector` `btp/btp-claim-types.ts`).
 * Field names match the connector's `validateSolanaClaim` exactly:
 * `channelAccount` (base58 PDA), `signerPublicKey` (base58), base64 `signature`.
 */
export interface SolanaClaimMessage {
  version: '1.0';
  blockchain: 'solana';
  messageId: string;
  timestamp: string;
  senderId: string;
  /** On-chain PDA account address for the payment channel (base58). */
  channelAccount: string;
  nonce: number;
  /** Cumulative transferred amount (string for bigint precision). */
  transferredAmount: string;
  /** Ed25519 signature over the 48-byte balance-proof message (base64). */
  signature: string;
  /** Base58-encoded Ed25519 public key of the signer. */
  signerPublicKey: string;
  /** Solana program id for the payment-channel program (base58). */
  programId: string;
}

export interface MinaClaimMessage {
  version: '1.0';
  blockchain: 'mina';
  messageId: string;
  timestamp: string;
  senderId: string;
  channelId: string;
  nonce: number;
  transferredAmount: string;
  commitment: string;
  signerAddress: string;
  /** Counterparty settlement address the signature is bound to (base58). */
  recipient: string;
  zkAppAddress: string;
}
