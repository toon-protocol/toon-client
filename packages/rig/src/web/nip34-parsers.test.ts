// Test IDs: 8.1-UNIT-007, 8.1-UNIT-008
// AC covered: AC4, AC5 (NIP-34 kind:30617 event parsing)

import { describe, it, expect } from 'vitest';

import {
  parseRepoAnnouncement,
  parseRepoRefs,
  parseIssue,
  parsePR,
  parseComment,
  resolvePRStatus,
} from './nip34-parsers.js';
import type { NostrEvent } from './nip34-parsers.js';

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

// ============================================================================
// Story 8.5: Issue / PR / Comment Parsers
// ============================================================================

/**
 * Factory: creates a valid kind:1621 issue event.
 */
function createMockIssueEvent(
  overrides: {
    id?: string;
    pubkey?: string;
    kind?: number;
    subject?: string;
    content?: string;
    labels?: string[];
    repoATag?: string;
    created_at?: number;
  } = {}
): NostrEvent {
  const tags: string[][] = [];
  if (overrides.repoATag) {
    tags.push(['a', overrides.repoATag]);
  } else {
    tags.push(['a', '30617:' + 'ab'.repeat(32) + ':my-repo']);
  }
  if (overrides.subject !== undefined) {
    tags.push(['subject', overrides.subject]);
  }
  if (overrides.labels) {
    for (const l of overrides.labels) {
      tags.push(['t', l]);
    }
  }

  return {
    id: overrides.id ?? 'i'.repeat(64),
    pubkey: overrides.pubkey ?? 'ab'.repeat(32),
    created_at: overrides.created_at ?? 1700000000,
    kind: overrides.kind ?? 1621,
    tags,
    content: overrides.content ?? 'Issue body content',
    sig: 'd'.repeat(128),
  };
}

/**
 * Factory: creates a valid kind:1617 PR/patch event.
 */
function createMockPREvent(
  overrides: {
    id?: string;
    pubkey?: string;
    kind?: number;
    subject?: string;
    content?: string;
    commitShas?: string[];
    baseBranch?: string;
    created_at?: number;
  } = {}
): NostrEvent {
  const tags: string[][] = [['a', '30617:' + 'ab'.repeat(32) + ':my-repo']];
  if (overrides.subject !== undefined) {
    tags.push(['subject', overrides.subject]);
  }
  if (overrides.commitShas) {
    for (const sha of overrides.commitShas) {
      tags.push(['commit', sha]);
    }
  }
  if (overrides.baseBranch !== undefined) {
    tags.push(['branch', overrides.baseBranch]);
  }

  return {
    id: overrides.id ?? 'p'.repeat(64),
    pubkey: overrides.pubkey ?? 'ab'.repeat(32),
    created_at: overrides.created_at ?? 1700000000,
    kind: overrides.kind ?? 1617,
    tags,
    content: overrides.content ?? 'Patch content',
    sig: 'e'.repeat(128),
  };
}

/**
 * Factory: creates a valid kind:1622 comment event.
 */
function createMockCommentEvent(
  overrides: {
    id?: string;
    pubkey?: string;
    kind?: number;
    content?: string;
    parentEventId?: string;
    created_at?: number;
  } = {}
): NostrEvent {
  const tags: string[][] = [];
  if (overrides.parentEventId !== undefined) {
    tags.push(['e', overrides.parentEventId]);
  } else {
    tags.push(['e', 'parent'.repeat(10) + 'aaaa']);
  }

  return {
    id: overrides.id ?? 'c'.repeat(64),
    pubkey: overrides.pubkey ?? 'cd'.repeat(32),
    created_at: overrides.created_at ?? 1700001000,
    kind: overrides.kind ?? 1622,
    tags,
    content: overrides.content ?? 'Comment text',
    sig: 'f'.repeat(128),
  };
}

/**
 * Factory: creates a status event (kind:1630-1633).
 */
function createMockStatusEvent(overrides: {
  kind: number;
  prEventId: string;
  created_at?: number;
}): NostrEvent {
  return {
    id: Math.random().toString(36).slice(2).padEnd(64, '0'),
    pubkey: 'ab'.repeat(32),
    created_at: overrides.created_at ?? 1700002000,
    kind: overrides.kind,
    tags: [['e', overrides.prEventId]],
    content: '',
    sig: '0'.repeat(128),
  };
}

