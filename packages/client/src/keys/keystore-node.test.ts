import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  encryptMnemonic,
  decryptMnemonic,
  generateKeystore,
  importKeystore,
  loadKeystore,
} from './keystore-node.js';
import { validateMnemonic } from './KeyDerivation.js';

const VALID_MNEMONIC =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';
const PASSWORD = 'correct horse battery staple';

const tmpDirs: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'toon-keystore-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('keystore-node', () => {
  describe('encrypt → decrypt round-trip', () => {
    it('decrypts back to the original mnemonic', () => {
      const enc = encryptMnemonic(VALID_MNEMONIC, PASSWORD);
      expect(enc.salt).toBeTypeOf('string');
      expect(enc.iv).toBeTypeOf('string');
      expect(enc.ciphertext).toBeTypeOf('string');
      expect(enc.tag).toBeTypeOf('string');
      // Ciphertext must NOT contain the plaintext.
      expect(enc.ciphertext).not.toContain('legal');

      const out = decryptMnemonic(enc, PASSWORD);
      expect(out).toBe(VALID_MNEMONIC);
    });

    it('produces a fresh salt/iv each time (non-deterministic envelope)', () => {
      const a = encryptMnemonic(VALID_MNEMONIC, PASSWORD);
      const b = encryptMnemonic(VALID_MNEMONIC, PASSWORD);
      expect(a.salt).not.toBe(b.salt);
      expect(a.iv).not.toBe(b.iv);
      expect(a.ciphertext).not.toBe(b.ciphertext);
    });
  });

  describe('wrong password', () => {
    it('rejects decryption with a wrong password', () => {
      const enc = encryptMnemonic(VALID_MNEMONIC, PASSWORD);
      expect(() => decryptMnemonic(enc, 'wrong-password')).toThrow(
        /wrong password or corrupted/i
      );
    });

    it('rejects a tampered ciphertext (GCM auth failure)', () => {
      const enc = encryptMnemonic(VALID_MNEMONIC, PASSWORD);
      const tampered = {
        ...enc,
        ciphertext: Buffer.from('garbage-bytes-here').toString('base64'),
      };
      expect(() => decryptMnemonic(tampered, PASSWORD)).toThrow();
    });
  });

  describe('generateKeystore', () => {
    it('writes a 0o600 file and the mnemonic round-trips', () => {
      const path = join(freshDir(), 'wallet.enc');
      const { mnemonic } = generateKeystore(path, PASSWORD);

      expect(validateMnemonic(mnemonic)).toBe(true);
      // File must be owner-read/write only (0o600).
      const mode = statSync(path).mode & 0o777;
      expect(mode).toBe(0o600);
      // On-disk file is JSON and does not contain the plaintext mnemonic.
      const raw = readFileSync(path, 'utf8');
      expect(raw).not.toContain(mnemonic);

      expect(loadKeystore(path, PASSWORD)).toBe(mnemonic);
    });
  });

  describe('importKeystore', () => {
    it('imports a valid mnemonic and round-trips via loadKeystore', () => {
      const path = join(freshDir(), 'wallet.enc');
      importKeystore(path, VALID_MNEMONIC, PASSWORD);

      const mode = statSync(path).mode & 0o777;
      expect(mode).toBe(0o600);
      expect(loadKeystore(path, PASSWORD)).toBe(VALID_MNEMONIC);
    });

    it('rejects an invalid mnemonic before writing a file', () => {
      const path = join(freshDir(), 'wallet.enc');
      expect(() =>
        importKeystore(path, 'not a valid bip39 phrase at all', PASSWORD)
      ).toThrow(/Invalid BIP-39 mnemonic/);
    });

    it('loadKeystore rejects a wrong password', () => {
      const path = join(freshDir(), 'wallet.enc');
      importKeystore(path, VALID_MNEMONIC, PASSWORD);
      expect(() => loadKeystore(path, 'nope')).toThrow(
        /wrong password or corrupted/i
      );
    });
  });
});
