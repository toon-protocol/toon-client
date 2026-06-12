import { describe, it, expect } from 'vitest';
import {
  generateMnemonic,
  validateMnemonic,
  deriveFullIdentity,
  deriveNostrKeyFromMnemonic,
  deriveFromNsec,
  generateRandomIdentity,
} from './KeyDerivation.js';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { fromMnemonicFull } from '@toon-protocol/sdk';

// A fixed 12-word mnemonic so the cross-check vectors are stable across runs.
const FIXED_MNEMONIC =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';

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

    it('default (no accountIndex) is unchanged and equals index 0', async () => {
      const idDefault = await deriveFullIdentity(FIXED_MNEMONIC);
      const idZero = await deriveFullIdentity(FIXED_MNEMONIC, 0);

      expect(idDefault.nostr.pubkey).toBe(idZero.nostr.pubkey);
      expect(idDefault.evm.address).toBe(idZero.evm.address);
      expect(idDefault.solana.publicKey).toBe(idZero.solana.publicKey);
      expect(idDefault.mina.publicKey).toBe(idZero.mina.publicKey);
    });

    it('non-zero accountIndex yields a distinct identity', async () => {
      const id0 = await deriveFullIdentity(FIXED_MNEMONIC, 0);
      const id3 = await deriveFullIdentity(FIXED_MNEMONIC, 3);

      expect(id3.nostr.pubkey).not.toBe(id0.nostr.pubkey);
      expect(id3.evm.address).not.toBe(id0.evm.address);
      expect(id3.solana.publicKey).not.toBe(id0.solana.publicKey);
    });

    it('rejects an invalid accountIndex', async () => {
      await expect(deriveFullIdentity(FIXED_MNEMONIC, -1)).rejects.toThrow(
        /Invalid accountIndex/
      );
      await expect(deriveFullIdentity(FIXED_MNEMONIC, 1.5)).rejects.toThrow(
        /Invalid accountIndex/
      );
    });
  });

  describe('SDK cross-check (matches fromMnemonicFull at each accountIndex)', () => {
    for (const accountIndex of [0, 1, 5, 42]) {
      it(`index ${accountIndex}: EVM/Solana/Mina addresses match the SDK`, async () => {
        const client = await deriveFullIdentity(FIXED_MNEMONIC, accountIndex);
        const sdk = await fromMnemonicFull(FIXED_MNEMONIC, { accountIndex });

        // Nostr + EVM (secp256k1, shared key)
        expect(client.nostr.pubkey).toBe(sdk.pubkey);
        expect(client.evm.address).toBe(sdk.evmAddress);

        // Solana (Ed25519, SLIP-0010)
        expect(client.solana.publicKey).toBe(sdk.solana.publicKey);

        // Mina (Pallas) — both derive via mina-signer when installed.
        if (sdk.mina) {
          expect(client.mina.publicKey).toBe(sdk.mina.publicKey);
        }
      });
    }
  });

  describe('deriveNostrKeyFromMnemonic accountIndex', () => {
    it('index 0 equals the SDK fromMnemonicFull index 0', async () => {
      const client = deriveNostrKeyFromMnemonic(FIXED_MNEMONIC);
      const sdk = await fromMnemonicFull(FIXED_MNEMONIC, { accountIndex: 0 });
      expect(client.pubkey).toBe(sdk.pubkey);
    });

    it('non-zero index matches the SDK and differs from index 0', async () => {
      const idx = 7;
      const client = deriveNostrKeyFromMnemonic(FIXED_MNEMONIC, idx);
      const sdk = await fromMnemonicFull(FIXED_MNEMONIC, { accountIndex: idx });
      expect(client.pubkey).toBe(sdk.pubkey);
      expect(client.pubkey).not.toBe(
        deriveNostrKeyFromMnemonic(FIXED_MNEMONIC, 0).pubkey
      );
    });

    it('rejects an out-of-range accountIndex', () => {
      expect(() => deriveNostrKeyFromMnemonic(FIXED_MNEMONIC, -1)).toThrow(
        /Invalid accountIndex/
      );
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
