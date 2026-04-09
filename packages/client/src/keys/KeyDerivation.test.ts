import { describe, it, expect } from 'vitest';
import {
  generateMnemonic,
  validateMnemonic,
  deriveFullIdentity,
  deriveFromNsec,
  generateRandomIdentity,
} from './KeyDerivation.js';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';

describe('KeyDerivation', () => {
  describe('generateMnemonic', () => {
    it('should generate a 12-word mnemonic', () => {
      const mnemonic = generateMnemonic();
      const words = mnemonic.split(' ');
      expect(words).toHaveLength(12);
    });

    it('should generate unique mnemonics', () => {
      const m1 = generateMnemonic();
      const m2 = generateMnemonic();
      expect(m1).not.toBe(m2);
    });
  });

  describe('validateMnemonic', () => {
    it('should validate a correct mnemonic', () => {
      const mnemonic = generateMnemonic();
      const valid = validateMnemonic(mnemonic);
      expect(valid).toBe(true);
    });

    it('should reject an invalid mnemonic', () => {
      const valid = validateMnemonic('not a valid mnemonic phrase at all');
      expect(valid).toBe(false);
    });
  });

  describe('deriveFullIdentity', () => {
    it('should derive Nostr keys from mnemonic', async () => {
      const mnemonic = generateMnemonic();
      const identity = await deriveFullIdentity(mnemonic);

      expect(identity.nostr.secretKey).toBeInstanceOf(Uint8Array);
      expect(identity.nostr.secretKey).toHaveLength(32);
      expect(identity.nostr.pubkey).toHaveLength(64);
      expect(identity.nostr.pubkey).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should derive EVM address from same secp256k1 key', async () => {
      const mnemonic = generateMnemonic();
      const identity = await deriveFullIdentity(mnemonic);

      // EVM private key should be the same bytes as Nostr secret key
      expect(identity.evm.privateKey).toEqual(identity.nostr.secretKey);
      expect(identity.evm.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });

    it('should be deterministic — same mnemonic produces same keys', async () => {
      const mnemonic = generateMnemonic();
      const id1 = await deriveFullIdentity(mnemonic);
      const id2 = await deriveFullIdentity(mnemonic);

      expect(id1.nostr.pubkey).toBe(id2.nostr.pubkey);
      expect(id1.nostr.secretKey).toEqual(id2.nostr.secretKey);
      expect(id1.evm.address).toBe(id2.evm.address);
    });

    it('should derive different keys for different mnemonics', async () => {
      const m1 = generateMnemonic();
      const m2 = generateMnemonic();
      const id1 = await deriveFullIdentity(m1);
      const id2 = await deriveFullIdentity(m2);

      expect(id1.nostr.pubkey).not.toBe(id2.nostr.pubkey);
    });
  });

  describe('deriveFromNsec', () => {
    it('should derive Nostr + EVM identity from raw secret key', () => {
      const secretKey = generateSecretKey();
      const identity = deriveFromNsec(secretKey);

      expect(identity.nostr.pubkey).toBe(getPublicKey(secretKey));
      expect(identity.evm.privateKey).toEqual(secretKey);
      expect(identity.evm.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });

    it('should leave Solana and Mina empty for nsec import', () => {
      const secretKey = generateSecretKey();
      const identity = deriveFromNsec(secretKey);

      expect(identity.solana.publicKey).toBe('');
      expect(identity.mina.publicKey).toBe('');
    });
  });

  describe('generateRandomIdentity', () => {
    it('should generate a valid identity with Nostr + EVM keys', () => {
      const identity = generateRandomIdentity();

      expect(identity.nostr.secretKey).toHaveLength(32);
      expect(identity.nostr.pubkey).toHaveLength(64);
      expect(identity.evm.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });

    it('should generate unique identities', () => {
      const id1 = generateRandomIdentity();
      const id2 = generateRandomIdentity();

      expect(id1.nostr.pubkey).not.toBe(id2.nostr.pubkey);
    });
  });
});
