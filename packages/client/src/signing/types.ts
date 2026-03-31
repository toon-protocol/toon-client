import type { SignedBalanceProof } from '../types.js';
import type { EVMClaimMessage } from './evm-signer.js';

/**
 * Chain-specific metadata (discriminated union).
 */
export type ChainMetadata =
  | { chainType: 'evm'; chainId: number; tokenNetworkAddress: string; tokenAddress?: string }
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
    metadata: ChainMetadata;
  }): Promise<SignedBalanceProof>;
  buildClaimMessage(proof: SignedBalanceProof, senderId: string): ClaimMessage;
}

export type ClaimMessage = EVMClaimMessage | SolanaClaimMessage | MinaClaimMessage;

export interface SolanaClaimMessage {
  version: '1.0';
  blockchain: 'solana';
  messageId: string;
  timestamp: string;
  senderId: string;
  channelId: string;
  nonce: number;
  transferredAmount: string;
  signature: string;
  signerAddress: string;
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
  zkAppAddress: string;
}