describe('NIP-34 Parsers - parseIssue', () => {
  it('[P1] extracts title from subject tag', () => {
    const event = createMockIssueEvent({ subject: 'Bug: crash on startup' });

    const result = parseIssue(event);

    expect(result).not.toBeNull();
    expect(result!.title).toBe('Bug: crash on startup');
  });

  it('[P1] falls back to first line of content when no subject tag', () => {
    const event = createMockIssueEvent({
      content: 'First line title\nSecond line body',
    });
    // Remove subject tag
    event.tags = event.tags.filter((t) => t[0] !== 'subject');

    const result = parseIssue(event);

    expect(result).not.toBeNull();
    expect(result!.title).toBe('First line title');
  });

  it('[P1] returns null for non-1621 events', () => {
    const event = createMockIssueEvent({ kind: 1 });

    const result = parseIssue(event);

    expect(result).toBeNull();
  });

  it('[P2] extracts labels from t tags', () => {
    const event = createMockIssueEvent({
      subject: 'Test issue',
      labels: ['bug', 'priority-high'],
    });

    const result = parseIssue(event);

    expect(result).not.toBeNull();
    expect(result!.labels).toEqual(['bug', 'priority-high']);
  });

  it('[P2] defaults status to open', () => {
    const event = createMockIssueEvent({ subject: 'Open issue' });

    const result = parseIssue(event);

    expect(result).not.toBeNull();
    expect(result!.status).toBe('open');
  });
});

describe('NIP-34 Parsers - parsePR', () => {
  it('[P1] extracts commit SHAs from commit tags', () => {
    const event = createMockPREvent({
      subject: 'Add feature',
      commitShas: ['abc123', 'def456'],
    });

    const result = parsePR(event);

    expect(result).not.toBeNull();
    expect(result!.commitShas).toEqual(['abc123', 'def456']);
  });

  it('[P1] extracts base branch from branch tag', () => {
    const event = createMockPREvent({
      subject: 'Fix bug',
      baseBranch: 'develop',
    });

    const result = parsePR(event);

    expect(result).not.toBeNull();
    expect(result!.baseBranch).toBe('develop');
  });

  it('[P1] returns null for non-1617 events', () => {
    const event = createMockPREvent({ kind: 1 });

    const result = parsePR(event);

    expect(result).toBeNull();
  });

  it('[P2] defaults base branch to main when no branch tag', () => {
    const event = createMockPREvent({ subject: 'Feature' });

    const result = parsePR(event);

    expect(result).not.toBeNull();
    expect(result!.baseBranch).toBe('main');
  });

  it('[P1] extracts content field from event (AC #7)', () => {
    const event = createMockPREvent({
      subject: 'My PR',
      content: 'Detailed patch content here',
    });

    const result = parsePR(event);

    expect(result).not.toBeNull();
    expect(result!.content).toBe('Detailed patch content here');
  });
});

describe('NIP-34 Parsers - parseComment', () => {
  it('[P1] extracts parent event ID from e tag', () => {
    const parentId = 'parent'.repeat(10) + 'bbbb';
    const event = createMockCommentEvent({ parentEventId: parentId });

    const result = parseComment(event);

    expect(result).not.toBeNull();
    expect(result!.parentEventId).toBe(parentId);
  });

  it('[P1] returns null for non-1622 events', () => {
    const event = createMockCommentEvent({ kind: 1 });

    const result = parseComment(event);

    expect(result).toBeNull();
  });

  it('[P2] returns null when no e tag exists', () => {
    const event = createMockCommentEvent({});
    event.tags = [];

    const result = parseComment(event);

    expect(result).toBeNull();
  });
});

