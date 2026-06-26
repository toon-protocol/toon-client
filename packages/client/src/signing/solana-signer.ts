import { ed25519 } from '@noble/curves/ed25519.js';
import { base58Encode } from '@toon-protocol/core';
import type { SignedBalanceProof } from '../types.js';
import type {
  ChainSigner,
  ChainMetadata,
  ClaimMessage,
  SolanaClaimMessage,
} from './types.js';
import { toHex as bytesToHex } from '../utils/binary.js';
import { buildBalanceProofMessage } from '../channel/solana-payment-channel.js';

/**
 * Solana signer for the connector payment-channel claim path.
 *
 * Signs the connector's on-chain payment-channel balance-proof message — the
 * raw 48-byte `channel_pda(32) || nonce(8 LE) || transferredAmount(8 LE)` (see
 * `@toon-protocol/connector` `SolanaPaymentChannelSDK._buildBalanceProofMessage`
 * + `solana-payment-channel-provider.verifyBalanceProof`). The produced 64-byte
 * Ed25519 signature verifies on the connector's `verifySolanaClaim` path, which
 * is what makes a client-issued Solana payment-channel claim (paying the apex
 * to write) acceptable on connector 3.9.0.
 *
 * NOTE: this is a DIFFERENT message from the swap peer ↔ sender swap-claim wire
 * contract (`balanceProofHashSolana`, SDK `verifyEd25519Signature`). The client
 * here is paying a payment-channel claim to the apex, not issuing a swap claim,
 * so it must sign the connector's on-chain payment-channel message. `channelId`
 * MUST be the base58 channel PDA (produced by `OnChainChannelClient.openChannel`).
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

    const base58 = this.ensurePublicKey();

    // Connector on-chain payment-channel balance-proof message:
    //   channel_pda(32) || nonce(8 LE) || transferredAmount(8 LE)
    // `channelId` is the base58 channel PDA (from OnChainChannelClient.openChannel).
    // cumulativeAmount == transferredAmount. No recipient term — the connector's
    // verifyBalanceProof reconstructs exactly these three fields.
    const message = buildBalanceProofMessage(
      params.channelId,
      BigInt(params.nonce),
      params.transferredAmount
    );

    const signature = ed25519.sign(message, this.privateKey);
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
    // The connector verifies a base64 Ed25519 signature; the signed proof carries
    // a 0x-prefixed 64-byte hex signature, so convert hex -> bytes -> base64.
    const sigHex = proof.signature.startsWith('0x')
      ? proof.signature.slice(2)
      : proof.signature;
    const sigBytes = Uint8Array.from(
      sigHex.match(/.{1,2}/g)?.map((b) => parseInt(b, 16)) ?? []
    );
    const signatureBase64 = Buffer.from(sigBytes).toString('base64');

    const claim: SolanaClaimMessage = {
      version: '1.0',
      blockchain: 'solana',
      messageId: crypto.randomUUID(),
      timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z'),
      senderId,
      // channelId IS the base58 channel PDA -> connector's channelAccount.
      channelAccount: proof.channelId,
      nonce: proof.nonce,
      transferredAmount: proof.transferredAmount.toString(),
      signature: signatureBase64,
      signerPublicKey: this.pubkeyBase58Cache ?? proof.signerAddress,
      programId: proof.tokenNetworkAddress,
    };
    return claim;
  }
}
