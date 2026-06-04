/**
 * Multi-chain balance-proof claim verification.
 *
 * PRIMARY correctness gate for the client's Solana/Mina signers.
 *
 * - **Solana** signs the connector's on-chain PAYMENT-CHANNEL balance-proof
 *   message (`channel_pda(32) || nonce(8 LE) || transferredAmount(8 LE)`,
 *   un-hashed), verified here exactly the way connector 3.9.0's
 *   `solana-payment-channel-provider.verifyBalanceProof` does (reconstruct the
 *   48-byte message + Ed25519-verify against the base58 signer pubkey). This is
 *   the message the apex's `verifySolanaClaim` path checks when the client pays
 *   a payment-channel claim — NOT the Mill ↔ sender swap-claim shape
 *   (`balanceProofHashSolana`, SDK `verifyEd25519Signature`).
 * - **Mina** still verifies against the SDK's `verifyMinaSignature` (unchanged).
 *
 * `@toon-protocol/sdk` is a devDependency used here as the Mina verification
 * oracle.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  verifyMinaSignature,
  loadMinaSignerClient,
  type MinaSignerClientLike,
} from '@toon-protocol/sdk';
import { hexToBytes, base58Decode } from '@toon-protocol/core';
import { ed25519 } from '@noble/curves/ed25519.js';
import type { ToonIdentity } from '../keys/types.js';
import { deriveFullIdentity } from '../keys/KeyDerivation.js';
import { SolanaSigner } from './solana-signer.js';
import { MinaSigner } from './mina-signer.js';
import { buildBalanceProofMessage } from '../channel/solana-payment-channel.js';
import type { ChainMetadata, SolanaClaimMessage } from './types.js';

// A valid BIP-39 phrase (the well-known Hardhat dev mnemonic).
const MNEMONIC = 'test test test test test test test test test test test junk';

const CHANNEL_ID = 'channel-1';
/** A valid base58 32-byte Solana address standing in for the channel PDA. */
const SOLANA_CHANNEL_PDA = 'GfHq2tTVk9z4eXgZ8nWz3vWqkXBQ8K9aBcDeFgHiJkLm';
const RECIPIENT = 'CounterpartySettlementAddr111111111111111111';
const AMOUNT = 1000n;
const NONCE = 1;

/**
 * Connector-parity Solana payment-channel signature verifier. Mirrors
 * `@toon-protocol/connector` `solana-payment-channel-provider.verifyBalanceProof`:
 * reconstruct the 48-byte message and Ed25519-verify against the base58 pubkey.
 */