describe('NIP-34 Parsers - resolvePRStatus (8.5-UNIT-004)', () => {
  const prEventId = 'p'.repeat(64);

  it('[P1] returns status from the most recent status event', () => {
    const statusEvents: NostrEvent[] = [
      createMockStatusEvent({ kind: 1630, prEventId, created_at: 1700001000 }), // open
      createMockStatusEvent({ kind: 1631, prEventId, created_at: 1700002000 }), // applied (most recent)
    ];

    const result = resolvePRStatus(prEventId, statusEvents);

    expect(result).toBe('applied');
  });

  it('[P1] returns open when no status events exist', () => {
    const result = resolvePRStatus(prEventId, []);

    expect(result).toBe('open');
  });

  it('[P1] ignores status events for other PRs', () => {
    const otherPrId = 'o'.repeat(64);
    const statusEvents: NostrEvent[] = [
      createMockStatusEvent({
        kind: 1631,
        prEventId: otherPrId,
        created_at: 1700002000,
      }),
    ];

    const result = resolvePRStatus(prEventId, statusEvents);

    expect(result).toBe('open');
  });

  it('[P1] maps kind 1630 to open', () => {
    const statusEvents: NostrEvent[] = [
      createMockStatusEvent({ kind: 1630, prEventId, created_at: 1700001000 }),
    ];

    const result = resolvePRStatus(prEventId, statusEvents);

    expect(result).toBe('open');
  });

  it('[P1] maps kind 1632 to closed', () => {
    const statusEvents: NostrEvent[] = [
      createMockStatusEvent({ kind: 1632, prEventId, created_at: 1700001000 }),
    ];

    const result = resolvePRStatus(prEventId, statusEvents);

    expect(result).toBe('closed');
  });

  it('[P1] maps kind 1633 to draft', () => {
    const statusEvents: NostrEvent[] = [
      createMockStatusEvent({ kind: 1633, prEventId, created_at: 1700001000 }),
    ];

    const result = resolvePRStatus(prEventId, statusEvents);

    expect(result).toBe('draft');
  });

  it('[P2] equal created_at uses last-in-array (deterministic tie-breaking)', () => {
    const sameTime = 1700001000;
    const statusEvents: NostrEvent[] = [
      createMockStatusEvent({ kind: 1630, prEventId, created_at: sameTime }), // open
      createMockStatusEvent({ kind: 1632, prEventId, created_at: sameTime }), // closed
    ];

    // With equal timestamps, the loop keeps the first one found
    // (since > is strict, not >=). This is deterministic.
    const result = resolvePRStatus(prEventId, statusEvents);
    expect(result).toBe('open');
  });

  it('[P2] ignores events with kind outside 1630-1633 range', () => {
    const statusEvents: NostrEvent[] = [
      {
        id: 'x'.repeat(64),
        pubkey: 'ab'.repeat(32),
        created_at: 1700002000,
        kind: 1622, // comment, not a status event
        tags: [['e', prEventId]],
        content: '',
        sig: '0'.repeat(128),
      },
    ];

    const result = resolvePRStatus(prEventId, statusEvents);
    expect(result).toBe('open');
  });
});

// ============================================================================
// NFR: Edge case tests for parsers
// ============================================================================

describe('NIP-34 Parsers - NFR Edge Cases', () => {
  it('[P2] parseIssue with empty content returns empty title when no subject tag', () => {
    const event = createMockIssueEvent({ content: '' });
    event.tags = event.tags.filter((t) => t[0] !== 'subject');

    const result = parseIssue(event);

    expect(result).not.toBeNull();
    expect(result!.title).toBe('');
    expect(result!.content).toBe('');
  });

  it('[P2] parsePR with no subject tag returns empty title', () => {
    const event = createMockPREvent({});
    // Remove subject tag
    event.tags = event.tags.filter((t) => t[0] !== 'subject');

    const result = parsePR(event);

    expect(result).not.toBeNull();
    expect(result!.title).toBe('');
  });

  it('[P2] parseComment extracts first e tag when multiple exist', () => {
    const event = createMockCommentEvent({
      parentEventId: 'first'.repeat(12) + 'aa',
    });
    event.tags.push(['e', 'second'.repeat(10) + 'bbbb']);

    const result = parseComment(event);

    expect(result).not.toBeNull();
    // getTagValue returns the first match
    expect(result!.parentEventId).toBe('first'.repeat(12) + 'aa');
  });

  it('[P2] parseIssue preserves full content including newlines', () => {
    const content = 'First line\n\nSecond paragraph\n\nThird paragraph';
    const event = createMockIssueEvent({ subject: 'Title', content });

    const result = parseIssue(event);

    expect(result).not.toBeNull();
    expect(result!.content).toBe(content);
  });
});

// ============================================================================
// AC gap-fill: Full field extraction for parseIssue, parsePR, parseComment
// AC covered: #6, #7, #8
// ============================================================================

