import { finalizeEvent } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';
import { EvmSigner } from '../signing/evm-signer.js';
import { SolanaSigner } from '../signing/solana-signer.js';
import { MinaSigner } from '../signing/mina-signer.js';
import type {
  KeyManagerConfig,
  PasskeyInfo,
  ToonIdentity,
  VaultData,
} from './types.js';
import {
  deriveFullIdentity,
  deriveFromNsec,
  generateMnemonic,
  validateMnemonic,
} from './KeyDerivation.js';
import {
  registerPasskey,
  assertPasskey,
  hashCredentialId,
  isPrfSupported,
} from './PasskeyAuth.js';
import {
  createVault,
  deriveKek,
  deriveKekFromPassword,
  unlockVault,
  addKekToVault,
  removeKekFromVault,
  addRecoveryCodeToVault,
  unlockVaultWithRecoveryCode,
  generateRecoveryCode as generateRecoveryCodeRaw,
} from './KeyVault.js';
import {
  buildBackupEvent,
  publishBackupToRelays,
  fetchBackupFromRelays,
} from './BackupService.js';
import { fromBase64, hexToBytes, bytesToHex } from './encoding.js';

/**
 * KeyManager orchestrates the full key lifecycle:
 * generate, derive, store, backup, recover — gated by WebAuthn Passkeys.
 *
 * Usage:
 *   const km = new KeyManager({ relayUrls: ['wss://relay.example'] });
 *   const identity = await km.create();
 *   // or: const identity = await km.recover();
 *
 *   const client = new ToonClient({
 *     secretKey: identity.nostr.secretKey,
 *     // ...
 *   });
 *
 * Security note: JavaScript strings (like mnemonics) are immutable and cannot be
 * zeroed from memory. Uint8Array key material is zeroed on lock(), but mnemonic
 * strings persist until garbage collected. This is a known JS platform limitation.
 */
export class KeyManager {
  private readonly config: Required<KeyManagerConfig>;
  private identity: ToonIdentity | null = null;
  private vault: VaultData | null = null;
  private activeCredentialIdHash: string | null = null;

  constructor(config: KeyManagerConfig) {
    if (!config.relayUrls || config.relayUrls.length === 0) {
      throw new Error('KeyManager requires at least one relay URL');
    }

    this.config = {
      relayUrls: config.relayUrls,
      rpId:
        config.rpId ??
        (typeof window !== 'undefined' ? window.location.hostname : 'localhost'),
      rpName: config.rpName ?? 'TOON Protocol',
      storageKey: config.storageKey ?? 'toon:keys',
    };
  }

  // --- Account Lifecycle ---

  /**
   * Create a new account: generate mnemonic, create Passkey, encrypt, backup.
   */
  async create(): Promise<ToonIdentity> {
    const mnemonic = generateMnemonic();
    const identity = await deriveFullIdentity(mnemonic);

    // Generate a unique PRF salt for this credential
    const prfSalt = crypto.getRandomValues(new Uint8Array(32));

    // Convert pubkey hex to bytes for userHandle
    const userIdBytes = hexToBytes(identity.nostr.pubkey);

    // Register Passkey with PRF
    const registration = await registerPasskey({
      rpId: this.config.rpId,
      rpName: this.config.rpName,
      userId: userIdBytes,
      userName: `TOON ${identity.nostr.pubkey.slice(0, 8)}`,
      prfSalt,
    });

    // Derive KEK from PRF output
    const kek = await deriveKek(registration.prfOutput);
    const credIdHash = await hashCredentialId(registration.credentialId);

    // Create encrypted vault
    this.vault = await createVault(mnemonic, kek, credIdHash, prfSalt);
    this.identity = identity;
    this.activeCredentialIdHash = credIdHash;

    // Persist to IndexedDB
    await this.saveToLocalStorage();

    // Backup to relay (best-effort)
    await this.backupToRelay().catch(() => {
      // Backup failure is non-fatal — local vault is still available
    });

    return identity;
  }

