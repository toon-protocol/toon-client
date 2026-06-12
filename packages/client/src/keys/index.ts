// KeyManager — main orchestrator
export { KeyManager } from './KeyManager.js';

// Key derivation
export {
  generateMnemonic,
  validateMnemonic,
  deriveNostrKeyFromMnemonic,
  deriveFullIdentity,
  deriveFromNsec,
  generateRandomIdentity,
} from './KeyDerivation.js';

// Types
export type {
  ToonIdentity,
  ToonSigners,
  PasskeyInfo,
  KeyManagerConfig,
  BackupPayload,
  WrappedKeyEntry,
  VaultData,
} from './types.js';

// Backup utilities (for advanced use cases)
export {
  buildBackupEvent,
  buildBackupFilter,
  parseBackupPayload,
} from './BackupService.js';

// Passkey utilities
export { isPrfSupported, hashCredentialId } from './PasskeyAuth.js';

// Node-only encrypted mnemonic keystore (scrypt + AES-256-GCM).
// Mirrors the townhouse node wallet; guarded against browser use at runtime.
export {
  encryptMnemonic,
  decryptMnemonic,
  generateKeystore,
  importKeystore,
  loadKeystore,
  writeKeystoreFile,
  type EncryptedKeystore,
} from './keystore-node.js';