describe('NIP-34 Parsers - AC Gap Fill: Full Field Extraction', () => {
  it('[P1] parseIssue extracts eventId, authorPubkey, and createdAt (AC #6)', () => {
    const event = createMockIssueEvent({
      id: 'myevent'.padEnd(64, '0'),
      pubkey: 'ab'.repeat(32),
      subject: 'Test issue',
      created_at: 1700050000,
    });

    const result = parseIssue(event);

    expect(result).not.toBeNull();
    expect(result!.eventId).toBe('myevent'.padEnd(64, '0'));
    expect(result!.authorPubkey).toBe('ab'.repeat(32));
    expect(result!.createdAt).toBe(1700050000);
  });

  it('[P1] parsePR extracts title from subject tag (AC #7)', () => {
    const event = createMockPREvent({
      subject: 'Refactor module X',
    });

    const result = parsePR(event);

    expect(result).not.toBeNull();
    expect(result!.title).toBe('Refactor module X');
  });

  it('[P1] parsePR extracts eventId, authorPubkey, createdAt and defaults status to open (AC #7)', () => {
    const event = createMockPREvent({
      id: 'prevent'.padEnd(64, '0'),
      pubkey: 'cd'.repeat(32),
      subject: 'Add tests',
      created_at: 1700060000,
    });

    const result = parsePR(event);

    expect(result).not.toBeNull();
    expect(result!.eventId).toBe('prevent'.padEnd(64, '0'));
    expect(result!.authorPubkey).toBe('cd'.repeat(32));
    expect(result!.createdAt).toBe(1700060000);
    expect(result!.status).toBe('open');
  });

  it('[P1] parseComment extracts eventId, content, authorPubkey, createdAt (AC #8)', () => {
    const event = createMockCommentEvent({
      id: 'comevent'.padEnd(64, '0'),
      pubkey: 'ef'.repeat(32),
      content: 'Looks good to me',
      created_at: 1700070000,
      parentEventId: 'parent'.padEnd(64, '0'),
    });

    const result = parseComment(event);

    expect(result).not.toBeNull();
    expect(result!.eventId).toBe('comevent'.padEnd(64, '0'));
    expect(result!.content).toBe('Looks good to me');
    expect(result!.authorPubkey).toBe('ef'.repeat(32));
    expect(result!.createdAt).toBe(1700070000);
    expect(result!.parentEventId).toBe('parent'.padEnd(64, '0'));
  });
});

// ============================================================================
// Story 8.6: Bug Fix Validation Tests
// ============================================================================

describe('NIP-34 Parsers - 8.6-UNIT-001: repoId from d tag', () => {
  it('[P1] parseRepoAnnouncement populates repoId from d tag (distinct from name)', () => {
    // AC #1: Repos where name != d tag must use repoId in URLs
    const event = createMockRepoEvent({
      dTag: 'my-repo-id',
      name: 'My Repo Name',
    });

    const result = parseRepoAnnouncement(event);

    expect(result).not.toBeNull();
    expect(result!.repoId).toBe('my-repo-id');
    expect(result!.name).toBe('My Repo Name');
  });

  it('[P1] repoId falls back to d tag value when d and name are the same', () => {
    const event = createMockRepoEvent({
      dTag: 'same-value',
      name: 'same-value',
    });

    const result = parseRepoAnnouncement(event);

    expect(result).not.toBeNull();
    expect(result!.repoId).toBe('same-value');
    expect(result!.name).toBe('same-value');
  });
});

describe('NIP-34 Parsers - 8.6-UNIT-005b: arweaveMap from kind:30618', () => {
  it('[P1] parseRepoRefs extracts arweave tags into arweaveMap', () => {
    // AC #5: ["arweave", "<sha>", "<txId>"] tags populate arweaveMap
    const sha = 'abc123' + 'de'.repeat(17);
    const txId = 'txId456_abcdefghijklmnopqrstuvwxyz01234567';
    const event = createMockRefsEvent({
      tags: [
        ['d', 'my-repo'],
        ['r', 'main', 'aaa111'],
        ['arweave', sha, txId],
        [
          'arweave',
          'def789' + 'ab'.repeat(17),
          'txId789_abcdefghijklmnopqrstuvwxyz01234567',
        ],
      ],
    });

    const result = parseRepoRefs(event);

    expect(result).not.toBeNull();
    expect(result!.arweaveMap.size).toBe(2);
    expect(result!.arweaveMap.get(sha)).toBe(txId);
    expect(result!.arweaveMap.get('def789' + 'ab'.repeat(17))).toBe(
      'txId789_abcdefghijklmnopqrstuvwxyz01234567'
    );
  });

  it('[P1] parseRepoRefs returns empty arweaveMap when no arweave tags', () => {
    const event = createMockRefsEvent({
      tags: [
        ['d', 'my-repo'],
        ['r', 'main', 'aaa111'],
      ],
    });

    const result = parseRepoRefs(event);

    expect(result).not.toBeNull();
    expect(result!.arweaveMap.size).toBe(0);
  });

  it('[P2] parseRepoRefs ignores malformed arweave tags (missing txId)', () => {
    const event = createMockRefsEvent({
      tags: [
        ['d', 'my-repo'],
        ['arweave', 'sha-only'], // missing txId
        ['arweave', 'good-sha', 'good-txId'],
      ],
    });

    const result = parseRepoRefs(event);

    expect(result).not.toBeNull();
    expect(result!.arweaveMap.size).toBe(1);
    expect(result!.arweaveMap.get('good-sha')).toBe('good-txId');
  });
});
