import { describe, it, expect } from 'vitest';
import { recoverTypedDataAddress } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { EvmSigner } from './evm-signer.js';
import type { BalanceProofParams, SignedBalanceProof } from '../types.js';

const TEST_CHAIN_ID = 31337;
const TEST_TOKEN_NETWORK = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000';

describe('EvmSigner', () => {
  describe('construction', () => {
    it('should construct from hex string with 0x prefix', () => {
      const key = generatePrivateKey();
      const signer = new EvmSigner(key);
      expect(signer.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });

    it('should construct from hex string without 0x prefix', () => {
      const key = generatePrivateKey();
      const keyWithout0x = key.slice(2);
      const signer = new EvmSigner(keyWithout0x);
      expect(signer.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });

    it('should construct from Uint8Array', () => {
      const key = generatePrivateKey();
      const bytes = Buffer.from(key.slice(2), 'hex');
      const signer = new EvmSigner(new Uint8Array(bytes));
      expect(signer.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });

    it('should derive same address from hex and Uint8Array of same key', () => {
      const key = generatePrivateKey();
      const signerHex = new EvmSigner(key);
      const signerBytes = new EvmSigner(new Uint8Array(Buffer.from(key.slice(2), 'hex')));
      expect(signerHex.address).toBe(signerBytes.address);
    });
  });

  describe('address', () => {
    it('should return a valid EVM address', () => {
      const signer = new EvmSigner(generatePrivateKey());
      expect(signer.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });
  });

  describe('account', () => {
    it('should return a PrivateKeyAccount usable with viem', () => {
      const signer = new EvmSigner(generatePrivateKey());
      const account = signer.account;
      expect(account.address).toBe(signer.address);
      expect(typeof account.signTypedData).toBe('function');
      expect(typeof account.signMessage).toBe('function');
      expect(typeof account.signTransaction).toBe('function');
    });
  });

  describe('signBalanceProof', () => {
    it('should produce a recoverable signature', async () => {
      const signer = new EvmSigner(generatePrivateKey());
      const channelId = '0x' + '11'.repeat(32);

      const proof = await signer.signBalanceProof({
        channelId,
        nonce: 1,
        transferredAmount: 1000n,
        lockedAmount: 0n,
        locksRoot: ZERO_BYTES32,
        chainId: TEST_CHAIN_ID,
        tokenNetworkAddress: TEST_TOKEN_NETWORK,
      });

      expect(proof.signature).toMatch(/^0x[0-9a-fA-F]+$/);
      expect(proof.signerAddress).toBe(signer.address);

      // Verify the signature recovers to the correct address
      const recoveredAddress = await recoverTypedDataAddress({
        domain: {
          name: 'TokenNetwork',
          version: '1',
          chainId: TEST_CHAIN_ID,
          verifyingContract: TEST_TOKEN_NETWORK as `0x${string}`,
        },
        types: {
          BalanceProof: [
            { name: 'channelId', type: 'bytes32' },
            { name: 'nonce', type: 'uint256' },
            { name: 'transferredAmount', type: 'uint256' },
            { name: 'lockedAmount', type: 'uint256' },
            { name: 'locksRoot', type: 'bytes32' },
          ],
        },
        primaryType: 'BalanceProof',
        message: {
          channelId: channelId as `0x${string}`,
          nonce: 1n,
          transferredAmount: 1000n,
          lockedAmount: 0n,
          locksRoot: ZERO_BYTES32 as `0x${string}`,
        },
        signature: proof.signature as `0x${string}`,
      });

      expect(recoveredAddress.toLowerCase()).toBe(signer.address.toLowerCase());
    });

    it('should include all balance proof fields in result', async () => {
      const signer = new EvmSigner(generatePrivateKey());
      const channelId = '0x' + 'aa'.repeat(32);

      const proof = await signer.signBalanceProof({
        channelId,
        nonce: 5,
        transferredAmount: 50000n,
        lockedAmount: 100n,
        locksRoot: ZERO_BYTES32,
        chainId: TEST_CHAIN_ID,
        tokenNetworkAddress: TEST_TOKEN_NETWORK,
      });

      expect(proof.channelId).toBe(channelId);
      expect(proof.nonce).toBe(5);
      expect(proof.transferredAmount).toBe(50000n);
      expect(proof.lockedAmount).toBe(100n);
      expect(proof.locksRoot).toBe(ZERO_BYTES32);
    });

    it('should produce different signatures for different nonces', async () => {
      const signer = new EvmSigner(generatePrivateKey());
      const channelId = '0x' + 'bb'.repeat(32);
      const baseParams = {
        channelId,
        transferredAmount: 1000n,
        lockedAmount: 0n,
        locksRoot: ZERO_BYTES32,
        chainId: TEST_CHAIN_ID,
        tokenNetworkAddress: TEST_TOKEN_NETWORK,
      };

      const proof1 = await signer.signBalanceProof({ ...baseParams, nonce: 1 });
      const proof2 = await signer.signBalanceProof({ ...baseParams, nonce: 2 });

      expect(proof1.signature).not.toBe(proof2.signature);
    });

    it('should produce different signatures for different keys', async () => {
      const signer1 = new EvmSigner(generatePrivateKey());
      const signer2 = new EvmSigner(generatePrivateKey());
      const params = {
        channelId: '0x' + 'cc'.repeat(32),
        nonce: 1,
        transferredAmount: 1000n,
        lockedAmount: 0n,
        locksRoot: ZERO_BYTES32,
        chainId: TEST_CHAIN_ID,
        tokenNetworkAddress: TEST_TOKEN_NETWORK,
      };

      const proof1 = await signer1.signBalanceProof(params);
      const proof2 = await signer2.signBalanceProof(params);

      expect(proof1.signature).not.toBe(proof2.signature);
      expect(proof1.signerAddress).not.toBe(proof2.signerAddress);
    });
  });

  describe('buildClaimMessage', () => {
    it('should produce valid EVMClaimMessage shape', () => {
      const proof: SignedBalanceProof = {
        channelId: '0x' + 'dd'.repeat(32),
        nonce: 3,
        transferredAmount: 5000n,
        lockedAmount: 0n,
        locksRoot: ZERO_BYTES32,
        signature: '0xabcdef',
        signerAddress: '0x1234567890123456789012345678901234567890',
      };

      const claim = EvmSigner.buildClaimMessage(proof, 'nostr-pubkey-abc');

      expect(claim.blockchain).toBe('evm');
      expect(claim.senderId).toBe('nostr-pubkey-abc');
      expect(claim.channelId).toBe(proof.channelId);
      expect(claim.nonce).toBe(3);
      expect(claim.transferredAmount).toBe('5000');
      expect(claim.lockedAmount).toBe('0');
      expect(claim.locksRoot).toBe(ZERO_BYTES32);
      expect(claim.signature).toBe('0xabcdef');
      expect(claim.signerAddress).toBe(proof.signerAddress);
    });
  });
});