  /**
   * Recover an account using a synced Passkey.
   * The Nostr pubkey is extracted from the Passkey's userHandle.
   *
   * Flow: single assertion → userHandle → fetch backup → derive KEK → unlock.
   * If the local vault is available (has the PRF salt), we use a single assertion
   * with the correct salt. Otherwise, we need the backup from relays first, which
   * requires a discovery assertion to get the pubkey.
   */
  async recover(): Promise<ToonIdentity> {
    // Check local vault first — if available, we can do a single-assertion unlock
    const localVault = await this.loadFromLocalStorage();
    if (localVault) {
      return this.unlockWithVault(localVault);
    }

    // No local vault — need to discover pubkey from Passkey userHandle,
    // fetch backup from relays, then do a second assertion with the correct salt.
    // This is the cross-device recovery path (two assertions unavoidable).
    const discovery = await assertPasskey({
      rpId: this.config.rpId,
      prfSalt: crypto.getRandomValues(new Uint8Array(32)), // Dummy salt for discovery
    });

    if (!discovery.userHandle || discovery.userHandle.length === 0) {
      throw new Error(
        'Passkey did not return a userHandle. Cannot determine Nostr pubkey for recovery.'
      );
    }

    // Extract Nostr pubkey from userHandle
    const pubkey = bytesToHex(discovery.userHandle);

    // Fetch backup from relays
    const vault = await fetchBackupFromRelays(pubkey, this.config.relayUrls);
    if (!vault) {
      throw new Error(
        'No backup found on configured relays for this identity. ' +
          'Try importing with a mnemonic or nsec instead.'
      );
    }

    // Find the matching wrapped key entry for this credential
    const credIdHash = await hashCredentialId(discovery.credentialId);
    const entry = vault.wrappedKeys.find((e) => e.id === credIdHash);
    if (!entry) {
      throw new Error(
        'This Passkey is not registered with the backup. ' +
          'Try a different Passkey or use a recovery code.'
      );
    }

    // Re-assert with the correct PRF salt from the backup
    const saltBytes = fromBase64(entry.salt);
    const reassertion = await assertPasskey({
      rpId: this.config.rpId,
      prfSalt: saltBytes,
      allowCredentials: [discovery.credentialId],
    });

    // Derive KEK and unlock vault
    const kek = await deriveKek(reassertion.prfOutput);
    const mnemonic = await unlockVault(vault, kek, credIdHash);
    const identity = await deriveFullIdentity(mnemonic);

    this.vault = vault;
    this.identity = identity;
    this.activeCredentialIdHash = credIdHash;

    // Cache locally for future single-assertion unlocks
    await this.saveToLocalStorage();

    return identity;
  }

  /**
   * Import an existing BIP-39 mnemonic. Creates a Passkey and backup.
   */
  async importMnemonic(mnemonic: string): Promise<ToonIdentity> {
    if (!validateMnemonic(mnemonic)) {
      throw new Error('Invalid BIP-39 mnemonic phrase');
    }

    const identity = await deriveFullIdentity(mnemonic);
    const prfSalt = crypto.getRandomValues(new Uint8Array(32));
    const userIdBytes = hexToBytes(identity.nostr.pubkey);

    const registration = await registerPasskey({
      rpId: this.config.rpId,
      rpName: this.config.rpName,
      userId: userIdBytes,
      userName: `TOON ${identity.nostr.pubkey.slice(0, 8)}`,
      prfSalt,
    });

    const kek = await deriveKek(registration.prfOutput);
    const credIdHash = await hashCredentialId(registration.credentialId);

    this.vault = await createVault(mnemonic, kek, credIdHash, prfSalt);
    this.identity = identity;
    this.activeCredentialIdHash = credIdHash;

    await this.saveToLocalStorage();
    await this.backupToRelay().catch(() => {
      // Backup failure is non-fatal
    });

    return identity;
  }

