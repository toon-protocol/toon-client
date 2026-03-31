import { describe, it, expect } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import {
  buildBackupEvent,
  buildBackupFilter,
  parseBackupPayload,
} from './BackupService.js';
import type { VaultData } from './types.js';

const mockVault: VaultData = {
  encryptedMnemonic: 'dGVzdA==', // base64 "test"
  iv: 'AAAAAAAAAAAAAAAA', // base64 12 zero bytes
  wrappedKeys: [
    {
      id: 'abc123',
      wrapped_dek: 'ZGVr', // base64 "dek"
      salt: 'c2FsdA==', // base64 "salt"
      created_at: 1700000000,
    },
  ],
  recoveryCodeWrappedDek: 'cmVjb3Zlcnk=', // base64 "recovery"
};

describe('BackupService', () => {
  describe('buildBackupEvent', () => {
    it('should build a kind:30078 event with correct tags', () => {
      const secretKey = generateSecretKey();
      const pubkey = getPublicKey(secretKey);

      const event = buildBackupEvent(mockVault, secretKey);

      expect(event.kind).toBe(30078);
      expect(event.pubkey).toBe(pubkey);
      expect(event.tags).toContainEqual(['d', 'toon:identity-backup']);
      expect(event.tags).toContainEqual(['v', '1']);
      expect(event.tags).toContainEqual([
        'chains',
        'nostr,evm,solana,mina',
      ]);
    });

    it('should include encrypted vault data in content', () => {
      const secretKey = generateSecretKey();
      const event = buildBackupEvent(mockVault, secretKey);
      const content = JSON.parse(event.content);

      expect(content.encrypted_mnemonic).toBe(mockVault.encryptedMnemonic);
      expect(content.iv).toBe(mockVault.iv);
      expect(content.wrapped_keys).toHaveLength(1);
      expect(content.recovery_code_wrapped_dek).toBe(
        mockVault.recoveryCodeWrappedDek
      );
    });

    it('should omit recovery_code_wrapped_dek when not set', () => {
      const secretKey = generateSecretKey();
      const vaultNoRecovery: VaultData = {
        ...mockVault,
        recoveryCodeWrappedDek: undefined,
      };
      const event = buildBackupEvent(vaultNoRecovery, secretKey);
      const content = JSON.parse(event.content);

      expect(content.recovery_code_wrapped_dek).toBeUndefined();
    });
  });

  describe('buildBackupFilter', () => {
    it('should build correct filter for pubkey lookup', () => {
      const pubkey = 'abc123def456';
      const filter = buildBackupFilter(pubkey);

      expect(filter.kinds).toEqual([30078]);
      expect(filter.authors).toEqual([pubkey]);
      expect(filter['#d']).toEqual(['toon:identity-backup']);
    });
  });

  describe('parseBackupPayload', () => {
    it('should parse valid backup content', () => {
      const content = JSON.stringify({
        encrypted_mnemonic: mockVault.encryptedMnemonic,
        iv: mockVault.iv,
        wrapped_keys: mockVault.wrappedKeys,
        recovery_code_wrapped_dek: mockVault.recoveryCodeWrappedDek,
      });

      const parsed = parseBackupPayload(content);

      expect(parsed.encryptedMnemonic).toBe(mockVault.encryptedMnemonic);
      expect(parsed.iv).toBe(mockVault.iv);
      expect(parsed.wrappedKeys).toHaveLength(1);
      expect(parsed.recoveryCodeWrappedDek).toBe(
        mockVault.recoveryCodeWrappedDek
      );
    });

    it('should throw on invalid JSON', () => {
      expect(() => parseBackupPayload('not json')).toThrow(
        'not valid JSON'
      );
    });

    it('should throw on missing encrypted_mnemonic', () => {
      const content = JSON.stringify({ iv: 'x', wrapped_keys: [] });
      expect(() => parseBackupPayload(content)).toThrow(
        'missing encrypted_mnemonic'
      );
    });

    it('should throw on missing iv', () => {
      const content = JSON.stringify({
        encrypted_mnemonic: 'x',
        wrapped_keys: [],
      });
      expect(() => parseBackupPayload(content)).toThrow('missing iv');
    });

    it('should throw on missing wrapped_keys', () => {
      const content = JSON.stringify({
        encrypted_mnemonic: 'x',
        iv: 'y',
      });
      expect(() => parseBackupPayload(content)).toThrow(
        'missing wrapped_keys'
      );
    });

    it('should throw on invalid wrapped key entry', () => {
      const content = JSON.stringify({
        encrypted_mnemonic: 'x',
        iv: 'y',
        wrapped_keys: [{ id: 'a' }], // missing wrapped_dek and salt
      });
      expect(() => parseBackupPayload(content)).toThrow(
        'missing wrapped_dek'
      );
    });
  });
});
