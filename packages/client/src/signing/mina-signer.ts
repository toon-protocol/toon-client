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
import {
  buildMinaPaymentChannelProof,
  loadMinaPaymentChannelBindings,
} from '../channel/mina-payment-channel.js';
import { readMinaDepositTotal } from '../channel/mina-deposit.js';

/** Reads a channel zkApp's on-chain `depositTotal` (base units). */
export type MinaDepositReader = (zkAppAddress: string) => Promise<bigint>;

/** Optional `MinaSigner` wiring for on-chain `depositTotal` resolution. */
export interface MinaSignerOptions {
  /**
   * Mina GraphQL URL used to read the channel's on-chain `depositTotal` when a
   * caller doesn't supply it to `signBalanceProof`. Enables conserved
   * `balanceB = depositTotal − balanceA` claims (settleable on funded zkApps).
   */
  graphqlUrl?: string;
  /** Inject a deposit reader (tests / custom transport). Overrides `graphqlUrl`. */
  depositReader?: MinaDepositReader;
}

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
 *   channelHashField = Poseidon([participantA.x, participantB.x, 0])   (see below)
 *   proof            = base64(JSON{ commitment, signature: { r, s }, nonce, signerPublicKey })
 *
 * with the Schnorr signature computed over `[commitment, Field(nonce),
 * channelHashField]` using the Mina `'devnet'` network id (matching o1js's
 * hardcoded `Signature.create` prefix). Verified field-by-field against the
 * connector's o1js `Signature.fromJSON({r,s}).verify` (see the package tests).
 *
 * `channelHashField` is the ON-CHAIN participant form
 * (`Poseidon([client.x, apex.x, 0])`, participantA=client, participantB=apex)
 * whenever the apex's Mina pubkey is known (the negotiated `recipient`), so the
 * claim can SETTLE on-chain via the zkApp's `claimFromChannel` (which only
 * verifies the participant form). When the apex pubkey is unavailable the signer
 * falls back to the legacy zkApp-x form (`Poseidon([zkApp.x])`); the connector's
 * off-chain `verifyBalanceProof` accepts EITHER, so off-chain store/FULFILL works
 * in both cases — only on-chain settle requires the participant form.
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
  private readonly depositReader?: MinaDepositReader;
  /** Per-zkApp `depositTotal` cache (deposits are rare; the connector re-reads). */
  private readonly depositCache = new Map<string, bigint>();

  /**
   * @param privateKey - Mina private key as big-endian hex scalar (the form
   *   `deriveFullIdentity()` emits, `identity.mina.privateKey`) or an `EK…`
   *   base58 key. Converted to the base58check form mina-signer requires.
   * @param publicKeyBase58 - Optional base58 public key (e.g.
   *   `identity.mina.publicKey`). When omitted it is derived during signing.
   * @param options - Optional on-chain `depositTotal` resolution (graphqlUrl or
   *   an injected reader) so claims conserve balances on funded zkApps.
   */
  constructor(
    privateKey: string,
    publicKeyBase58?: string,
    options?: MinaSignerOptions
  ) {
    this.privateKey = privateKey;
    this.publicKeyBase58 = publicKeyBase58;
    if (options?.depositReader) {
      this.depositReader = options.depositReader;
    } else if (options?.graphqlUrl) {
      const url = options.graphqlUrl;
      this.depositReader = (zkAppAddress) =>
        readMinaDepositTotal(url, zkAppAddress);
    }
  }

  /**
   * Resolve the channel's on-chain `depositTotal`, caching per zkApp. Returns
   * `undefined` when no reader is configured or the read fails — callers then
   * fall back to the legacy `balanceB = 0` commitment.
   */
  private async resolveDepositTotal(
    zkAppAddress: string
  ): Promise<bigint | undefined> {
    if (this.depositCache.has(zkAppAddress)) {
      return this.depositCache.get(zkAppAddress);
    }
    if (!this.depositReader) return undefined;
    try {
      const depositTotal = await this.depositReader(zkAppAddress);
      this.depositCache.set(zkAppAddress, depositTotal);
      return depositTotal;
    } catch {
      return undefined;
    }
  }

  get signerIdentifier(): string {
    return this.publicKeyBase58 ?? 'uninitialized';
  }

  /** Derive this signer's B62 public key from its (base58) private key. */
  private async deriveOwnPublicKey(
    minaPrivateKeyBase58: string
  ): Promise<string> {
    const { Client } = await loadMinaPaymentChannelBindings();
    return new Client({ network: MINA_CLAIM_NETWORK }).derivePublicKey(
      minaPrivateKeyBase58
    );
  }

  async signBalanceProof(params: {
    channelId: string;
    nonce: number;
    transferredAmount: bigint;
    lockedAmount: bigint;
    locksRoot: string;
    recipient: string;
    metadata: ChainMetadata;
    /**
     * On-chain channel `depositTotal`. When provided (>0), the signed commitment
     * binds `balanceB = depositTotal − balanceA` (the funder's remaining
     * balance), matching the connector's claimFromChannel reconstruction
     * (toon-protocol/connector#133) and the on-chain circuit's
     * `balanceA + balanceB == depositTotal` invariant. Omitted/0 keeps the
     * legacy `balanceB = 0` form (off-chain-store-only, non-settleable).
     */
    depositTotal?: bigint;
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

    // Derive the client's own Mina pubkey now (needed as participantA for the
    // on-chain channelHash). `buildMinaPaymentChannelProof` derives it too, but
    // we need it here to pass the participant pair.
    const clientPubKey =
      this.publicKeyBase58 ?? (await this.deriveOwnPublicKey(minaPrivateKey));
    this.publicKeyBase58 = clientPubKey;

    // The apex's Mina settlement pubkey (B62) is the channel counterparty
    // (participantB). It flows through as the negotiated recipient. When present,
    // sign over the on-chain participant-form channelHash so the claim can SETTLE
    // on-chain (the zkApp's claimFromChannel verifies sigA over
    // Poseidon([client.x, apex.x, 0])). Order matches the open:
    // participantA = client (payer), participantB = apex (peer).
    const apexPubKey =
      params.recipient && /^B62[a-zA-Z0-9]{40,60}$/.test(params.recipient)
        ? params.recipient
        : undefined;

    // Conserved counterparty balance for the signed commitment. The on-chain
    // PaymentChannel.claimFromChannel circuit verifies signatureA over
    // Poseidon([balanceA, balanceB, salt]) AND asserts balanceA + balanceB ==
    // depositTotal. The connector reconstructs balanceB = depositTotal − balanceA
    // from the public on-chain depositTotal (toon-protocol/connector#133), so the
    // CLIENT must sign over that same balanceB or signatureA fails verification
    // ("participant A signature verification failed") at proof generation. When
    // depositTotal is unknown (legacy/off-chain-only), fall back to balanceB = 0.
    // Prefer a caller-supplied depositTotal; otherwise self-resolve it from
    // chain (when this signer was configured with a graphqlUrl / reader) so the
    // claim conserves balances on a FUNDED zkApp. Falls back to balanceB = 0
    // (legacy, off-chain-store-only) when neither is available.
    const depositTotal =
      params.depositTotal ?? (await this.resolveDepositTotal(zkAppAddress));
    let balanceB = 0n;
    if (depositTotal != null && depositTotal > 0n) {
      if (params.transferredAmount > depositTotal) {
        throw new Error(
          `Mina claim balanceA (${params.transferredAmount}) exceeds on-chain ` +
            `depositTotal (${depositTotal}) — cannot conserve balances`
        );
      }
      balanceB = depositTotal - params.transferredAmount;
    }

    const built = await buildMinaPaymentChannelProof({
      zkAppAddress,
      minaPrivateKeyBase58: minaPrivateKey,
      signerPublicKey: clientPubKey,
      // Recipient-credit (unidirectional): party A carries the cumulative amount;
      // party B carries the funder's remaining balance (depositTotal − balanceA)
      // so the signed commitment conserves and the on-chain claimFromChannel
      // signatureA check passes. `signatureB` remains apex-co-signed downstream.
      balanceA: params.transferredAmount,
      balanceB,
      salt,
      nonce: BigInt(params.nonce),
      // Participant-form channelHash (on-chain-settleable) when the apex pubkey
      // is known; otherwise the legacy zkApp-x form (off-chain-store only).
      ...(apexPubKey
        ? { participantA: clientPubKey, participantB: apexPubKey }
        : {}),
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
      // Surface the signer's Mina pubkey top-level (it is also embedded in the
      // base64 `proof`). The connector's SettlementExecutor reads
      // `latestClaim.signerPublicKey` to resolve participant keys for the
      // on-chain claimFromChannel on an inbound/externally-opened channel;
      // without it the Mina SDK throws ACCOUNT_NOT_FOUND. `signerAddress`
      // carries the B62 base58 pubkey for Mina proofs (see MinaSigner.sign*).
      signerPublicKey: proof.signerAddress,
      network: MINA_CLAIM_NETWORK,
    };
    return claim;
  }
}
