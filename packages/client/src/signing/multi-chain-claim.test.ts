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
 *   a payment-channel claim — NOT the swap peer ↔ sender swap-claim shape
 *   (`balanceProofHashSolana`, SDK `verifyEd25519Signature`).
 * - **Mina** now signs the connector's PAYMENT-CHANNEL proof (Poseidon
 *   commitment + Pallas Schnorr), a different message from the swap peer↔sender
 *   swap-claim shape; its full connector-contract conformance lives in
 *   `mina-signer.test.ts`. This file keeps only a minimal wire-shape cross-check.
 *
 * `@toon-protocol/sdk` is a devDependency (used here for `loadMinaSignerClient`).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { loadMinaSignerClient } from '@toon-protocol/sdk';
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

  // Mina now signs the connector's PAYMENT-CHANNEL proof (Poseidon commitment +
  // Pallas Schnorr over [commitment, nonce, Poseidon(zkApp.x)]) — a different
  // message + format from the swap peer↔sender swap-claim shape this file's verifier
  // helpers cover. Its connector-contract conformance + commitment/Schnorr
  // parity are pinned in `mina-signer.test.ts`. We keep a minimal cross-check
  // here that the emitted claim is the new payment-channel wire shape (carries
  // the connector's `zkAppAddress`/`balanceCommitment`/`proof`/`salt`), using a
  // real B62 zkApp address (the example string above is not a valid Pallas
  // point and would fail `PublicKey.fromBase58`).
  describe('Mina (Pallas) — payment-channel claim shape', () => {
    it('emits the connector MinaClaimMessage fields', async () => {
      const minaClient = await loadMinaSignerClient();
      if (!minaClient) return; // optional dep absent — skip, no false-pass
      // Use the derived Mina public key as a valid B62 zkApp address (a valid
      // Pallas point) so the Poseidon channel-hash derivation succeeds.
      const zkAppAddress = identity.mina.publicKey;
      expect(zkAppAddress).not.toBe('');
      const metadata: ChainMetadata = { chainType: 'mina', zkAppAddress };
      const signer = new MinaSigner(
        identity.mina.privateKey,
        identity.mina.publicKey
      );
      const proof = await signer.signBalanceProof({
        channelId: zkAppAddress,
        nonce: NONCE,
        transferredAmount: AMOUNT,
        lockedAmount: 0n,
        locksRoot: '0x00',
        recipient: RECIPIENT,
        metadata,
      });
      const claim = signer.buildClaimMessage(proof, 'g.toon.client') as {
        blockchain: string;
        zkAppAddress: string;
        balanceCommitment: string;
        proof: string;
        salt: string;
        tokenId: string;
      };
      expect(claim.blockchain).toBe('mina');
      expect(claim.zkAppAddress).toBe(zkAppAddress);
      expect(claim.balanceCommitment.length).toBeGreaterThan(0);
      expect(/^[A-Za-z0-9+/]+=*$/.test(claim.proof)).toBe(true);
      expect(claim.salt.length).toBeGreaterThan(0);
      expect(claim.tokenId).toBe('MINA');
    });
  });
});
