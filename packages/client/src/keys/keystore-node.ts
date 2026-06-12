/**
 * Node-only encrypted mnemonic keystore for @toon-protocol/client.
 *
 * Mirrors the Townhouse node wallet crypto (`packages/townhouse/src/wallet/
 * crypto.ts`): a BIP-39 mnemonic is encrypted at rest with scrypt (KDF) +
 * AES-256-GCM (authenticated encryption), serialized as JSON, and written to
 * disk with mode 0o600. Decryption requires the operator password; a wrong
 * password fails the GCM auth-tag verification and throws.
 *
 * This is the Node-side counterpart to the browser Passkey/IndexedDB
 * `KeyManager`/`KeyVault` flow — it does NOT touch those. It is guarded against
 * browser bundling: every entry point throws if `node:crypto`/`node:fs` are not
 * available (e.g. when accidentally imported in a browser bundle).
 *
 * @module
 */

import {
  scryptSync,
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';
import { writeFileSync, readFileSync } from 'node:fs';
import {
  generateMnemonic as genMnemonic,
  validateMnemonic as isValidMnemonic,
} from './KeyDerivation.js';

/** scrypt parameters — N=2^17 (~0.5-1s on modern hardware), r=8, p=1. */
const SCRYPT_N = 2 ** 17;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LEN = 32;
/** maxmem for scrypt: N * r * 128 * 2 (with headroom for Node.js overhead). */
const SCRYPT_MAXMEM = SCRYPT_N * SCRYPT_R * 256 + 32 * 1024 * 1024;

/** Salt length in bytes. */
const SALT_LEN = 32;
/** AES-GCM IV length in bytes. */
const IV_LEN = 12;
/** AES-GCM authentication tag length in bytes (128-bit). */
const AUTH_TAG_LEN = 16;

/**
 * Encrypted keystore file format (JSON, all binary fields base64-encoded).
 * Wire-compatible with Townhouse's `EncryptedWallet`.
 */
export interface EncryptedKeystore {
  /** scrypt salt (base64). */
  salt: string;
  /** AES-GCM initialization vector (base64). */
  iv: string;
  /** AES-256-GCM ciphertext (base64). */
  ciphertext: string;
  /** AES-GCM authentication tag (base64). */
  tag: string;
  /** Envelope version for forward-compat (currently 1). */
  version?: number;
}

/**
 * Throws if this module is running outside Node.js. The scrypt/AES-256-GCM
 * primitives and the 0o600 file write are Node-only — there is no browser
 * equivalent of `node:crypto`'s `scryptSync` or POSIX file modes, so we fail
 * loudly rather than silently bundling broken code into a browser build.
 */
function assertNode(): void {
  // `process.versions.node` is present in Node and absent in browsers.
  const versions = (
    globalThis as { process?: { versions?: { node?: string } } }
  ).process?.versions;
  if (!versions?.node) {
    throw new Error(
      'keystore-node is Node.js-only and cannot run in a browser. ' +
        'Use the Passkey/IndexedDB KeyManager for browser key storage.'
    );
  }
}

/**
 * Encrypt a mnemonic with a password using scrypt + AES-256-GCM.
 * Returns the JSON-serializable encrypted envelope (does NOT write to disk).
 */
export function encryptMnemonic(
  mnemonic: string,
  password: string
): EncryptedKeystore {
  assertNode();
  if (typeof mnemonic !== 'string' || mnemonic.length === 0) {
    throw new Error('encryptMnemonic: mnemonic must be a non-empty string');
  }
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('encryptMnemonic: password must be a non-empty string');
  }

  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = scryptSync(password, salt, SCRYPT_KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });

  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv, {
      authTagLength: AUTH_TAG_LEN,
    });
    const ciphertext = Buffer.concat([
      cipher.update(mnemonic, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    return {
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      tag: tag.toString('base64'),
      version: 1,
    };
  } finally {
    key.fill(0);
  }
}

/**
 * Decrypt an encrypted keystore envelope with a password.
 * Throws on a wrong password (GCM auth-tag verification failure) or corruption.
 */
export function decryptMnemonic(
  encrypted: EncryptedKeystore,
  password: string
): string {
  assertNode();
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('decryptMnemonic: password must be a non-empty string');
  }
  if (
    !encrypted ||
    typeof encrypted.salt !== 'string' ||
    typeof encrypted.iv !== 'string' ||
    typeof encrypted.ciphertext !== 'string' ||
    typeof encrypted.tag !== 'string'
  ) {
    throw new Error('decryptMnemonic: malformed keystore envelope');
  }

  const salt = Buffer.from(encrypted.salt, 'base64');
  const iv = Buffer.from(encrypted.iv, 'base64');
  const ciphertext = Buffer.from(encrypted.ciphertext, 'base64');
  const tag = Buffer.from(encrypted.tag, 'base64');

  const key = scryptSync(password, salt, SCRYPT_KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv, {
      authTagLength: AUTH_TAG_LEN,
    });
    decipher.setAuthTag(tag);
    try {
      const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      return plaintext.toString('utf8');
    } catch {
      throw new Error(
        'Decryption failed: wrong password or corrupted keystore file'
      );
    }
  } finally {
    key.fill(0);
  }
}

/**
 * Generate a fresh 12-word BIP-39 mnemonic, encrypt it under `password`, and
 * write the encrypted keystore to `path` with mode 0o600.
 *
 * Returns the mnemonic (for one-time display/backup) alongside the encrypted
 * envelope. The caller is responsible for displaying the mnemonic securely and
 * NOT persisting it in plaintext.
 */
export function generateKeystore(
  path: string,
  password: string
): { mnemonic: string; keystore: EncryptedKeystore } {
  assertNode();
  const mnemonic = genMnemonic();
  const keystore = encryptMnemonic(mnemonic, password);
  writeKeystoreFile(path, keystore);
  return { mnemonic, keystore };
}

/**
 * Import an existing BIP-39 mnemonic (12 or 24 words), encrypt it under
 * `password`, and write the encrypted keystore to `path` with mode 0o600.
 *
 * Throws if the mnemonic is not a valid BIP-39 phrase (wrong checksum/word
 * count) before any file is written.
 */
export function importKeystore(
  path: string,
  mnemonic: string,
  password: string
): EncryptedKeystore {
  assertNode();
  if (!isValidMnemonic(mnemonic)) {
    throw new Error(
      'Invalid BIP-39 mnemonic: checksum or word-list validation failed'
    );
  }
  const keystore = encryptMnemonic(mnemonic, password);
  writeKeystoreFile(path, keystore);
  return keystore;
}

/**
 * Load and decrypt a keystore file at `path` with `password`, returning the
 * plaintext mnemonic. Throws on a wrong password or corruption.
 */
export function loadKeystore(path: string, password: string): string {
  assertNode();
  const raw = readFileSync(path, 'utf8');
  let parsed: EncryptedKeystore;
  try {
    parsed = JSON.parse(raw) as EncryptedKeystore;
  } catch {
    throw new Error(`Keystore file at ${path} is not valid JSON`);
  }
  return decryptMnemonic(parsed, password);
}

/**
 * Serialize and write an encrypted keystore to disk with mode 0o600
 * (owner read/write only), mirroring the Townhouse wallet file permissions.
 */
export function writeKeystoreFile(
  path: string,
  keystore: EncryptedKeystore
): void {
  assertNode();
  writeFileSync(path, JSON.stringify(keystore, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
}
