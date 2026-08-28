export {
  generateMnemonic,
  validateMnemonic,
  deriveFullIdentity,
  evmDerivationPath,
  evmIdentityFromKey,
  generateRandomIdentity,
  type DeriveIdentityOptions,
} from './KeyDerivation.js';

// `KeyDerivationScheme` is also surfaced by `client/types.ts`, which re-exports
// this very declaration rather than restating it — so both barrels resolve to
// one type and the package barrel can carry it from here too.
export type { KeyDerivationScheme } from './KeyDerivation.js';

export type { DerivedIdentity } from './types.js';

// Node-only encrypted mnemonic keystore (scrypt + AES-256-GCM). The file
// records which derivation its phrase is read under; a pre-1.0 file records
// none and is read as `legacy`, so existing addresses do not move.
export {
  encryptMnemonic,
  decryptMnemonic,
  generateKeystore,
  importKeystore,
  openKeystore,
  loadKeystore,
  writeKeystoreFile,
  keystoreDerivation,
  KEYSTORE_VERSION,
  type EncryptedKeystore,
  type OpenedKeystore,
  type WriteKeystoreOptions,
} from './keystore-node.js';
