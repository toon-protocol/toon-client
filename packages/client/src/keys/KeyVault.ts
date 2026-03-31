import type { VaultData, WrappedKeyEntry } from './types.js';
import { toBase64, fromBase64 } from './encoding.js';

/**
 * Envelope encryption for mnemonic storage.
 *
 * Pattern: DEK encrypts mnemonic, KEK wraps DEK.
 * Multiple KEKs (Passkeys, recovery codes) can each wrap the same DEK independently.
 *
 * - DEK: random 256-bit AES key (Data Encryption Key)
 * - KEK: derived from Passkey PRF or recovery code (Key Encryption Key)
 * - Mnemonic encrypted with AES-256-GCM using DEK
 * - DEK wrapped with AES-KW using KEK
 */

// --- DEK operations ---

/**
 * Generate a random 256-bit Data Encryption Key.
 */
export async function generateDek(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true, // extractable — needed for AES-KW wrapping
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypt a mnemonic string with a DEK using AES-256-GCM.
 * @returns Base64-encoded ciphertext and IV
 */
export async function encryptMnemonic(
  dek: CryptoKey,
  mnemonic: string
): Promise<{ encryptedMnemonic: string; iv: string }> {
  const encoder = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(12)); // 96-bit GCM nonce
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    dek,
    encoder.encode(mnemonic)
  );
  return {
    encryptedMnemonic: toBase64(ciphertext),
    iv: toBase64(iv),
  };
}

/**
 * Decrypt a mnemonic from its encrypted form using a DEK.
 */
export async function decryptMnemonic(
  dek: CryptoKey,
  encryptedMnemonic: string,
  iv: string
): Promise<string> {
  const decoder = new TextDecoder();
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(iv) },
    dek,
    fromBase64(encryptedMnemonic)
  );
  return decoder.decode(plaintext);
}

// --- KEK operations ---

/**
 * Derive a KEK from a Passkey PRF output using HKDF.
 *
 * Flow: PRF(CredRandom, salt) → HKDF-SHA-256 → 256-bit AES-KW key
 */
export async function deriveKek(prfOutput: ArrayBuffer): Promise<CryptoKey> {
  // Import PRF output as HKDF key material
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    prfOutput,
    'HKDF',
    false,
    ['deriveKey']
  );

  const encoder = new TextEncoder();
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0), // PRF salt was already applied at the WebAuthn level
      info: encoder.encode('toon:kek'),
    },
    keyMaterial,
    { name: 'AES-KW', length: 256 },
    false, // not extractable
    ['wrapKey', 'unwrapKey']
  );
}

/**
 * Derive a KEK from a password string using PBKDF2.
 * Used as fallback when PRF is not available, or for recovery codes.
 */
export async function deriveKekFromPassword(
  password: string,
  salt: Uint8Array
): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt,
      iterations: 600_000, // OWASP 2023 recommendation for SHA-256
    },
    keyMaterial,
    { name: 'AES-KW', length: 256 },
    false,
    ['wrapKey', 'unwrapKey']
  );
}

// --- Wrap/Unwrap DEK ---

/**
 * Wrap (encrypt) a DEK with a KEK using AES-KW.
 * @returns Base64-encoded wrapped DEK
 */
export async function wrapDek(
  kek: CryptoKey,
  dek: CryptoKey
): Promise<string> {
  const wrapped = await crypto.subtle.wrapKey('raw', dek, kek, 'AES-KW');
  return toBase64(new Uint8Array(wrapped));
}

/**
 * Unwrap (decrypt) a DEK from its wrapped form using a KEK.
 * @returns The unwrapped DEK as a CryptoKey
 */
export async function unwrapDek(
  kek: CryptoKey,
  wrappedDek: string
): Promise<CryptoKey> {
  return crypto.subtle.unwrapKey(
    'raw',
    fromBase64(wrappedDek),
    kek,
    'AES-KW',
    { name: 'AES-GCM', length: 256 },
    true, // extractable — needed for re-wrapping when adding new KEKs
    ['encrypt', 'decrypt']
  );
}

// --- High-level vault operations ---

/**
 * Create a new vault: generate DEK, encrypt mnemonic, wrap DEK with initial KEK.
 */
