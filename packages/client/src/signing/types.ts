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

/**
 * Mina payment-channel claim — wire-compatible with the connector's
 * `MinaClaimMessage` (`@toon-protocol/connector` `btp/btp-claim-types.ts`).
 * Field names + types match `validateMinaClaim` exactly: `zkAppAddress`
 * (B62-prefixed 55-char base58, the channel id), `tokenId`, `balanceCommitment`
 * (`Poseidon([balA,balB,salt])` decimal string), integer `nonce`, base64 `proof`,
 * and `salt`. `transferredAmount`/`balanceB`/`signatureB`/`network` are OPTIONAL
 * at validation; the apex-as-recipient single-direction claim sends party-A only.
 */
export interface MinaClaimMessage {
  version: '1.0';
  blockchain: 'mina';
  messageId: string;
  timestamp: string;
  senderId: string;
  /** Deployed payment-channel zkApp address (B62 base58) — the channel id. */
  zkAppAddress: string;
  /** Mina token id (default `'MINA'`). */
  tokenId: string;
  /** `Poseidon([balanceA, balanceB, salt]).toString()`. */
  balanceCommitment: string;
  nonce: number;
  /** base64-encoded JSON `{ commitment, signature: { r, s }, nonce, signerPublicKey }`. */
  proof: string;
  /** Commitment salt (decimal string). */
  salt: string;
  /** Cumulative transferred amount (optional; string for bigint precision). */
  transferredAmount?: string;
  /** Mina network id — defaults to `devnet` connector-side when omitted. */
  network?: 'mainnet' | 'devnet' | 'berkeley' | 'lightnet';
}
