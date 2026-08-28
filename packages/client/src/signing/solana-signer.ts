import { ed25519 } from '@noble/curves/ed25519.js';
import { base58Encode, base58Decode } from '../utils/base58.js';
import type { SignedBalanceProof } from '../client/types.js';
import type {
  ChainSigner,
  ChainMetadata,
  ClaimMessage,
  SolanaClaimMessage,
} from './types.js';
import { toHex as bytesToHex } from '../utils/binary.js';
import { buildBalanceProofMessage } from '../channel/solana/payment-channel.js';

/**
 * Solana signer for the connector payment-channel claim path.
 *
 * Signs the **96-byte** `TOON-BALPROOF-V2` balance-proof message of connector
 * ADR 0053 — `tag(16) || programId(32) || channelAccount(32) || nonce(8 LE) ||
 * transferredAmount(8 LE)` (see {@link buildBalanceProofMessage} for the layout
 * and for why the program id is in it). The same 96 bytes are what the
 * connector's `verify_solana_balance_proof` reconstructs off chain and what the
 * deployed program's Ed25519-precompile check byte-compares on chain, so one
 * signature satisfies both.
 *
 * The program id is taken from {@link ChainMetadata}, never from the caller's
 * claim fields: the connector rebuilds the domain from its OWN record of the
 * channel, so signing under anything but the program the channel actually lives
 * under fails to verify rather than quietly succeeding.
 *
 * The predecessor of this message was 48 bytes and bound no deployment at all.
 * It is gone, not deprecated: the deployed program refuses a 48-byte message on
 * length, so nothing would be gained by keeping a path that can only produce
 * unredeemable claims.
 *
 * `channelId` MUST be the base58 channel PDA.
 */
/** {@link SolanaSigner.signClaimStateChallenge}'s tag (client-edge-spec.md §1.10). */
const CLAIM_STATE_CHALLENGE_TAG = new TextEncoder().encode(
  'toon-claim-state-challenge-v1'
);

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

    // The ADR 0053 balance-proof message:
    //   "TOON-BALPROOF-V2" || programId(32) || channelAccount(32)
    //     || nonce(8 LE) || transferredAmount(8 LE)
    // `channelId` is the base58 channel PDA; `cumulativeAmount` IS
    // `transferredAmount`. There is no recipient term — which side gets paid is
    // fixed by the channel's own participants, so folding it in would bind
    // nothing the chain does not already know.
    const message = buildBalanceProofMessage(
      params.metadata.programId,
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

  /**
   * Signs a `POST /ilp/claim-state` claim-state challenge (client-edge-spec.md
   * §1.10): `"toon-claim-state-challenge-v1" || channelAccount(32) ||
   * expires(u64 LE)` — 69 bytes, and a different tag, so it is distinct in both
   * content and length from the 96-byte balance-proof message: a captured
   * challenge can never be replayed as a payment or vice versa. Returns base64 (the
   * connector's documented wire encoding for this endpoint, unlike the
   * hex-encoded balance-proof signature elsewhere in this class).
   *
   * @param params.expires - Unix seconds the signature stops verifying.
   */
  async signClaimStateChallenge(params: {
    channelAccount: string;
    expires: number;
  }): Promise<string> {
    const accountBytes = base58Decode(params.channelAccount);
    if (accountBytes.length !== 32) {
      throw new Error(
        `channelAccount must decode to 32 bytes, got ${accountBytes.length}`
      );
    }
    const tag = CLAIM_STATE_CHALLENGE_TAG;
    const message = new Uint8Array(tag.length + 32 + 8);
    message.set(tag, 0);
    message.set(accountBytes, tag.length);
    new DataView(message.buffer).setBigUint64(
      tag.length + 32,
      BigInt(params.expires),
      true // little-endian
    );

    const signature = ed25519.sign(message, this.privateKey);
    return Buffer.from(signature).toString('base64');
  }

  /**
   * @param options.cluster - The cluster this claim declares (`solana:devnet`,
   *   …). Optional, and the one field naming a chain that no signature can
   *   bind — a Solana program cannot learn which cluster it runs on, so it can
   *   never rebuild a message containing one. The connector compares it against
   *   the cluster it settles on and refuses a mismatch, which closes the
   *   honest-misconfiguration case; the forgery case is closed by the
   *   `programId` inside the signed bytes. Omitted from the JSON entirely when
   *   not supplied, rather than sent empty: an absent hint and a hint saying
   *   `""` are not the same claim.
   */
  buildClaimMessage(
    proof: SignedBalanceProof,
    senderId: string,
    options?: { cluster?: string }
  ): ClaimMessage {
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
      ...(options?.cluster ? { cluster: options.cluster } : {}),
    };
    return claim;
  }
}
