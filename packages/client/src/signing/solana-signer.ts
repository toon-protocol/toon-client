import type { SignedBalanceProof } from '../types.js';
import type { ChainSigner, ChainMetadata, ClaimMessage, SolanaClaimMessage } from './types.js';
import { toHex as bytesToHex } from '../utils/binary.js';

/**
 * Base58 encoding for Solana public keys.
 */
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function toBase58(bytes: Uint8Array): string {
  let num = BigInt(0);
  for (const b of bytes) num = num * 256n + BigInt(b);
  let result = '';
  while (num > 0n) {
    result = BASE58_ALPHABET[Number(num % 58n)] + result;
    num = num / 58n;
  }
  for (const b of bytes) {
    if (b === 0) result = '1' + result;
    else break;
  }
  return result;
}

// Lazy-loaded ed25519 module (optional dep — dynamically imported)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _ed25519: any = null;
async function getEd25519() {
  if (!_ed25519) {
    const mod = await import('@noble/curves/ed25519');
    _ed25519 = mod.ed25519;
  }
  return _ed25519;
}

/**
 * Solana signer for Ed25519 balance proofs.
 *
 * Signs channel state using Ed25519 (raw, not EIP-712).
 * Dynamically imports @noble/curves to avoid missing-dep errors for non-Solana users.
 */
export class SolanaSigner implements ChainSigner {
  readonly chainType = 'solana' as const;
  private readonly privateKey: Uint8Array;
  private publicKey?: Uint8Array;
  private pubkeyBase58Cache?: string;

  constructor(privateKey: Uint8Array) {
    this.privateKey = privateKey;
  }

  private async ensurePublicKey(): Promise<{ publicKey: Uint8Array; base58: string }> {
    if (this.publicKey && this.pubkeyBase58Cache) {
      return { publicKey: this.publicKey, base58: this.pubkeyBase58Cache };
    }
    const ed = await getEd25519();
    const pk: Uint8Array = ed.getPublicKey(this.privateKey);
    const b58 = toBase58(pk);
    this.publicKey = pk;
    this.pubkeyBase58Cache = b58;
    return { publicKey: pk, base58: b58 };
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
    metadata: ChainMetadata;
  }): Promise<SignedBalanceProof> {
    if (params.metadata.chainType !== 'solana') {
      throw new Error(`SolanaSigner cannot sign for chain type: ${params.metadata.chainType}`);
    }

    const ed = await getEd25519();
    const { base58 } = await this.ensurePublicKey();

    // Construct message: channelId + nonce + transferredAmount + lockedAmount + locksRoot
    const encoder = new TextEncoder();
    const message = encoder.encode(
      `${params.channelId}:${params.nonce}:${params.transferredAmount}:${params.lockedAmount}:${params.locksRoot}`
    );

    const signature = ed.sign(message, this.privateKey);
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
      programId: proof.tokenNetworkAddress,
    };
    return claim;
  }
}
