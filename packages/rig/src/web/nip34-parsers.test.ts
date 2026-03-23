// Test IDs: 8.1-UNIT-007, 8.1-UNIT-008
// AC covered: AC4, AC5 (NIP-34 kind:30617 event parsing)

import { describe, it, expect } from 'vitest';

import { parseRepoAnnouncement, parseRepoRefs } from './nip34-parsers.js';

// ============================================================================
// Factories
// ============================================================================

/**
 * Factory: creates a valid kind:30617 NostrEvent for a repository announcement.
 */
function createMockRepoEvent(
  overrides: {
    id?: string;
    pubkey?: string;
    name?: string;
    description?: string;
    dTag?: string;
    defaultBranch?: string;
    kind?: number;
    tags?: string[][];
  } = {}
) {
  const tags: string[][] = overrides.tags ?? [
    ['d', overrides.dTag ?? 'my-repo'],
    ['name', overrides.name ?? 'My Repository'],
    ['description', overrides.description ?? 'A test repository'],
    ['clone', 'https://git.example.com/my-repo.git'],
    ['web', 'https://git.example.com/my-repo'],
    ['r', 'HEAD', overrides.defaultBranch ?? 'main'],
    ['maintainers', overrides.pubkey ?? 'ab'.repeat(32)],
    ['relays', 'wss://relay.example.com'],
    ['t', 'rust'],
  ];

  return {
    id: overrides.id ?? 'a'.repeat(64),
    pubkey: overrides.pubkey ?? 'ab'.repeat(32),
    created_at: 1700000000,
    kind: overrides.kind ?? 30617,
    tags,
    content:
      overrides.description ?? 'A longer description in the content field.',
    sig: 'b'.repeat(128),
  };
}