  /**
   * Import from an nsec (Nostr-only key).
   * Nostr + EVM are derived; Solana + Mina get fresh keys (not deterministically linked).
   */
  async importNsec(nsec: string): Promise<ToonIdentity> {
    const decoded = nip19.decode(nsec);
    if (decoded.type !== 'nsec') {
      throw new Error('Invalid nsec string');
    }
    const secretKey = decoded.data;
    const identity = deriveFromNsec(secretKey);

    if (isPrfSupported()) {
      const prfSalt = crypto.getRandomValues(new Uint8Array(32));
      const userIdBytes = hexToBytes(identity.nostr.pubkey);

      try {
        const registration = await registerPasskey({
          rpId: this.config.rpId,
          rpName: this.config.rpName,
          userId: userIdBytes,
          userName: `TOON ${identity.nostr.pubkey.slice(0, 8)}`,
          prfSalt,
        });

        const kek = await deriveKek(registration.prfOutput);
        const credIdHash = await hashCredentialId(registration.credentialId);

        // For nsec import without mnemonic, we store the hex-encoded secret key
        const hexKey = bytesToHex(secretKey);
        this.vault = await createVault(hexKey, kek, credIdHash, prfSalt);
        this.activeCredentialIdHash = credIdHash;

        await this.saveToLocalStorage();
      } catch {
        // PRF may be reported as supported but fail at registration time.
        // Proceed without vault — identity is still usable.
      }
    }

    this.identity = identity;
    return identity;
  }

  // --- Passkey Management ---

  /**
   * Register an additional Passkey for this identity.
   */
  async addPasskey(): Promise<void> {
    if (!this.identity || !this.vault || !this.activeCredentialIdHash) {
      throw new Error('No active identity — call create() or recover() first');
    }

    const prfSalt = crypto.getRandomValues(new Uint8Array(32));
    const userIdBytes = hexToBytes(this.identity.nostr.pubkey);

    const registration = await registerPasskey({
      rpId: this.config.rpId,
      rpName: this.config.rpName,
      userId: userIdBytes,
      userName: `TOON ${this.identity.nostr.pubkey.slice(0, 8)}`,
      prfSalt,
    });

    const newKek = await deriveKek(registration.prfOutput);
    const newCredIdHash = await hashCredentialId(registration.credentialId);

    // Re-assert the current Passkey to get KEK for unwrapping
    const currentEntry = this.vault.wrappedKeys.find(
      (e) => e.id === this.activeCredentialIdHash
    );
    if (!currentEntry) {
      throw new Error('Active credential not found in vault');
    }

    const currentSaltBytes = fromBase64(currentEntry.salt);
    const currentAssertion = await assertPasskey({
      rpId: this.config.rpId,
      prfSalt: currentSaltBytes,
    });
    const currentKek = await deriveKek(currentAssertion.prfOutput);

    this.vault = await addKekToVault(
      this.vault,
      currentKek,
      this.activeCredentialIdHash,
      newKek,
      newCredIdHash,
      prfSalt
    );

    await this.saveToLocalStorage();
    await this.backupToRelay().catch(() => {
      // Backup failure is non-fatal
    });
  }

  /**
   * List registered Passkey credentials.
   */
  listPasskeys(): PasskeyInfo[] {
    if (!this.vault) return [];
    return this.vault.wrappedKeys.map((entry) => ({
      credentialIdHash: entry.id,
      createdAt: entry.created_at,
    }));
  }

  /**
   * Remove a Passkey from the vault. Cannot remove the last one.
   */
  async removePasskey(credentialIdHash: string): Promise<void> {
    if (!this.vault) {
      throw new Error('No active vault');
    }

    this.vault = removeKekFromVault(this.vault, credentialIdHash);

    // If we removed the active credential, switch to another
    if (this.activeCredentialIdHash === credentialIdHash) {
      const remaining = this.vault.wrappedKeys[0];
      this.activeCredentialIdHash = remaining ? remaining.id : null;
    }

    await this.saveToLocalStorage();
    await this.backupToRelay().catch(() => {
      // Backup failure is non-fatal
    });
  }

  // --- Recovery ---

