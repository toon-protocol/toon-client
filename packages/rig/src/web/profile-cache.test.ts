// Test IDs: 8.1-UNIT-004
// AC covered: AC6 (Profile enrichment with truncated npub fallback)

import { describe, it, expect } from 'vitest';

import { ProfileCache, truncateNpub } from './profile-cache.js';

// ============================================================================
// Factories
// ============================================================================

/**
 * Factory for creating a hex pubkey (64 chars).
 */
function createMockPubkey(prefix = 'ab'): string {
  return prefix.repeat(32).slice(0, 64);
}

describe('ProfileCache - Truncated Npub Fallback', () => {
  // ---------------------------------------------------------------------------
  // 8.1-UNIT-004: Missing profile falls back to truncated npub
  // AC: #6
  // ---------------------------------------------------------------------------

  it('[P2] truncateNpub returns first 8 + last 4 chars of npub-encoded pubkey', () => {
    // Arrange
    const pubkey = createMockPubkey();

    // Act
    const displayName = truncateNpub(pubkey);

    // Assert -- npub1 prefix + first 8 chars + "..." + last 4 chars
    expect(displayName).toMatch(/^npub1[a-z0-9]{8}\.{3}[a-z0-9]{4}$/);
  });

  it('[P2] ProfileCache returns truncated npub when no kind:0 profile exists', () => {
    // Arrange
    const pubkey = createMockPubkey();
    const cache = new ProfileCache();

    // Act
    const displayName = cache.getDisplayName(pubkey);

    // Assert -- should fall back to truncated npub since no profile was fetched
    expect(displayName).toMatch(/^npub1/);
    expect(displayName).toContain('...');
  });

  it('[P2] ProfileCache returns profile name when kind:0 profile is cached', () => {
    // Arrange
    const pubkey = createMockPubkey();
    const cache = new ProfileCache();
    cache.setProfile(pubkey, { name: 'Alice', displayName: 'Alice Dev' });

    // Act
    const displayName = cache.getDisplayName(pubkey);

    // Assert
    expect(displayName).toBe('Alice Dev');
  });

  it('[P2] ProfileCache deduplicates pubkey lookups', () => {
    // Arrange
    const pubkey = createMockPubkey();
    const cache = new ProfileCache();

    // Act -- request same pubkey twice
    const pubkeys = cache.getPendingPubkeys([pubkey, pubkey, pubkey]);

    // Assert -- should deduplicate
    expect(pubkeys).toHaveLength(1);
    expect(pubkeys[0]).toBe(pubkey);
  });

  it('[P2] ProfileCache returns name when displayName is absent', () => {
    // Arrange
    const pubkey = createMockPubkey();
    const cache = new ProfileCache();
    cache.setProfile(pubkey, { name: 'Bob' });

    // Act
    const displayName = cache.getDisplayName(pubkey);

    // Assert -- should fall back to name field
    expect(displayName).toBe('Bob');
  });

  it('[P2] ProfileCache.markRequested prevents re-fetching', () => {
    // Arrange
    const pubkey = createMockPubkey('cd');
    const cache = new ProfileCache();
    cache.markRequested([pubkey]);

    // Act
    const pending = cache.getPendingPubkeys([pubkey]);

    // Assert -- already requested, should not be pending
    expect(pending).toHaveLength(0);
  });

  it('[P2] ProfileCache.hasProfile returns false for unknown pubkey', () => {
    // Arrange
    const cache = new ProfileCache();

    // Act & Assert
    expect(cache.hasProfile(createMockPubkey())).toBe(false);
  });

  it('[P2] ProfileCache.hasProfile returns true after setProfile', () => {
    // Arrange
    const pubkey = createMockPubkey();
    const cache = new ProfileCache();
    cache.setProfile(pubkey, { name: 'Test' });

    // Act & Assert
    expect(cache.hasProfile(pubkey)).toBe(true);
  });
});
