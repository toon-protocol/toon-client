import type { SignedBalanceProof } from '../types.js';
import type { ChainSigner, ChainMetadata, ClaimMessage, MinaClaimMessage } from './types.js';

/**
 * Mina signer for Poseidon commitment balance proofs.
 *
 * Dynamically imports o1js to avoid pulling 50MB into the client bundle
 * for non-Mina users.
 */
export class MinaSigner implements ChainSigner {
  readonly chainType = 'mina' as const;
  private readonly privateKeyBase58: string;
  private publicKeyBase58: string = 'uninitialized';

  constructor(privateKeyBase58: string) {
    this.privateKeyBase58 = privateKeyBase58;
  }

  get signerIdentifier(): string {
    return this.publicKeyBase58;
  }

  private async ensurePublicKey(): Promise<string> {
    if (this.publicKeyBase58 !== 'uninitialized') return this.publicKeyBase58;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    // @ts-expect-error -- o1js is an optional dependency
    const o1js = await import('o1js') as any;
    const pk = o1js.PrivateKey.fromBase58(this.privateKeyBase58);
    this.publicKeyBase58 = pk.toPublicKey().toBase58();
    return this.publicKeyBase58;
  }

  async signBalanceProof(params: {
    channelId: string;
    nonce: number;
    transferredAmount: bigint;
    lockedAmount: bigint;
    locksRoot: string;
    metadata: ChainMetadata;
  }): Promise<SignedBalanceProof> {
    if (params.metadata.chainType !== 'mina') {
      throw new Error(`MinaSigner cannot sign for chain type: ${params.metadata.chainType}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    // @ts-expect-error -- o1js is an optional dependency
    const o1js = await import('o1js') as any;
    const pubkey = await this.ensurePublicKey();

    // Compute Poseidon commitment over channel state fields
    const channelIdNum = BigInt('0x' + params.channelId.replace(/^0x/, '').slice(0, 16));
    const commitment = o1js.Poseidon.hash([
      o1js.Field(channelIdNum),
      o1js.Field(params.nonce),
      o1js.Field(params.transferredAmount),
      o1js.Field(params.lockedAmount),
    ]);

    // Sign the commitment
    const pk = o1js.PrivateKey.fromBase58(this.privateKeyBase58);
    const signature = o1js.Signature.create(pk, [commitment]);

    return {
      channelId: params.channelId,
      nonce: params.nonce,
      transferredAmount: params.transferredAmount,
      lockedAmount: params.lockedAmount,
      locksRoot: params.locksRoot,
      signature: signature.toBase58(),
      signerAddress: pubkey,
      chainId: 0,
      tokenNetworkAddress: params.metadata.zkAppAddress,
    };
  }

  buildClaimMessage(proof: SignedBalanceProof, senderId: string): ClaimMessage {
    const claim: MinaClaimMessage = {
      version: '1.0',
      blockchain: 'mina',
      messageId: crypto.randomUUID(),
      timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z'),
      senderId,
      channelId: proof.channelId,
      nonce: proof.nonce,
      transferredAmount: proof.transferredAmount.toString(),
      commitment: proof.signature,
      signerAddress: proof.signerAddress,
      zkAppAddress: proof.tokenNetworkAddress,
    };
    return claim;
  }
}
