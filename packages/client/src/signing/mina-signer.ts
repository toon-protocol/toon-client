import { hexToMinaBase58PrivateKey } from '@toon-protocol/core';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { SignedBalanceProof } from '../types.js';
import type {
  ChainSigner,
  ChainMetadata,
  ClaimMessage,
  MinaClaimMessage,
} from './types.js';
import { buildMinaPaymentChannelProof } from '../channel/mina-payment-channel.js';

/** Default Mina token id when the metadata omits one. */
const DEFAULT_MINA_TOKEN_ID = 'MINA';

/** Mina network id carried in the claim (matches the connector devnet prefix). */
const MINA_CLAIM_NETWORK = 'devnet' as const;

/**
 * Pallas base-field-safe salt derived from `(zkAppAddress, nonce)`.
 *
 * The commitment binds an arbitrary salt; we derive it deterministically so the
 * same (channel, nonce) reproduces the same proof, and take the first 240 bits
 * of `sha256` to stay safely inside the Pallas field (< 2^254). Non-zero by
 * construction (connector `validateMinaClaim` requires a non-empty `salt`).
 */
function deriveMinaSalt(zkAppAddress: string, nonce: number): bigint {
  const digestHex = bytesToHex(
    sha256(new TextEncoder().encode(`mina-pc-salt:${zkAppAddress}:${nonce}`))
  );
  const salt = BigInt('0x' + digestHex.slice(0, 60));
  return salt === 0n ? 1n : salt;
}

/**
 * Mina (Pallas) signer for the connector payment-channel claim path.
 *
 * Produces the connector 3.9.0 `MinaClaimMessage` contract — `{ zkAppAddress,
 * tokenId, balanceCommitment, proof (base64), salt, nonce }` — by reproducing
 * `MinaPaymentChannelSDK.signBalanceProof` exactly (via
 * {@link buildMinaPaymentChannelProof}):
 *
 *   commitment       = Poseidon([Field(balanceA), Field(0), Field(salt)])
 *   channelHashField = Poseidon([PublicKey.fromBase58(zkAppAddress).x])
 *   proof            = base64(JSON{ commitment, signature: { r, s }, nonce, signerPublicKey })
 *
 * with the Schnorr signature computed over `[commitment, Field(nonce),
 * channelHashField]` using the Mina `'devnet'` network id (matching o1js's
 * hardcoded `Signature.create` prefix). Verified field-by-field against the
 * connector's o1js `Signature.fromJSON({r,s}).verify` (see the package tests).
 *
 * NOTE: this is a DIFFERENT message + format from the Mill ↔ sender swap-claim
 * wire contract (`balanceProofFieldsMina` in `@toon-protocol/core`, verified by
 * the SDK's `verifyMinaSignature`). The client here pays a payment-channel claim
 * to the apex, so it signs the connector's on-chain payment-channel scheme; the
 * swap-format hash is left untouched (mirrors the Solana #105 separation).
 *
 * `channelId` MUST be the deployed payment-channel zkApp B62 address (the same
 * address the apex's Mina provider resolves on-chain via `getChannelState`),
 * which is what `OnChainChannelClient.openMinaChannel` returns.
 *
 * `mina-signer` is an OPTIONAL dependency: its crypto (Poseidon, Pallas Schnorr,
 * the base58 signature codec) is loaded dynamically so the client builds and runs
 * for non-Mina users without it installed, and WITHOUT pulling the o1js WASM
 * circuit runtime.
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
   *   `identity.mina.publicKey`). When omitted it is derived during signing.
   */
  constructor(privateKey: string, publicKeyBase58?: string) {
    this.privateKey = privateKey;
    this.publicKeyBase58 = publicKeyBase58;
  }

  get signerIdentifier(): string {
    return this.publicKeyBase58 ?? 'uninitialized';
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

    // The zkApp address IS the channel id: it is the channel-hash preimage the
    // connector binds the proof to and the on-chain account it reads. Prefer the
    // negotiated channelId, fall back to the metadata zkAppAddress.
    const zkAppAddress = params.channelId || params.metadata.zkAppAddress;
    if (!zkAppAddress) {
      throw new Error(
        'MinaSigner requires a zkAppAddress (channel id) to sign a balance proof'
      );
    }

    const minaPrivateKey = hexToMinaBase58PrivateKey(this.privateKey);
    const tokenId = params.metadata.tokenId ?? DEFAULT_MINA_TOKEN_ID;
    const salt = deriveMinaSalt(zkAppAddress, params.nonce);

    const built = await buildMinaPaymentChannelProof({
      zkAppAddress,
      minaPrivateKeyBase58: minaPrivateKey,
      signerPublicKey: this.publicKeyBase58,
      // Recipient-credit (unidirectional): party A carries the cumulative amount,
      // party B is zero. `balanceB`/`signatureB` are OPTIONAL at connector
      // validation, so the single-party claim suffices for the apex-as-recipient
      // direction.
      balanceA: params.transferredAmount,
      balanceB: 0n,
      salt,
      nonce: BigInt(params.nonce),
    });
    this.publicKeyBase58 = built.signerPublicKey;

    return {
      channelId: zkAppAddress,
      nonce: params.nonce,
      transferredAmount: params.transferredAmount,
      lockedAmount: params.lockedAmount,
      locksRoot: params.locksRoot,
      // `signature` is unused on the Mina wire (the proof carries the Schnorr
      // signature); keep the base64 proof here too for symmetry / debugging.
      signature: built.proof,
      signerAddress: built.signerPublicKey,
      chainId: 0,
      tokenNetworkAddress: zkAppAddress,
      recipient: params.recipient,
      mina: {
        balanceCommitment: built.balanceCommitment,
        proof: built.proof,
        salt: built.salt,
        tokenId,
      },
    };
  }

  buildClaimMessage(proof: SignedBalanceProof, senderId: string): ClaimMessage {
    if (!proof.mina) {
      throw new Error(
        'MinaSigner.buildClaimMessage requires a Mina-signed proof (missing `mina` fields)'
      );
    }
    const claim: MinaClaimMessage = {
      version: '1.0',
      blockchain: 'mina',
      messageId: crypto.randomUUID(),
      timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z'),
      senderId,
      zkAppAddress: proof.channelId,
      tokenId: proof.mina.tokenId,
      balanceCommitment: proof.mina.balanceCommitment,
      nonce: proof.nonce,
      proof: proof.mina.proof,
      salt: proof.mina.salt,
      transferredAmount: proof.transferredAmount.toString(),
      network: MINA_CLAIM_NETWORK,
    };
    return claim;
  }
}
