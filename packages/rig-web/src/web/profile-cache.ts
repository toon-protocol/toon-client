/**
 * Profile enrichment cache for Rig-UI.
 *
 * Fetches kind:0 profile events for pubkeys and provides display names.
 * Falls back to truncated npub for missing profiles.
 */

import { truncateNpubFromHex } from './npub.js';

/**
 * Cached profile data from a kind:0 event. The whole parsed content JSON is
 * stored, so these are the standard NIP-24 metadata fields (snake_case on the
 * wire; `displayName` kept as a camelCase alias some clients emit).
 */
export interface ProfileData {
  name?: string;
  display_name?: string;
  displayName?: string;
  about?: string;
  picture?: string;
  banner?: string;
  nip05?: string;
  website?: string;
  lud16?: string;
}

/**
 * Truncate a hex pubkey to a display-friendly npub format.
 * Re-exported for test compatibility with ATDD stubs.
 */
export function truncateNpub(hexPubkey: string): string {
  return truncateNpubFromHex(hexPubkey);
}

/**
 * Cache for Nostr profile data.
 *
 * Stores profile info from kind:0 events and provides display name resolution
 * with truncated npub fallback.
 */
/** Maximum number of profiles to cache to prevent unbounded memory growth. */
const PROFILE_CACHE_MAX_SIZE = 5000;

export class ProfileCache {
  private profiles = new Map<string, ProfileData>();
  private requested = new Set<string>();

  /**
   * Set profile data for a pubkey (from a kind:0 event).
   */
  setProfile(pubkey: string, profile: ProfileData): void {
    // Evict oldest entry if cache exceeds max size
    if (
      this.profiles.size >= PROFILE_CACHE_MAX_SIZE &&
      !this.profiles.has(pubkey)
    ) {
      const firstKey = this.profiles.keys().next().value;
      if (firstKey !== undefined) {
        this.profiles.delete(firstKey);
      }
    }
    this.profiles.set(pubkey, profile);
    this.requested.add(pubkey);
  }

  /**
   * Get a display name for a pubkey.
   *
   * Returns displayName > name > truncated npub (in priority order).
   */
  getDisplayName(pubkey: string): string {
    const profile = this.profiles.get(pubkey);
    if (profile) {
      if (profile.display_name) return profile.display_name;
      if (profile.displayName) return profile.displayName;
      if (profile.name) return profile.name;
    }
    return truncateNpub(pubkey);
  }

  /** The full cached kind:0 profile for a pubkey, if one has been fetched. */
  getProfile(pubkey: string): ProfileData | undefined {
    return this.profiles.get(pubkey);
  }

  /**
   * Check if a profile has been fetched for a pubkey.
   */
  hasProfile(pubkey: string): boolean {
    return this.profiles.has(pubkey);
  }

  /**
   * Get the list of pubkeys that need to be fetched, deduplicating
   * against already-requested pubkeys.
   */
  getPendingPubkeys(pubkeys: string[]): string[] {
    const unique = [...new Set(pubkeys)];
    return unique.filter((pk) => !this.requested.has(pk));
  }

  /**
   * Mark pubkeys as requested (even if no profile was found).
   */
  markRequested(pubkeys: string[]): void {
    for (const pk of pubkeys) {
      // Bound the requested set to prevent unbounded memory growth
      if (
        this.requested.size >= PROFILE_CACHE_MAX_SIZE * 2 &&
        !this.requested.has(pk)
      ) {
        const firstKey = this.requested.values().next().value;
        if (firstKey !== undefined) {
          this.requested.delete(firstKey);
        }
      }
      this.requested.add(pk);
    }
  }
}
