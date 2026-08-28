/**
 * Multi-chain balance-proof claim verification — the client's Solana signer
 * against the connector's own verifier, reimplemented here from the Rust.
 *
 * **Solana** signs the 96-byte `TOON-BALPROOF-V2` balance-proof message of
 * connector ADR 0053 (`tag(16) || programId(32) || channelAccount(32) ||
 * nonce(8 LE) || transferredAmount(8 LE)`, un-hashed), which is exactly what
 * `connector-signer`'s `verify_solana_balance_proof` reconstructs off chain and
 * what the deployed program's Ed25519-precompile check byte-compares on chain.
 * One signature satisfies both, and the checks below are the client-side gate
 * that it does.
 *
 * The message used to be 48 bytes — account, nonce, amount — and bound nothing
 * about which deployment the channel lived on, so a signature was valid for its
 * channel account on any cluster where that account existed. The program id is
 * now inside the signed bytes, and "a proof does not verify under another
 * program" is asserted below rather than left as prose.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { hexToBytes } from 'viem';
import { base58Decode } from '../utils/base58.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import type { DerivedIdentity } from '../keys/types.js';
import { deriveFullIdentity } from '../keys/KeyDerivation.js';
import { SolanaSigner } from './solana-signer.js';
import { buildBalanceProofMessage } from '../channel/solana/payment-channel.js';
import type { ChainMetadata, SolanaClaimMessage } from './types.js';

// A valid BIP-39 phrase (the well-known Hardhat dev mnemonic).
const MNEMONIC = 'test test test test test test test test test test test junk';

/** A valid base58 32-byte Solana address standing in for the channel PDA. */
const SOLANA_CHANNEL_PDA = 'GfHq2tTVk9z4eXgZ8nWz3vWqkXBQ8K9aBcDeFgHiJkLm';
/** The deployed public-devnet payment-channel program. */
const PROGRAM_ID = '2aEVJ8koKD8LTZrLRSGtAtU7LBt4e7QjjCgf1kzQ7Rip';
/** Any OTHER program — a different deployment of the same code. */
const OTHER_PROGRAM_ID = 'HY4AYFNe5Vg5BkEwAURNsGY3uFAvGMNpAQPRtgoasJiR';
const RECIPIENT = 'CounterpartySettlementAddr111111111111111111';
const AMOUNT = 1000n;
const NONCE = 1;

/**
 * Connector-parity Solana balance-proof verifier — the TypeScript twin of
 * `connector-signer`'s `verify_solana_balance_proof`: rebuild the 96-byte
 * message from the domain the VERIFIER knows (never from the claim's own
 * fields) and Ed25519-verify against the base58 signer pubkey.
 */
function verifySolanaPaymentChannelSig(
  programId: string,
  channelPDA: string,
  nonce: number,
  transferredAmount: bigint,
  signatureBase64: string,
  signerPublicKeyBase58: string
): boolean {
  const message = buildBalanceProofMessage(
    programId,
    channelPDA,
    BigInt(nonce),
    transferredAmount
  );
  const sig = Uint8Array.from(Buffer.from(signatureBase64, 'base64'));
  const pubkey = base58Decode(signerPublicKeyBase58);
  try {
    return ed25519.verify(sig, message, pubkey);
  } catch {
    return false;
  }
}

