import { getPublicKey } from 'nostr-tools/pure';
import type { BackupPayload, VaultData } from './types.js';

/**
 * Relay-based encrypted backup service using kind:30078 (NIP-78 application-specific data).
 *
 * The backup event is a replaceable event keyed by `d: "toon:identity-backup"`.
 * Content is an encrypted payload — the relay cannot read the mnemonic.
 */

const BACKUP_KIND = 30078;
const BACKUP_D_TAG = 'toon:identity-backup';
const BACKUP_VERSION = '1';

/**
 * Build a kind:30078 Nostr event for identity backup.
 * The event must be signed by the caller before publishing.
 *
 * @param vault - The encrypted vault data
 * @param secretKey - Nostr secret key for signing
 * @param chains - Comma-separated list of supported chains
 * @returns Unsigned Nostr event template
 */
export function buildBackupEvent(
  vault: VaultData,
  secretKey: Uint8Array,
  chains = 'nostr,evm,solana,mina'
): {
  kind: number;
  pubkey: string;
  created_at: number;
  tags: string[][];
  content: string;
} {
  const pubkey = getPublicKey(secretKey);

  const payload: BackupPayload = {
    encrypted_mnemonic: vault.encryptedMnemonic,
    wrapped_keys: vault.wrappedKeys,
    iv: vault.iv,
    ...(vault.recoveryCodeWrappedDek && {
      recovery_code_wrapped_dek: vault.recoveryCodeWrappedDek,
    }),
    ...(vault.recoveryCodeSalt && {
      recovery_code_salt: vault.recoveryCodeSalt,
    }),
  };

  return {
    kind: BACKUP_KIND,
    pubkey,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['d', BACKUP_D_TAG],
      ['v', BACKUP_VERSION],
      ['chains', chains],
    ],
    content: JSON.stringify(payload),
  };
}

/**
 * Build a relay filter to fetch the identity backup for a given pubkey.
 */
export function buildBackupFilter(pubkey: string): {
  kinds: number[];
  authors: string[];
  '#d': string[];
} {
  return {
    kinds: [BACKUP_KIND],
    authors: [pubkey],
    '#d': [BACKUP_D_TAG],
  };
}

/**
 * Parse a backup event's content into VaultData.
 * Validates the structure before returning.
 */
export function parseBackupPayload(content: string): VaultData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('Invalid backup event content: not valid JSON');
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Invalid backup event content: not an object');
  }

  const payload = parsed as Record<string, unknown>;

  if (typeof payload['encrypted_mnemonic'] !== 'string') {
    throw new Error('Invalid backup: missing encrypted_mnemonic');
  }
  if (typeof payload['iv'] !== 'string') {
    throw new Error('Invalid backup: missing iv');
  }
  if (!Array.isArray(payload['wrapped_keys'])) {
    throw new Error('Invalid backup: missing wrapped_keys array');
  }

  // Validate each wrapped key entry
  for (const entry of payload['wrapped_keys']) {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error('Invalid backup: wrapped_keys entry is not an object');
    }
    const e = entry as Record<string, unknown>;
    if (typeof e['id'] !== 'string') {
      throw new Error('Invalid backup: wrapped key missing id');
    }
    if (typeof e['wrapped_dek'] !== 'string') {
      throw new Error('Invalid backup: wrapped key missing wrapped_dek');
    }
    if (typeof e['salt'] !== 'string') {
      throw new Error('Invalid backup: wrapped key missing salt');
    }
    if (typeof e['created_at'] !== 'number') {
      throw new Error('Invalid backup: wrapped key missing or invalid created_at');
    }
  }

  return {
    encryptedMnemonic: payload['encrypted_mnemonic'] as string,
    iv: payload['iv'] as string,
    wrappedKeys: payload['wrapped_keys'] as VaultData['wrappedKeys'],
    ...(typeof payload['recovery_code_wrapped_dek'] === 'string' && {
      recoveryCodeWrappedDek: payload['recovery_code_wrapped_dek'],
    }),
    ...(typeof payload['recovery_code_salt'] === 'string' && {
      recoveryCodeSalt: payload['recovery_code_salt'],
    }),
  };
}

/**
 * Publish a backup event to one or more relays.
 *
 * Uses the SimplePool from nostr-tools for relay communication.
 * The event must be signed before calling this function.
 */
export async function publishBackupToRelays(
  signedEvent: {
    id: string;
    kind: number;
    pubkey: string;
    created_at: number;
    tags: string[][];
    content: string;
    sig: string;
  },
  relayUrls: string[]
): Promise<void> {
  // Dynamic import to avoid pulling nostr-tools/pool into non-browser bundles
  // @ts-expect-error -- nostr-tools pool is a peer dependency
  const { SimplePool } = await import('nostr-tools/pool');
  const pool = new SimplePool();

  try {
    await Promise.allSettled(
      relayUrls.map((url) => pool.publish([url], signedEvent))
    );
  } finally {
    pool.close(relayUrls);
  }
}

/**
 * Fetch a backup event from relays for a given pubkey.
 * Returns the most recent backup event, or null if none found.
 */
export async function fetchBackupFromRelays(
  pubkey: string,
  relayUrls: string[]
): Promise<VaultData | null> {
  // @ts-expect-error -- nostr-tools pool is a peer dependency
  const { SimplePool } = await import('nostr-tools/pool');
  const pool = new SimplePool();

  try {
    const filter = buildBackupFilter(pubkey);
    const events = await pool.querySync(relayUrls, filter);

    if (!events || events.length === 0) {
      return null;
    }

    // Sort by created_at descending, take most recent
    events.sort(
      (
        a: { created_at: number },
        b: { created_at: number }
      ) => b.created_at - a.created_at
    );

    return parseBackupPayload(events[0].content);
  } finally {
    pool.close(relayUrls);
  }
}