  /**
   * Generate a printable recovery code and add it to the vault.
   * The PBKDF2 salt is persisted alongside the wrapped DEK so the code
   * can be verified later without the original salt.
   *
   * @returns The recovery code — user must store it securely.
   */
  async generateRecoveryCode(): Promise<string> {
    if (!this.vault || !this.activeCredentialIdHash) {
      throw new Error('No active vault');
    }

    const code = generateRecoveryCodeRaw();

    // Generate and persist PBKDF2 salt for recovery code
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const recoveryKek = await deriveKekFromPassword(code, salt);

    // Get current KEK to unwrap DEK
    const currentEntry = this.vault.wrappedKeys.find(
      (e) => e.id === this.activeCredentialIdHash
    );
    if (!currentEntry) {
      throw new Error('Active credential not found in vault');
    }

    const currentSaltBytes = fromBase64(currentEntry.salt);
    const currentAssertion = await assertPasskey({
      rpId: this.config.rpId,
      prfSalt: currentSaltBytes,
    });
    const currentKek = await deriveKek(currentAssertion.prfOutput);

    this.vault = await addRecoveryCodeToVault(
      this.vault,
      currentKek,
      this.activeCredentialIdHash,
      recoveryKek,
      salt
    );

    await this.saveToLocalStorage();
    await this.backupToRelay().catch(() => {
      // Backup failure is non-fatal
    });

    return code;
  }

  /**
   * Recover identity using a recovery code.
   * The PBKDF2 salt is read from the persisted vault data.
   */
  async recoverWithCode(code: string): Promise<ToonIdentity> {
    const vault = await this.loadFromLocalStorage();

    if (!vault) {
      throw new Error(
        'No local vault found. Recovery code requires the encrypted vault. ' +
          'If you have a Passkey, use recover() to fetch from relays first.'
      );
    }

    if (!vault.recoveryCodeWrappedDek || !vault.recoveryCodeSalt) {
      throw new Error('No recovery code configured for this vault');
    }

    // Use the persisted PBKDF2 salt to reproduce the exact KEK
    const salt = fromBase64(vault.recoveryCodeSalt);
    const recoveryKek = await deriveKekFromPassword(code, salt);

    const mnemonic = await unlockVaultWithRecoveryCode(vault, recoveryKek);
    const identity = await deriveFullIdentity(mnemonic);

    this.vault = vault;
    this.identity = identity;

    return identity;
  }

  // --- Key Access ---

  /**
   * Get the current identity, or null if not unlocked.
   */
  getIdentity(): ToonIdentity | null {
    return this.identity;
  }

  /**
   * Get the Nostr secret key. Throws if not unlocked.
   */
  getNostrSecretKey(): Uint8Array {
    if (!this.identity) throw new Error('Identity not unlocked');
    return this.identity.nostr.secretKey;
  }

  /**
   * Get an EvmSigner instance. Throws if not unlocked.
   */
  getEvmSigner(): EvmSigner {
    if (!this.identity) throw new Error('Identity not unlocked');
    return new EvmSigner(this.identity.evm.privateKey);
  }

  /**
   * Get a SolanaSigner instance. Throws if not unlocked or Solana not derived.
   */
  getSolanaSigner(): SolanaSigner {
    if (!this.identity) throw new Error('Identity not unlocked');
    if (!this.identity.solana.publicKey) {
      throw new Error('Solana keys not available — was this imported from nsec?');
    }
    return new SolanaSigner(this.identity.solana.secretKey);
  }

  /**
   * Get a MinaSigner instance. Throws if not unlocked or Mina not derived.
   */
  getMinaSigner(): MinaSigner {
    if (!this.identity) throw new Error('Identity not unlocked');
    if (!this.identity.mina.publicKey) {
      throw new Error('Mina keys not available — was this imported from nsec?');
    }
    return new MinaSigner(this.identity.mina.privateKey);
  }

  // --- Backup ---

  /**
   * Publish the current vault to configured relays as a kind:30078 event.
   */
  async backupToRelay(): Promise<void> {
    if (!this.identity || !this.vault) {
      throw new Error('No active identity or vault to backup');
    }

    const eventTemplate = buildBackupEvent(
      this.vault,
      this.identity.nostr.secretKey
    );

    // Sign with nostr-tools
    const signedEvent = finalizeEvent(
      eventTemplate,
      this.identity.nostr.secretKey
    );

    await publishBackupToRelays(signedEvent, this.config.relayUrls);
  }

