import type { EvmSigner } from '../signing/evm-signer.js';
import type { SolanaSigner } from '../signing/solana-signer.js';
import type { MinaSigner } from '../signing/mina-signer.js';

/**
 * Full multi-chain identity derived from a single BIP-39 mnemonic.
 */
export interface ToonIdentity {
  nostr: {
    secretKey: Uint8Array; // 32-byte secp256k1
    pubkey: string; // 64-char hex (x-only Schnorr)
  };
  evm: {
    privateKey: Uint8Array; // Same as nostr.secretKey (secp256k1)
    address: string; // 0x-prefixed EIP-55 checksummed
  };
  solana: {
    secretKey: Uint8Array; // 64-byte Ed25519 keypair
    publicKey: string; // Base58 address
  };
  mina: {
    privateKey: string; // Base58 Mina private key
    publicKey: string; // Base58 Mina public key
  };
}

/**
 * Signer accessors provided by KeyManager after create/recover.
 */
export interface ToonSigners {
  evm: EvmSigner;
  solana: SolanaSigner;
  mina: MinaSigner;
}

/**
 * Metadata about a registered WebAuthn credential.
 */
export interface PasskeyInfo {
  credentialIdHash: string; // SHA-256 of credential ID (hex)
  createdAt: number; // Unix timestamp
}

/**
 * Configuration for the KeyManager.
 */
export interface KeyManagerConfig {
  relayUrls: string[];
  rpId?: string; // WebAuthn relying party ID (defaults to window.location.hostname)
  rpName?: string; // Display name for Passkey prompt
  storageKey?: string; // IndexedDB key prefix (default: "toon:keys")
}

/**
 * Encrypted backup payload stored in kind:30078 event content.
 */
export interface BackupPayload {
  encrypted_mnemonic: string; // base64 AES-256-GCM(DEK, mnemonic)
  wrapped_keys: WrappedKeyEntry[];
  recovery_code_wrapped_dek?: string; // base64 AES-KW(recovery KEK, DEK)
  iv: string; // base64 GCM nonce
}

/**
 * A single wrapped DEK entry, keyed to a specific WebAuthn credential.
 */
export interface WrappedKeyEntry {
  id: string; // SHA-256 of WebAuthn credential ID
  wrapped_dek: string; // base64 AES-KW(KEK, DEK)
  salt: string; // base64 PRF salt
  created_at: number;
}

/**
 * Result of a Passkey assertion, containing the PRF output and credential metadata.
 */
export interface PasskeyAssertionResult {
  prfOutput: ArrayBuffer;
  credentialId: Uint8Array;
  userHandle: Uint8Array | null;
}

/**
 * Result of a Passkey registration, containing the PRF output and credential metadata.
 */
export interface PasskeyRegistrationResult {
  prfOutput: ArrayBuffer;
  credentialId: Uint8Array;
}

/**
 * Vault data persisted to IndexedDB.
 */
export interface VaultData {
  encryptedMnemonic: string; // base64
  iv: string; // base64
  wrappedKeys: WrappedKeyEntry[];
  recoveryCodeWrappedDek?: string; // base64
  recoveryCodeSalt?: string; // base64 PBKDF2 salt (persisted for recovery code verification)
}
