// Test IDs: 8.1-UNIT-001
// AC covered: AC4 (Relay query builder for kind:30617)

import { describe, it, expect } from 'vitest';

import {
  buildRepoListFilter,
  buildProfileFilter,
  buildRepoRefsFilter,
} from './relay-client.js';

describe('Relay Query Builder', () => {
  // ---------------------------------------------------------------------------
  // 8.1-UNIT-001: buildRepoListFilter returns correct Nostr filter
  // AC: #4
  // ---------------------------------------------------------------------------

  it('[P1] buildRepoListFilter returns filter with kinds [30617]', () => {
    // Arrange & Act
    const filter = buildRepoListFilter();

    // Assert
    expect(filter).toEqual({ kinds: [30617] });
  });

  it('[P1] buildRepoListFilter returns an object with a kinds array', () => {
    // Arrange & Act
    const filter = buildRepoListFilter();

    // Assert
    expect(filter).toHaveProperty('kinds');
    expect(Array.isArray(filter.kinds)).toBe(true);
    expect(filter.kinds).toHaveLength(1);
  });
});

describe('Profile Query Builder', () => {
  it('[P2] buildProfileFilter returns filter with kinds [0] and specified authors', () => {
    // Arrange
    const pubkeys = ['ab'.repeat(32), 'cd'.repeat(32)];

    // Act
    const filter = buildProfileFilter(pubkeys);

    // Assert
    expect(filter).toEqual({ kinds: [0], authors: pubkeys });
  });

  it('[P2] buildProfileFilter with empty pubkeys returns empty authors', () => {
    // Act
    const filter = buildProfileFilter([]);

    // Assert
    expect(filter).toEqual({ kinds: [0], authors: [] });
  });
});

describe('Repo Refs Query Builder', () => {
  // ---------------------------------------------------------------------------
  // AC: #2 — buildRepoRefsFilter
  // ---------------------------------------------------------------------------

  it('[P1] buildRepoRefsFilter returns correct filter for kind:30618', () => {
    const pubkey = 'ab'.repeat(32);
    const repoId = 'my-repo';

    const filter = buildRepoRefsFilter(pubkey, repoId);

    expect(filter).toEqual({
      kinds: [30618],
      authors: [pubkey],
      '#d': [repoId],
    });
  });
});
