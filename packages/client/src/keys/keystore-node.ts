/**
 * Node-only encrypted mnemonic keystore.
 *
 * A BIP-39 mnemonic is encrypted at rest with scrypt (KDF) + AES-256-GCM
 * (authenticated encryption), serialized as JSON, and written to disk with mode
 * `0o600`. Decryption needs the password; a wrong one fails the GCM auth-tag
 * check and throws. None of that crypto has changed, and none of it is going to
 * change quietly — the file format carries a version so that it does not have
 * to.
 *
 * ## Versions, and why a v1 file is read as `legacy`
 *
 * A keystore records **which derivation its mnemonic is meant to be read
 * under**, because a phrase alone does not say. Before 1.0 this client derived
 * its EVM key on coin type 1237 — one secp256k1 key served two roles — and a
 * keystore from that era says nothing about it. From 1.0 the EVM key is derived
 * at the BIP-44 standard `m/44'/60'/0'/0/i`, which is a different address from
 * the same phrase.
 *
 * So the migration rule, which is the whole point of the version field:
 *
 * - **A keystore with no `version`, or `version: 1`, is read as `legacy`.**
 *   Every keystore written before 1.0 is one of those two, and every one of them
 *   may hold a payment channel with real collateral locked at the address that
 *   derivation produces. Reading it as `standard` would silently hand the caller
 *   a different address, an empty wallet and no channel, while the funded one
 *   sat there unreachable. Upgrading this package moves nothing.
 * - **A keystore written now is `version: 2` and records its derivation
 *   explicitly** — `standard` unless the caller asked for `legacy` (importing a
 *   phrase whose channels were opened under the old path).
 *
 * Nothing rewrites a v1 file in place. It keeps working as it is, and a caller
 * that wants to move to the standard path does so deliberately: import the same
 * phrase into a new keystore, and open a new channel at the new address.
 *
 * Node-only, and loudly so: `scryptSync` and POSIX file modes have no browser
 * equivalent, so every entry point throws rather than being bundled broken.
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
  type KeyDerivationScheme,
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

/** The version this package writes. See this module's own docs. */
export const KEYSTORE_VERSION = 2;

/**
 * Encrypted keystore file format (JSON, all binary fields base64-encoded).
 *
 * `version` and `derivation` are both optional on the *type* because a file on
 * disk may predate them; anything this package writes sets both.
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
  /** File-format version. Absent or `1` means a pre-1.0 file: read as `legacy`. */
  version?: number;
  /** Which derivation this mnemonic's keys are meant to be read under. */
  derivation?: KeyDerivationScheme;
}

/** A decrypted keystore: the phrase, and how to read it. */
export interface OpenedKeystore {
  mnemonic: string;
  /** `legacy` for any pre-1.0 file. See this module's own docs. */
  derivation: KeyDerivationScheme;
  /** The file's own version. `1` when the file recorded none. */
  version: number;
}

/** Options for writing a keystore. */
export interface WriteKeystoreOptions {
  /** Which derivation to record. Default `'standard'`. */
  derivation?: KeyDerivationScheme;
}

/**
 * Which derivation a keystore's mnemonic is to be read under.
 *
 * A file with no `version`, or `version: 1`, predates 1.0 and is `legacy` — its
 * addresses, and the channels funded at them, must not move. From `version: 2`
 * the file says so itself, defaulting to `standard` if the field is missing.
 */
export function keystoreDerivation(
  keystore: EncryptedKeystore
): KeyDerivationScheme {
  const version = keystore.version ?? 1;
  if (version < KEYSTORE_VERSION) return 'legacy';
  return keystore.derivation ?? 'standard';
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
 * Returns the JSON-serializable encrypted envelope (does NOT write to disk),
 * stamped `version: 2` and carrying the derivation its keys are read under.
 */
export function encryptMnemonic(
  mnemonic: string,
  password: string,
  options: WriteKeystoreOptions = {}
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
      version: KEYSTORE_VERSION,
      derivation: options.derivation ?? 'standard',
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
  password: string,
  options: WriteKeystoreOptions = {}
): { mnemonic: string; keystore: EncryptedKeystore } {
  assertNode();
  const mnemonic = genMnemonic();
  const keystore = encryptMnemonic(mnemonic, password, options);
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
  password: string,
  options: WriteKeystoreOptions = {}
): EncryptedKeystore {
  assertNode();
  if (!isValidMnemonic(mnemonic)) {
    throw new Error(
      'Invalid BIP-39 mnemonic: checksum or word-list validation failed'
    );
  }
  const keystore = encryptMnemonic(mnemonic, password, options);
  writeKeystoreFile(path, keystore);
  return keystore;
}

/**
 * Read a keystore file at `path`, decrypt it with `password`, and report both
 * the phrase and the derivation it is to be read under. Throws on a wrong
 * password or corruption.
 *
 * Prefer this over {@link loadKeystore}: a mnemonic on its own does not say
 * which addresses it means, and a pre-1.0 file means the `legacy` ones.
 */
export function openKeystore(path: string, password: string): OpenedKeystore {
  assertNode();
  const raw = readFileSync(path, 'utf8');
  let parsed: EncryptedKeystore;
  try {
    parsed = JSON.parse(raw) as EncryptedKeystore;
  } catch {
    throw new Error(`Keystore file at ${path} is not valid JSON`);
  }
  return {
    mnemonic: decryptMnemonic(parsed, password),
    derivation: keystoreDerivation(parsed),
    version: parsed.version ?? 1,
  };
}

/**
 * Load and decrypt a keystore file at `path` with `password`, returning the
 * plaintext mnemonic alone. Throws on a wrong password or corruption.
 *
 * The phrase without its derivation is only half the answer — see
 * {@link openKeystore}.
 */
export function loadKeystore(path: string, password: string): string {
  return openKeystore(path, password).mnemonic;
}

/**
 * Serialize and write an encrypted keystore to disk with mode 0o600
 * (owner read/write only), mirroring the relay node wallet file permissions.
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