describe('NIP-34 Parsers - parseRepoAnnouncement', () => {
  // ---------------------------------------------------------------------------
  // 8.1-UNIT-007: Valid kind:30617 event parsed to RepoMetadata
  // AC: #4, #5
  // ---------------------------------------------------------------------------

  it('[P1] parses valid kind:30617 event to RepoMetadata with correct fields', () => {
    // Arrange
    const event = createMockRepoEvent({
      name: 'awesome-project',
      description: 'An awesome project',
      dTag: 'awesome-project',
      defaultBranch: 'develop',
      pubkey: 'cd'.repeat(32),
    });

    // Act
    const result = parseRepoAnnouncement(event);

    // Assert
    expect(result).not.toBeNull();
    expect(result!.name).toBe('awesome-project');
    expect(result!.description).toBe('An awesome project');
    expect(result!.ownerPubkey).toBe('cd'.repeat(32));
    expect(result!.defaultBranch).toBe('develop');
  });

  it('[P1] extracts d tag as repo identifier', () => {
    // Arrange
    const event = createMockRepoEvent({ dTag: 'unique-repo-id' });

    // Act
    const result = parseRepoAnnouncement(event);

    // Assert
    expect(result).not.toBeNull();
    expect(result!.name).toBeDefined();
  });

  it('[P1] extracts clone URLs from clone tags', () => {
    // Arrange
    const event = createMockRepoEvent();

    // Act
    const result = parseRepoAnnouncement(event);

    // Assert
    expect(result).not.toBeNull();
    expect(result!.cloneUrls).toContain('https://git.example.com/my-repo.git');
  });

  // ---------------------------------------------------------------------------
  // 8.1-UNIT-008: Malformed events return null
  // AC: #4, #5
  // ---------------------------------------------------------------------------

  it('[P1] returns null for event with wrong kind (not 30617)', () => {
    // Arrange
    const event = createMockRepoEvent({ kind: 1 });

    // Act
    const result = parseRepoAnnouncement(event);

    // Assert
    expect(result).toBeNull();
  });

  it('[P1] returns null for event missing d tag', () => {
    // Arrange -- create event with no d tag
    const event = createMockRepoEvent({
      tags: [
        ['name', 'no-d-tag-repo'],
        ['description', 'Missing identifier'],
      ],
    });

    // Act
    const result = parseRepoAnnouncement(event);

    // Assert
    expect(result).toBeNull();
  });

  it('[P2] returns null for event with empty tags array', () => {
    // Arrange
    const event = createMockRepoEvent({ tags: [] });

    // Act
    const result = parseRepoAnnouncement(event);

    // Assert
    expect(result).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // AC5 gap: description falls back to content when no description tag
  // ---------------------------------------------------------------------------

  it('[P1] falls back to content field when no description tag exists', () => {
    // Arrange -- event with d tag but no description tag
    const event = createMockRepoEvent({
      tags: [
        ['d', 'fallback-repo'],
        ['name', 'Fallback Repo'],
        ['clone', 'https://git.example.com/fallback.git'],
        ['r', 'HEAD', 'main'],
      ],
    });
    // The content field is set by the factory to the description override or default
    event.content = 'Description from content field';

    // Act
    const result = parseRepoAnnouncement(event);

    // Assert
    expect(result).not.toBeNull();
    expect(result!.description).toBe('Description from content field');
  });

  it('[P1] uses name tag over d tag when both exist', () => {
    // Arrange
    const event = createMockRepoEvent({
      dTag: 'repo-identifier',
      name: 'Display Name',
    });

    // Act
    const result = parseRepoAnnouncement(event);

    // Assert
    expect(result).not.toBeNull();
    expect(result!.name).toBe('Display Name');
  });

  it('[P2] falls back to d tag as name when no name tag exists', () => {
    // Arrange
    const event = createMockRepoEvent({
      tags: [
        ['d', 'my-repo-id'],
        ['description', 'Some description'],
        ['r', 'HEAD', 'main'],
      ],
    });

    // Act
    const result = parseRepoAnnouncement(event);

    // Assert
    expect(result).not.toBeNull();
    expect(result!.name).toBe('my-repo-id');
  });

  it('[P2] defaults to main when no HEAD ref tag exists', () => {
    // Arrange
    const event = createMockRepoEvent({
      tags: [
        ['d', 'no-ref-repo'],
        ['name', 'No Ref Repo'],
      ],
    });

    // Act
    const result = parseRepoAnnouncement(event);

    // Assert
    expect(result).not.toBeNull();
    expect(result!.defaultBranch).toBe('main');
  });

  it('[P2] extracts web URLs from web tags', () => {
    // Arrange
    const event = createMockRepoEvent();

    // Act
    const result = parseRepoAnnouncement(event);

    // Assert
    expect(result).not.toBeNull();
    expect(result!.webUrls).toContain('https://git.example.com/my-repo');
  });

  it('[P1] sets eventId from event id field', () => {
    // Arrange
    const eventId = 'f'.repeat(64);
    const event = createMockRepoEvent({ id: eventId });

    // Act
    const result = parseRepoAnnouncement(event);

    // Assert
    expect(result).not.toBeNull();
    expect(result!.eventId).toBe(eventId);
  });
});

// ============================================================================
// Story 8.2: kind:30618 Ref Parsing
// ============================================================================

/**
 * Factory: creates a valid kind:30618 NostrEvent for repository refs.
 */
function createMockRefsEvent(
  overrides: {
    id?: string;
    pubkey?: string;
    dTag?: string;
    kind?: number;
    refs?: Array<[string, string]>;
    tags?: string[][];
  } = {}
) {
  const refs = overrides.refs ?? [
    ['main', 'aaa111'],
    ['HEAD', 'aaa111'],
  ];
  const tags: string[][] = overrides.tags ?? [
    ['d', overrides.dTag ?? 'my-repo'],
    ...refs.map(([name, sha]) => ['r', name, sha]),
  ];

  return {
    id: overrides.id ?? 'b'.repeat(64),
    pubkey: overrides.pubkey ?? 'ab'.repeat(32),
    created_at: 1700000000,
    kind: overrides.kind ?? 30618,
    tags,
    content: '',
    sig: 'c'.repeat(128),
  };
}

describe('NIP-34 Parsers - parseRepoRefs', () => {
  // ---------------------------------------------------------------------------
  // 8.2-UNIT-007: Valid kind:30618 event parsed to RepoRefs
  // AC: #1
  // ---------------------------------------------------------------------------

  it('[P1] parses valid kind:30618 event to RepoRefs with correct ref->sha mappings', () => {
    const event = createMockRefsEvent({
      dTag: 'my-repo',
      refs: [
        ['main', 'abc123'],
        ['develop', 'def456'],
        ['HEAD', 'abc123'],
      ],
    });

    const result = parseRepoRefs(event);

    expect(result).not.toBeNull();
    expect(result!.repoId).toBe('my-repo');
    expect(result!.refs.size).toBe(3);
    expect(result!.refs.get('main')).toBe('abc123');
    expect(result!.refs.get('develop')).toBe('def456');
    expect(result!.refs.get('HEAD')).toBe('abc123');
  });

  it('[P1] returns null for event with wrong kind (not 30618)', () => {
    const event = createMockRefsEvent({ kind: 1 });

    const result = parseRepoRefs(event);

    expect(result).toBeNull();
  });

  it('[P1] returns null for event missing d tag', () => {
    const event = createMockRefsEvent({
      tags: [['r', 'main', 'abc123']],
    });

    const result = parseRepoRefs(event);

    expect(result).toBeNull();
  });

  it('[P2] handles event with no r tags (empty refs map)', () => {
    const event = createMockRefsEvent({
      tags: [['d', 'my-repo']],
    });

    const result = parseRepoRefs(event);

    expect(result).not.toBeNull();
    expect(result!.refs.size).toBe(0);
  });

  it('[P2] ignores malformed r tags (missing sha)', () => {
    const event = createMockRefsEvent({
      tags: [
        ['d', 'my-repo'],
        ['r', 'main'], // missing SHA
        ['r', 'develop', 'def456'], // valid
      ],
    });

    const result = parseRepoRefs(event);

    expect(result).not.toBeNull();
    expect(result!.refs.size).toBe(1);
    expect(result!.refs.get('develop')).toBe('def456');
  });
});
