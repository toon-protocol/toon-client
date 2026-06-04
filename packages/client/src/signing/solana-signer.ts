import { ed25519 } from '@noble/curves/ed25519.js';
import { balanceProofHashSolana, base58Encode } from '@toon-protocol/core';
import type { SignedBalanceProof } from '../types.js';
import type {
  ChainSigner,
  ChainMetadata,
  ClaimMessage,
  SolanaClaimMessage,
} from './types.js';
import { toHex as bytesToHex } from '../utils/binary.js';

/**
 * Solana signer for Ed25519 balance proofs.
 *
 * Signs the CANONICAL Solana balance-proof message
 * (`balanceProofHashSolana(channelId, cumulativeAmount, nonce, recipient)` from
 * `@toon-protocol/core`) so the produced 64-byte Ed25519 signature is verifiable
 * by the connector / SDK's `verifyEd25519Signature` — byte-for-byte identical to
 * the Mill's `SolanaPaymentChannelSigner`. This is what makes a client-issued
 * Solana claim acceptable on-network (the previous plaintext `channelId:nonce:…`
 * format was not).
 */
export class SolanaSigner implements ChainSigner {
  readonly chainType = 'solana' as const;
  /** 32-byte Ed25519 seed. */
  private readonly privateKey: Uint8Array;
  private pubkeyBase58Cache?: string;

  /**
   * @param privateKey - 32-byte Ed25519 seed (e.g. `identity.solana.secretKey.slice(0, 32)`).
   * @param publicKeyBase58 - Optional base58 public key (e.g. `identity.solana.publicKey`).
   *   When omitted it is derived lazily from `privateKey`.
   */
  constructor(privateKey: Uint8Array, publicKeyBase58?: string) {
    if (privateKey.length !== 32) {
      throw new Error(
        `SolanaSigner requires a 32-byte Ed25519 seed, got ${privateKey.length} bytes`
      );
    }
    this.privateKey = privateKey;
    this.pubkeyBase58Cache = publicKeyBase58;
  }

  private ensurePublicKey(): string {
    if (this.pubkeyBase58Cache) return this.pubkeyBase58Cache;
    const pk = ed25519.getPublicKey(this.privateKey);
    this.pubkeyBase58Cache = base58Encode(new Uint8Array(pk));
    return this.pubkeyBase58Cache;
  }

  get signerIdentifier(): string {
    return this.pubkeyBase58Cache ?? 'uninitialized';
  }

  async signBalanceProof(params: {
    channelId: string;
    nonce: number;
    transferredAmount: bigint;
    lockedAmount: bigint;
    locksRoot: string;
    recipient: string;
    metadata: ChainMetadata;
  }): Promise<SignedBalanceProof> {
    if (params.metadata.chainType !== 'solana') {
      throw new Error(
        `SolanaSigner cannot sign for chain type: ${params.metadata.chainType}`
      );
    }
    if (!params.recipient) {
      throw new Error(
        'SolanaSigner requires a recipient (counterparty settlement address) to sign a balance proof'
      );
    }

    const base58 = this.ensurePublicKey();

    // Canonical Solana balance-proof message (shared with Mill signer + SDK
    // verifier via @toon-protocol/core). cumulativeAmount == transferredAmount.
    const msgHash = balanceProofHashSolana(
      params.channelId,
      params.transferredAmount,
      BigInt(params.nonce),
      params.recipient
    );

    const signature = ed25519.sign(msgHash, this.privateKey);
    const signatureHex = '0x' + bytesToHex(new Uint8Array(signature));

    return {
      channelId: params.channelId,
      nonce: params.nonce,
      transferredAmount: params.transferredAmount,
      lockedAmount: params.lockedAmount,
      locksRoot: params.locksRoot,
      signature: signatureHex,
      signerAddress: base58,
      chainId: 0,
      tokenNetworkAddress: params.metadata.programId,
      recipient: params.recipient,
    };
  }

  buildClaimMessage(proof: SignedBalanceProof, senderId: string): ClaimMessage {
    const claim: SolanaClaimMessage = {
      version: '1.0',
      blockchain: 'solana',
      messageId: crypto.randomUUID(),
      timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z'),
      senderId,
      channelId: proof.channelId,
      nonce: proof.nonce,
      transferredAmount: proof.transferredAmount.toString(),
      signature: proof.signature,
      signerAddress: this.pubkeyBase58Cache ?? proof.signerAddress,
      recipient: proof.recipient ?? '',
      programId: proof.tokenNetworkAddress,
    };
    return claim;
  }
}