  // --- Lock/Unlock ---

  /**
   * Clear keys from memory. The vault remains in IndexedDB.
   * Note: JavaScript strings (mnemonics) cannot be zeroed — only Uint8Array keys are cleared.
   */
  lock(): void {
    if (this.identity) {
      // Zero out sensitive Uint8Array key material
      this.identity.nostr.secretKey.fill(0);
      // evm.privateKey may be the same reference as nostr.secretKey — fill is idempotent
      this.identity.evm.privateKey.fill(0);
      this.identity.solana.secretKey.fill(0);
    }
    this.identity = null;
  }

  /**
   * Re-assert Passkey to decrypt local vault and restore identity.
   * Uses the local vault's stored PRF salt for a single biometric prompt.
   */
  async unlock(): Promise<ToonIdentity> {
    const vault = await this.loadFromLocalStorage();
    if (!vault) {
      throw new Error('No local vault found — use create() or recover()');
    }

    return this.unlockWithVault(vault);
  }

  // --- Private helpers ---

  /**
   * Unlock a vault with a single Passkey assertion using stored PRF salts.
   * If the vault has only one credential, uses allowCredentials to constrain.
   */
  private async unlockWithVault(vault: VaultData): Promise<ToonIdentity> {
    // We don't have the raw credential IDs (only hashes), so we can't constrain
    // allowCredentials. The user picks a credential, then we verify it matches.
    const firstEntry = vault.wrappedKeys[0];
    if (!firstEntry) {
      throw new Error('Vault has no registered credentials');
    }

    const assertion = await assertPasskey({
      rpId: this.config.rpId,
      prfSalt: fromBase64(firstEntry.salt),
    });

    const credIdHash = await hashCredentialId(assertion.credentialId);
    const matchingEntry = vault.wrappedKeys.find((e) => e.id === credIdHash);

    if (!matchingEntry) {
      throw new Error('This Passkey is not registered with the local vault');
    }

    // If the user picked the first credential, we already have the correct PRF output.
    // If they picked a different one, we need to re-assert with the correct salt.
    let prfOutput = assertion.prfOutput;
    if (matchingEntry.id !== firstEntry.id) {
      const correctSalt = fromBase64(matchingEntry.salt);
      const reassertion = await assertPasskey({
        rpId: this.config.rpId,
        prfSalt: correctSalt,
        allowCredentials: [assertion.credentialId],
      });
      prfOutput = reassertion.prfOutput;
    }

    const kek = await deriveKek(prfOutput);
    const mnemonic = await unlockVault(vault, kek, credIdHash);
    const identity = await deriveFullIdentity(mnemonic);

    this.vault = vault;
    this.identity = identity;
    this.activeCredentialIdHash = credIdHash;

    return identity;
  }

  // --- IndexedDB Persistence ---

  private async saveToLocalStorage(): Promise<void> {
    if (!this.vault) return;
    if (typeof indexedDB === 'undefined') return;

    const dbName = this.config.storageKey;
    const db = await openDb(dbName);
    const tx = db.transaction('vault', 'readwrite');
    const store = tx.objectStore('vault');
    store.put(JSON.stringify(this.vault), 'current');
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }

  private async loadFromLocalStorage(): Promise<VaultData | null> {
    if (typeof indexedDB === 'undefined') return null;

    const dbName = this.config.storageKey;
    try {
      const db = await openDb(dbName);
      const tx = db.transaction('vault', 'readonly');
      const store = tx.objectStore('vault');
      const request = store.get('current');
      const result = await new Promise<string | undefined>(
        (resolve, reject) => {
          request.onsuccess = () => resolve(request.result as string | undefined);
          request.onerror = () => reject(request.error);
        }
      );
      db.close();
      if (!result) return null;
      return JSON.parse(result) as VaultData;
    } catch {
      return null;
    }
  }
}

// --- Helpers ---

function openDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('vault')) {
        db.createObjectStore('vault');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