export async function createVault(
  mnemonic: string,
  kek: CryptoKey,
  credentialIdHash: string,
  prfSalt: Uint8Array
): Promise<VaultData> {
  const dek = await generateDek();
  const { encryptedMnemonic, iv } = await encryptMnemonic(dek, mnemonic);
  const wrappedDek = await wrapDek(kek, dek);

  const entry: WrappedKeyEntry = {
    id: credentialIdHash,
    wrapped_dek: wrappedDek,
    salt: toBase64(prfSalt),
    created_at: Math.floor(Date.now() / 1000),
  };

  return {
    encryptedMnemonic,
    iv,
    wrappedKeys: [entry],
  };
}

/**
 * Unlock a vault: unwrap DEK with KEK, decrypt mnemonic.
 */
export async function unlockVault(
  vault: VaultData,
  kek: CryptoKey,
  credentialIdHash: string
): Promise<string> {
  const entry = vault.wrappedKeys.find((e) => e.id === credentialIdHash);
  if (!entry) {
    throw new Error(
      `No wrapped key found for credential ${credentialIdHash}`
    );
  }

  const dek = await unwrapDek(kek, entry.wrapped_dek);
  return decryptMnemonic(dek, vault.encryptedMnemonic, vault.iv);
}

/**
 * Add a new KEK (from a new Passkey or recovery code) to an existing vault.
 * Requires an existing KEK to unwrap the DEK first.
 */
export async function addKekToVault(
  vault: VaultData,
  existingKek: CryptoKey,
  existingCredentialIdHash: string,
  newKek: CryptoKey,
  newCredentialIdHash: string,
  newPrfSalt: Uint8Array
): Promise<VaultData> {
  // Unwrap DEK with existing KEK
  const existingEntry = vault.wrappedKeys.find(
    (e) => e.id === existingCredentialIdHash
  );
  if (!existingEntry) {
    throw new Error(
      `No wrapped key found for credential ${existingCredentialIdHash}`
    );
  }
  const dek = await unwrapDek(existingKek, existingEntry.wrapped_dek);

  // Wrap DEK with new KEK
  const newWrappedDek = await wrapDek(newKek, dek);

  const newEntry: WrappedKeyEntry = {
    id: newCredentialIdHash,
    wrapped_dek: newWrappedDek,
    salt: toBase64(newPrfSalt),
    created_at: Math.floor(Date.now() / 1000),
  };

  return {
    ...vault,
    wrappedKeys: [...vault.wrappedKeys, newEntry],
  };
}

/**
 * Remove a KEK from a vault. Always requires at least one passkey KEK to remain.
 */
export function removeKekFromVault(
  vault: VaultData,
  credentialIdHash: string
): VaultData {
  const remaining = vault.wrappedKeys.filter(
    (e) => e.id !== credentialIdHash
  );

  if (remaining.length === 0) {
    throw new Error(
      'Cannot remove the last passkey — at least one passkey must remain for vault access'
    );
  }

  return {
    ...vault,
    wrappedKeys: remaining,
  };
}

/**
 * Add a recovery code KEK to the vault.
 * The PBKDF2 salt is persisted in the vault so recoverWithCode can reproduce the KEK.
 */
export async function addRecoveryCodeToVault(
  vault: VaultData,
  existingKek: CryptoKey,
  existingCredentialIdHash: string,
  recoveryKek: CryptoKey,
  recoverySalt: Uint8Array
): Promise<VaultData> {
  const existingEntry = vault.wrappedKeys.find(
    (e) => e.id === existingCredentialIdHash
  );
  if (!existingEntry) {
    throw new Error(
      `No wrapped key found for credential ${existingCredentialIdHash}`
    );
  }
  const dek = await unwrapDek(existingKek, existingEntry.wrapped_dek);
  const recoveryWrappedDek = await wrapDek(recoveryKek, dek);

  return {
    ...vault,
    recoveryCodeWrappedDek: recoveryWrappedDek,
    recoveryCodeSalt: toBase64(recoverySalt),
  };
}

/**
 * Unlock a vault using a recovery code.
 */
export async function unlockVaultWithRecoveryCode(
  vault: VaultData,
  recoveryKek: CryptoKey
): Promise<string> {
  if (!vault.recoveryCodeWrappedDek) {
    throw new Error('No recovery code is configured for this vault');
  }

  const dek = await unwrapDek(recoveryKek, vault.recoveryCodeWrappedDek);
  return decryptMnemonic(dek, vault.encryptedMnemonic, vault.iv);
}

/**
 * Generate a human-readable recovery code (24 random hex chars with dashes).
 * Format: XXXX-XXXX-XXXX-XXXX-XXXX-XXXX (easy to write down).
 */
export function generateRecoveryCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const groups = hex.match(/.{4}/g) ?? [];
  return groups.join('-');
}
