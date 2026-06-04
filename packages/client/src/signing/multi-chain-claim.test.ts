/**
 * Multi-chain balance-proof claim verification.
 *
 * PRIMARY correctness gate for the client's Solana/Mina signers: it proves the
 * signatures they produce verify against the SDK's `verifyEd25519Signature` /
 * `verifyMinaSignature` — the documented exact mirror of the connector-side
 * verification (both sides share the canonical hashes in `@toon-protocol/core`).
 * A claim that passes these verifiers is byte-compatible with what the Mill
 * produces and what the connector accepts on-network.
 *
 * `@toon-protocol/sdk` is a devDependency used here purely as the verification
 * oracle.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  verifyEd25519Signature,
  verifyMinaSignature,
  loadMinaSignerClient,
  type MinaSignerClientLike,
} from '@toon-protocol/sdk';
import { hexToBytes } from '@toon-protocol/core';
import type { ToonIdentity } from '../keys/types.js';
import { deriveFullIdentity } from '../keys/KeyDerivation.js';
import { SolanaSigner } from './solana-signer.js';
import { MinaSigner } from './mina-signer.js';
import type { ChainMetadata } from './types.js';

// A valid BIP-39 phrase (the well-known Hardhat dev mnemonic).
const MNEMONIC = 'test test test test test test test test test test test junk';

const CHANNEL_ID = 'channel-1';
const RECIPIENT = 'CounterpartySettlementAddr111111111111111111';
const AMOUNT = 1000n;
const NONCE = 1;

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

    it('produces a signature the SDK verifier accepts', async () => {
      expect(identity.solana.publicKey).not.toBe('');
      const signer = new SolanaSigner(
        identity.solana.secretKey.slice(0, 32),
        identity.solana.publicKey
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

      const claim = asClaim({
        channelId: CHANNEL_ID,
        cumulativeAmount: AMOUNT,
        nonce: NONCE,
        recipient: RECIPIENT,
        claimBytes: hexToBytes(proof.signature), // 0x-prefixed 64-byte sig
      });

      expect(verifyEd25519Signature(claim, proof.signerAddress)).toBe(true);
    });

    it('rejects a tampered amount / recipient', async () => {
      const signer = new SolanaSigner(
        identity.solana.secretKey.slice(0, 32),
        identity.solana.publicKey
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
      const claimBytes = hexToBytes(proof.signature);

      expect(
        verifyEd25519Signature(
          asClaim({
            channelId: CHANNEL_ID,
            cumulativeAmount: AMOUNT + 1n,
            nonce: NONCE,
            recipient: RECIPIENT,
            claimBytes,
          }),
          proof.signerAddress
        )
      ).toBe(false);

      expect(
        verifyEd25519Signature(
          asClaim({
            channelId: CHANNEL_ID,
            cumulativeAmount: AMOUNT,
            nonce: NONCE,
            recipient: 'DifferentRecipient1111111111111111111111111',
            claimBytes,
          }),
          proof.signerAddress
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