describe('multi-chain balance-proof claims verify against the connector oracle', () => {
  let identity: DerivedIdentity;
  const metadata: ChainMetadata = {
    chainType: 'solana',
    programId: PROGRAM_ID,
  };

  beforeAll(async () => {
    identity = await deriveFullIdentity(MNEMONIC);
  });

  function signerFor(): SolanaSigner {
    return new SolanaSigner(
      identity.solana.secretKey.slice(0, 32),
      identity.solana.publicKey
    );
  }

  async function signedClaim(
    overrides: Partial<{ metadata: ChainMetadata; cluster: string }> = {}
  ): Promise<{ claim: SolanaClaimMessage; signatureHex: string }> {
    const signer = signerFor();
    const proof = await signer.signBalanceProof({
      channelId: SOLANA_CHANNEL_PDA,
      nonce: NONCE,
      transferredAmount: AMOUNT,
      lockedAmount: 0n,
      locksRoot: '0x00',
      recipient: RECIPIENT,
      metadata: overrides.metadata ?? metadata,
    });
    const claim = signer.buildClaimMessage(
      proof,
      'sender-pubkey',
      overrides.cluster ? { cluster: overrides.cluster } : undefined
    ) as SolanaClaimMessage;
    return { claim, signatureHex: proof.signature };
  }

  describe('Solana (Ed25519)', () => {
    it('produces a payment-channel signature the connector verifier accepts', async () => {
      expect(identity.solana.publicKey).not.toBe('');
      const { claim, signatureHex } = await signedClaim();

      expect(claim.channelAccount).toBe(SOLANA_CHANNEL_PDA);
      expect(claim.signerPublicKey).toBe(identity.solana.publicKey);
      expect(claim.programId).toBe(PROGRAM_ID);
      // 64-byte Ed25519 sig -> 88-char base64 (with padding).
      expect(Buffer.from(claim.signature, 'base64').length).toBe(64);

      expect(
        verifySolanaPaymentChannelSig(
          claim.programId,
          claim.channelAccount,
          claim.nonce,
          BigInt(claim.transferredAmount),
          claim.signature,
          claim.signerPublicKey
        )
      ).toBe(true);

      // Sanity: the raw hex signature is valid over the same 96 bytes.
      const message = buildBalanceProofMessage(
        PROGRAM_ID,
        SOLANA_CHANNEL_PDA,
        BigInt(NONCE),
        AMOUNT
      );
      expect(message.length).toBe(96);
      expect(
        ed25519.verify(
          hexToBytes(signatureHex as `0x${string}`),
          message,
          base58Decode(identity.solana.publicKey)
        )
      ).toBe(true);
    });

    it('signs under the metadata program id, not the claim id — ADR 0053', async () => {
      // The whole point of putting the program id in the signed bytes: the
      // same channel account, nonce and amount, verified against a DIFFERENT
      // deployment, must fail. Before ADR 0053 this passed, and that is the
      // cross-deployment replay the 96-byte message closes.
      const { claim } = await signedClaim();

      expect(
        verifySolanaPaymentChannelSig(
          OTHER_PROGRAM_ID,
          claim.channelAccount,
          claim.nonce,
          BigInt(claim.transferredAmount),
          claim.signature,
          claim.signerPublicKey
        )
      ).toBe(false);

      // ...and a proof signed FOR that other deployment does verify there —
      // so the failure above is the binding, not a broken signer.
      const { claim: other } = await signedClaim({
        metadata: { chainType: 'solana', programId: OTHER_PROGRAM_ID },
      });
      expect(other.programId).toBe(OTHER_PROGRAM_ID);
      expect(
        verifySolanaPaymentChannelSig(
          OTHER_PROGRAM_ID,
          other.channelAccount,
          other.nonce,
          BigInt(other.transferredAmount),
          other.signature,
          other.signerPublicKey
        )
      ).toBe(true);
      expect(other.signature).not.toBe(claim.signature);
    });

    it('carries the cluster only when one is supplied', async () => {
      const { claim: bare } = await signedClaim();
      expect('cluster' in bare).toBe(false);

      const { claim: hinted } = await signedClaim({ cluster: 'solana:devnet' });
      expect(hinted.cluster).toBe('solana:devnet');
      // The hint is outside the signature by construction — same bytes signed.
      expect(hinted.signature).toBe(bare.signature);
    });

    it('rejects a tampered amount / nonce / channel', async () => {
      const { claim } = await signedClaim();

      // tampered amount
      expect(
        verifySolanaPaymentChannelSig(
          claim.programId,
          claim.channelAccount,
          claim.nonce,
          AMOUNT + 1n,
          claim.signature,
          claim.signerPublicKey
        )
      ).toBe(false);

      // tampered nonce
      expect(
        verifySolanaPaymentChannelSig(
          claim.programId,
          claim.channelAccount,
          claim.nonce + 1,
          BigInt(claim.transferredAmount),
          claim.signature,
          claim.signerPublicKey
        )
      ).toBe(false);

      // tampered channel PDA
      expect(
        verifySolanaPaymentChannelSig(
          claim.programId,
          'So11111111111111111111111111111111111111112',
          claim.nonce,
          BigInt(claim.transferredAmount),
          claim.signature,
          claim.signerPublicKey
        )
      ).toBe(false);
    });

    it('refuses to sign under an EVM domain', async () => {
      const signer = signerFor();
      await expect(
        signer.signBalanceProof({
          channelId: SOLANA_CHANNEL_PDA,
          nonce: NONCE,
          transferredAmount: AMOUNT,
          lockedAmount: 0n,
          locksRoot: '0x00',
          recipient: RECIPIENT,
          metadata: {
            chainType: 'evm',
            chainId: 84532,
            tokenNetworkAddress: '0x'.padEnd(42, '1'),
          },
        })
      ).rejects.toThrow(/cannot sign for chain type/);
    });
  });
});
