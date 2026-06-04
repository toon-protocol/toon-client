import {
  balanceProofFieldsMina,
  hexToMinaBase58PrivateKey,
} from '@toon-protocol/core';
import type { SignedBalanceProof } from '../types.js';
import type {
  ChainSigner,
  ChainMetadata,
  ClaimMessage,
  MinaClaimMessage,
} from './types.js';

/**
 * Network id the Mill signs / the SDK verifies with
 * (`MinaPaymentChannelSigner` + `verifyMinaSignature` use `'mainnet'`). For the
 * `signFields`/`verifyFields` path the network id only affects message-string
 * hashing, not pre-hashed field arrays, but we keep it aligned for clarity.
 */
const MINA_NETWORK = 'mainnet';

/**
 * Minimal structural type for the slice of the `mina-signer` `Client` we use.
 */
interface MinaSignerClientLike {
  signFields(fields: bigint[], privateKey: string): { signature: unknown };
  derivePublicKey(privateKey: string): string;
}
type MinaSignerClientCtor = new (opts: {
  network: string;
}) => MinaSignerClientLike;

/**
 * Mina (Pallas) signer for balance proofs.
 *
 * Signs the CANONICAL Mina field-element message
 * (`balanceProofFieldsMina(channelId, cumulativeAmount, nonce, recipient)` from
 * `@toon-protocol/core`) via `mina-signer`'s `signFields`, emitting the base58
 * Schnorr signature string — byte-for-byte identical to the Mill's
 * `MinaPaymentChannelSigner` and verifiable by the SDK's `verifyMinaSignature`.
 *
 * `mina-signer` is an OPTIONAL dependency: it is imported dynamically so the
 * client builds and runs for non-Mina users without it installed.
 */
export class MinaSigner implements ChainSigner {
  readonly chainType = 'mina' as const;
  /** Big-endian hex scalar (or already-`EK…` base58) Mina private key. */
  private readonly privateKey: string;
  private publicKeyBase58?: string;

  /**
   * @param privateKey - Mina private key as big-endian hex scalar (the form
   *   `deriveFullIdentity()` emits, `identity.mina.privateKey`) or an `EK…`
   *   base58 key. Converted to the base58check form mina-signer requires.
   * @param publicKeyBase58 - Optional base58 public key (e.g.
   *   `identity.mina.publicKey`). When omitted it is derived lazily.
   */
  constructor(privateKey: string, publicKeyBase58?: string) {
    this.privateKey = privateKey;
    this.publicKeyBase58 = publicKeyBase58;
  }

  get signerIdentifier(): string {
    return this.publicKeyBase58 ?? 'uninitialized';
  }

  private async loadClient(): Promise<MinaSignerClientLike> {
    // `mina-signer` is an optional peer dep — dynamic specifier so the package
    // type-checks and runs without it installed.
    const specifier = 'mina-signer';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lib: any = await import(/* @vite-ignore */ specifier);
    const Ctor: MinaSignerClientCtor = 'default' in lib ? lib.default : lib;
    return new Ctor({ network: MINA_NETWORK });
  }

  private async ensurePublicKey(client: MinaSignerClientLike): Promise<string> {
    if (this.publicKeyBase58) return this.publicKeyBase58;
    const minaPrivateKey = hexToMinaBase58PrivateKey(this.privateKey);
    this.publicKeyBase58 = client.derivePublicKey(minaPrivateKey);
    return this.publicKeyBase58;
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
    if (params.metadata.chainType !== 'mina') {
      throw new Error(
        `MinaSigner cannot sign for chain type: ${params.metadata.chainType}`
      );
    }
    if (!params.recipient) {
      throw new Error(
        'MinaSigner requires a recipient (counterparty settlement address) to sign a balance proof'
      );
    }

    const client = await this.loadClient();
    const publicKey = await this.ensurePublicKey(client);

    // Canonical Mina field-element message (shared with Mill signer + SDK
    // verifier via @toon-protocol/core). cumulativeAmount == transferredAmount.
    const fields = balanceProofFieldsMina(
      params.channelId,
      params.transferredAmount,
      BigInt(params.nonce),
      params.recipient
    );

    // `deriveFullIdentity()` emits a big-endian hex scalar; mina-signer needs a
    // Mina base58check (`EK…`) private key. Convert before signing.
    const minaPrivateKey = hexToMinaBase58PrivateKey(this.privateKey);
    const signed = client.signFields(fields, minaPrivateKey);
    const sigStr =
      typeof signed.signature === 'string'
        ? signed.signature
        : JSON.stringify(signed.signature);

    return {
      channelId: params.channelId,
      nonce: params.nonce,
      transferredAmount: params.transferredAmount,
      lockedAmount: params.lockedAmount,
      locksRoot: params.locksRoot,
      signature: sigStr,
      signerAddress: publicKey,
      chainId: 0,
      tokenNetworkAddress: params.metadata.zkAppAddress,
      recipient: params.recipient,
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
      recipient: proof.recipient ?? '',
      zkAppAddress: proof.tokenNetworkAddress,
    };
    return claim;
  }
}
