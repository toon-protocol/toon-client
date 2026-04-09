// KeyManager — main orchestrator
export { KeyManager } from './KeyManager.js';

// Key derivation
export {
  generateMnemonic,
  validateMnemonic,
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