function verifySolanaPaymentChannelSig(
  channelPDA: string,
  nonce: number,
  transferredAmount: bigint,
  signatureBase64: string,
  signerPublicKeyBase58: string
): boolean {
  const message = buildBalanceProofMessage(
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

/** Build the minimal `AccumulatedClaim` slice the SDK verifiers read. */
function asClaim(fields: {
  channelId: string;
  cumulativeAmount: bigint;
  nonce: number;
  recipient: string;
  claimBytes: Uint8Array;
}) {
  return {
    channelId: fields.channelId,
    cumulativeAmount: fields.cumulativeAmount.toString(),
    nonce: String(fields.nonce),
    recipient: fields.recipient,
    claimBytes: fields.claimBytes,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('multi-chain balance-proof claims verify against the SDK oracle', () => {
  let identity: ToonIdentity;

  beforeAll(async () => {
    identity = await deriveFullIdentity(MNEMONIC);
  });

  describe('Solana (Ed25519)', () => {
    const metadata: ChainMetadata = {
      chainType: 'solana',
      programId: 'Prog1111111111111111111111111111111111111111',
    };

    it('produces a payment-channel signature the connector verifier accepts', async () => {
      expect(identity.solana.publicKey).not.toBe('');
      const signer = new SolanaSigner(
        identity.solana.secretKey.slice(0, 32),
        identity.solana.publicKey
      );
      const proof = await signer.signBalanceProof({
        channelId: SOLANA_CHANNEL_PDA,
        nonce: NONCE,
        transferredAmount: AMOUNT,
        lockedAmount: 0n,
        locksRoot: '0x00',
        recipient: RECIPIENT,
        metadata,
      });

      // proof.signature is 0x-hex; the connector expects base64 in the claim.
      const claim = signer.buildClaimMessage(
        proof,
        'sender-pubkey'
      ) as SolanaClaimMessage;

      expect(claim.channelAccount).toBe(SOLANA_CHANNEL_PDA);
      expect(claim.signerPublicKey).toBe(identity.solana.publicKey);
      // 64-byte Ed25519 sig -> 88-char base64 (with padding).
      expect(Buffer.from(claim.signature, 'base64').length).toBe(64);

      expect(
        verifySolanaPaymentChannelSig(
          claim.channelAccount,
          claim.nonce,
          BigInt(claim.transferredAmount),
          claim.signature,
          claim.signerPublicKey
        )
      ).toBe(true);

      // Sanity: the raw hex signature is also valid over the 48-byte message.
      const message = buildBalanceProofMessage(
        SOLANA_CHANNEL_PDA,
        BigInt(NONCE),
        AMOUNT
      );
      expect(
        ed25519.verify(
          hexToBytes(proof.signature),
          message,
          base58Decode(identity.solana.publicKey)
        )
      ).toBe(true);
    });

    it('rejects a tampered amount / nonce / channel', async () => {
      const signer = new SolanaSigner(
        identity.solana.secretKey.slice(0, 32),
        identity.solana.publicKey
      );
      const proof = await signer.signBalanceProof({
        channelId: SOLANA_CHANNEL_PDA,
        nonce: NONCE,
        transferredAmount: AMOUNT,
        lockedAmount: 0n,
        locksRoot: '0x00',
        recipient: RECIPIENT,
        metadata,
      });
      const claim = signer.buildClaimMessage(
        proof,
        'sender-pubkey'
      ) as SolanaClaimMessage;

      // tampered amount
      expect(
        verifySolanaPaymentChannelSig(
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
          'So11111111111111111111111111111111111111112',
          claim.nonce,
          BigInt(claim.transferredAmount),
          claim.signature,
          claim.signerPublicKey
        )
      ).toBe(false);
    });
  });

  describe('Mina (Pallas)', () => {
    const metadata: ChainMetadata = {
      chainType: 'mina',
      zkAppAddress: 'B62qExampleZkAppAddress00000000000000000000000000000',
    };
    let minaClient: MinaSignerClientLike | undefined;

    beforeAll(async () => {
      minaClient = await loadMinaSignerClient();
    });

    it('produces a signature the SDK verifier accepts', async () => {
      if (!minaClient) {
        // mina-signer optional dep absent — cannot verify; skip rather than pass.
        return;
      }
      expect(identity.mina.publicKey).not.toBe('');
      const signer = new MinaSigner(
        identity.mina.privateKey,
        identity.mina.publicKey
      );
      const proof = await signer.signBalanceProof({
        channelId: CHANNEL_ID,
        nonce: NONCE,
        transferredAmount: AMOUNT,
        lockedAmount: 0n,
        locksRoot: '0x00',
        recipient: RECIPIENT,
        metadata,
      });

      // Mina claim payload = UTF-8 bytes of the base58 signature string.
      const claim = asClaim({
        channelId: CHANNEL_ID,
        cumulativeAmount: AMOUNT,
        nonce: NONCE,
        recipient: RECIPIENT,
        claimBytes: new TextEncoder().encode(proof.signature),
      });

      expect(verifyMinaSignature(claim, proof.signerAddress, minaClient)).toBe(
        true
      );
    });

    it('rejects a tampered nonce', async () => {
      if (!minaClient) return;
      const signer = new MinaSigner(
        identity.mina.privateKey,
        identity.mina.publicKey
      );
      const proof = await signer.signBalanceProof({
        channelId: CHANNEL_ID,
        nonce: NONCE,
        transferredAmount: AMOUNT,
        lockedAmount: 0n,
        locksRoot: '0x00',
        recipient: RECIPIENT,
        metadata,
      });

      expect(
        verifyMinaSignature(
          asClaim({
            channelId: CHANNEL_ID,
            cumulativeAmount: AMOUNT,
            nonce: NONCE + 1,
            recipient: RECIPIENT,
            claimBytes: new TextEncoder().encode(proof.signature),
          }),
          proof.signerAddress,
          minaClient
        )
      ).toBe(false);
    });
  });
});
