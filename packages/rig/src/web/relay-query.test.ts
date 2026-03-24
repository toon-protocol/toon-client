// Test IDs: 8.1-UNIT-001
// AC covered: AC4 (Relay query builder for kind:30617)

import { describe, it, expect } from 'vitest';

import {
  buildRepoListFilter,
  buildProfileFilter,
  buildRepoRefsFilter,
  buildIssueListFilter,
  buildCommentFilter,
  buildPRListFilter,
  buildStatusFilter,
  buildEventByIdFilter,
  buildIssueCloseFilter,
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

// ============================================================================
// Story 8.5: Issue/PR/Comment Query Builders
// Test IDs: 8.5-UNIT-001, 8.5-UNIT-002, 8.5-UNIT-003
// ============================================================================

describe('Issue Query Builder (8.5-UNIT-001)', () => {
  it('[P1] buildIssueListFilter returns filter with kind:1621 and #a tag', () => {
    const pubkey = 'ab'.repeat(32);
    const repoId = 'my-repo';

    const filter = buildIssueListFilter(pubkey, repoId);

    expect(filter).toEqual({
      kinds: [1621],
      '#a': [`30617:${pubkey}:${repoId}`],
      limit: 100,
    });
  });
});

describe('Comment Query Builder (8.5-UNIT-002)', () => {
  it('[P1] buildCommentFilter returns filter with kind:1622 and #e tag', () => {
    const eventIds = ['aaa', 'bbb'];

    const filter = buildCommentFilter(eventIds);

    expect(filter).toEqual({
      kinds: [1622],
      '#e': eventIds,
      limit: 500,
    });
  });
});

describe('PR Query Builder (8.5-UNIT-003)', () => {
  it('[P1] buildPRListFilter returns filter with kind:1617 and #a tag', () => {
    const pubkey = 'cd'.repeat(32);
    const repoId = 'other-repo';

    const filter = buildPRListFilter(pubkey, repoId);

    expect(filter).toEqual({
      kinds: [1617],
      '#a': [`30617:${pubkey}:${repoId}`],
      limit: 100,
    });
  });
});

describe('Status Query Builder', () => {
  it('[P1] buildStatusFilter returns filter with kind:1630-1633 and #e tag', () => {
    const eventIds = ['pr1', 'pr2'];

    const filter = buildStatusFilter(eventIds);

    expect(filter).toEqual({
      kinds: [1630, 1631, 1632, 1633],
      '#e': eventIds,
      limit: 500,
    });
  });
});

describe('Event By ID Query Builder', () => {
  it('[P1] buildEventByIdFilter returns filter with ids field', () => {
    const eventIds = ['event1', 'event2'];

    const filter = buildEventByIdFilter(eventIds);

    expect(filter).toEqual({ ids: eventIds });
  });
});

describe('Issue Close Query Builder', () => {
  it('[P1] buildIssueCloseFilter returns filter with kind:1632 and #e tag', () => {
    const eventIds = ['issue1', 'issue2'];

    const filter = buildIssueCloseFilter(eventIds);

    expect(filter).toEqual({
      kinds: [1632],
      '#e': eventIds,
      limit: 500,
    });
  });
});

// ============================================================================
// NFR: Edge cases for query builders
// ============================================================================

describe('Query Builders - NFR Edge Cases', () => {
  it('[P2] buildIssueListFilter constructs correct #a tag with special chars in repoId', () => {
    const pubkey = 'ab'.repeat(32);
    const repoId = 'my-repo/special:chars';

    const filter = buildIssueListFilter(pubkey, repoId);

    // The #a tag must contain the exact repoId, including special characters
    expect(filter['#a']).toEqual([`30617:${pubkey}:${repoId}`]);
  });

  it('[P2] buildPRListFilter constructs correct #a tag with special chars in repoId', () => {
    const pubkey = 'cd'.repeat(32);
    const repoId = 'repo-with.dots';

    const filter = buildPRListFilter(pubkey, repoId);

    expect(filter['#a']).toEqual([`30617:${pubkey}:${repoId}`]);
  });

  it('[P2] buildCommentFilter with empty array returns filter with empty #e', () => {
    const filter = buildCommentFilter([]);

    expect(filter).toEqual({ kinds: [1622], '#e': [], limit: 500 });
  });

  it('[P2] buildStatusFilter with empty array returns filter with empty #e', () => {
    const filter = buildStatusFilter([]);

    expect(filter).toEqual({
      kinds: [1630, 1631, 1632, 1633],
      '#e': [],
      limit: 500,
    });
  });

  it('[P2] buildEventByIdFilter with single ID returns filter with ids array', () => {
    const filter = buildEventByIdFilter(['single-id']);

    expect(filter).toEqual({ ids: ['single-id'] });
  });
});
