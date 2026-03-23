// @vitest-environment jsdom
// Tests for Forge-UI templates
//
// Test IDs: 3.7-UNIT-001, 3.8-UNIT-001, 3.9-UNIT-001, 3.10-UNIT-001,
//           3.11-UNIT-001, 3.11-UNIT-002
//           8.1-UNIT-002, 8.1-UNIT-003, 8.1-UNIT-009, 8.1-UNIT-010
//           8.2-UNIT (tree/blob rendering, XSS)
// Risk links: E3-R004 (XSS via Nostr event content), E3-R011 (template port fidelity)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  renderRepoList,
  renderTreeView,
  renderBlobView,
  renderCommitDiff,
  renderCommitLog,
  renderBlameView,
  renderIssueList,
  renderIssueDetail,
  renderPRList,
  renderPRDetail,
  renderRepoTabs,
} from './templates.js';
import type { FileDiff } from './templates.js';
import type { TreeEntry } from './git-objects.js';
import type { CommitLogEntry } from './commit-walker.js';
import type { TreeDiffEntry } from './tree-diff.js';
import type {
  IssueMetadata,
  PRMetadata,
  CommentMetadata,
} from './nip34-parsers.js';
import { ProfileCache } from './profile-cache.js';

// ============================================================================
// Factories
// ============================================================================

/**
 * Factory for creating a mock tree entry matching the TreeEntry interface.
 */
function createMockTreeEntry(
  overrides: {
    mode?: string;
    name?: string;
    sha?: string;
  } = {}
): TreeEntry {
  return {
    mode: overrides.mode ?? '100644',
    name: overrides.name ?? 'README.md',
    sha: overrides.sha ?? 'a'.repeat(40),
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('Templates - Repository List', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // 3.7-UNIT-001: Empty state when no repos exist
  // ---------------------------------------------------------------------------

  it('[P2] renders empty state message when no repositories exist', () => {
    const repos: ReturnType<typeof createRepoMetadata>[] = [];

    const html = renderRepoList(repos);

    expect(html).toContain('No repositories');
    expect(html).not.toContain('<a href="/');
  });

  it('[P2] renders repo list when repositories exist', () => {
    const repos = [
      createRepoMetadata({ name: 'repo-alpha', description: 'First repo' }),
      createRepoMetadata({ name: 'repo-beta', description: 'Second repo' }),
    ];

    const html = renderRepoList(repos);

    expect(html).toContain('repo-alpha');
    expect(html).toContain('repo-beta');
    expect(html).toContain('First repo');
    expect(html).toContain('Second repo');
    expect(html).not.toContain('No repositories');
  });
});

describe('Templates - File Tree and Blob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // 3.8-UNIT-001: 404 for non-existent path
  // ---------------------------------------------------------------------------

  it('[P2] renderTreeView returns 404 response for non-existent path', () => {
    const result = renderTreeView('test-repo', 'main', 'does/not/exist', null);

    expect(result.status).toBe(404);
    expect(result.html).toContain('404');
  });

  it('[P2] renderBlobView returns 404 response for non-existent file', () => {
    const result = renderBlobView(
      'test-repo',
      'main',
      'nonexistent-file.ts',
      null,
      false,
      0
    );

    expect(result.status).toBe(404);
    expect(result.html).toContain('404');
  });
});

describe('Templates - Commit Diff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('[P2] renderCommitDiff returns 404 for non-existent commit SHA', () => {
    const result = renderCommitDiff('test-repo', 'deadbeef'.repeat(5), null);

    expect(result.status).toBe(404);
    expect(result.html).toContain('404');
  });

  it('[P2] renderCommitDiff returns 404 for malformed SHA', () => {
    const result = renderCommitDiff('test-repo', 'not-a-valid-sha', null);

    expect(result.status).toBe(404);
  });
});

// ============================================================================
// Story 8.3 Tests - Commit Log
// Test IDs: 8.3-UNIT-003
// ============================================================================

function createCommitLogEntry(overrides: {
  sha?: string;
  treeSha?: string;
  parentShas?: string[];
  author?: string;
  message?: string;
}): CommitLogEntry {
  return {
    sha: overrides.sha ?? 'a'.repeat(40),
    commit: {
      treeSha: overrides.treeSha ?? 'b'.repeat(40),
      parentShas: overrides.parentShas ?? [],
      author:
        overrides.author ?? 'Test User <test@example.com> 1700000000 +0000',
      committer: 'Test User <test@example.com> 1700000000 +0000',
      message: overrides.message ?? 'Initial commit',
    },
  };
}

describe('Templates - Story 8.3: Commit Log', () => {
  it('[P1] renders commit list with abbreviated hash, message, author, date (8.3-UNIT-003)', () => {
    const commits: CommitLogEntry[] = [
      createCommitLogEntry({
        sha: 'abcdef1234567890'.repeat(2) + 'abcdef12',
        message: 'Add new feature',
        author: 'Alice <alice@example.com> 1700000000 +0000',
      }),
      createCommitLogEntry({
        sha: '1234567890abcdef'.repeat(2) + '12345678',
        message: 'Fix bug in parser',
        author: 'Bob <bob@example.com> 1699990000 +0000',
      }),
    ];

    const result = renderCommitLog('test-repo', 'main', commits, 'npub1test');

    expect(result.status).toBe(200);
    // Abbreviated hashes (first 7 chars)
    expect(result.html).toContain('abcdef1');
    expect(result.html).toContain('1234567');
    // Commit messages
    expect(result.html).toContain('Add new feature');
    expect(result.html).toContain('Fix bug in parser');
    // Author names
    expect(result.html).toContain('Alice');
    expect(result.html).toContain('Bob');
    // Links to commit detail
    expect(result.html).toContain('/commit/');
  });

  it('[P2] empty commits array renders empty state', () => {
    const result = renderCommitLog('test-repo', 'main', [], 'npub1test');

    expect(result.status).toBe(200);
    expect(result.html).toContain('No commits found');
  });

  it('[P0] commit message with HTML tags is escaped', () => {
    const commits: CommitLogEntry[] = [
      createCommitLogEntry({
        message: '<script>alert("xss")</script>',
      }),
    ];

    const result = renderCommitLog('test-repo', 'main', commits, 'npub1test');

    expect(result.html).not.toContain('<script>alert');
    expect(result.html).toContain('&lt;script&gt;');
  });

  it('[P1] long commit message is truncated to ~72 chars', () => {
    const longMessage = 'A'.repeat(100);
    const commits: CommitLogEntry[] = [
      createCommitLogEntry({ message: longMessage }),
    ];

    const result = renderCommitLog('test-repo', 'main', commits, 'npub1test');

    // Should contain truncated version with ellipsis
    expect(result.html).toContain('A'.repeat(72) + '...');
    expect(result.html).not.toContain('A'.repeat(100));
  });

  it('[P1] breadcrumb includes Commits as active segment', () => {
    const commits: CommitLogEntry[] = [createCommitLogEntry({})];

    const result = renderCommitLog('test-repo', 'main', commits, 'npub1test');

    expect(result.html).toContain('Commits');
    expect(result.html).toContain('breadcrumb');
  });

  // ---------------------------------------------------------------------------
  // AC #18: Commit hash links navigate to /<npub>/<repo>/commit/<full-sha>
  // ---------------------------------------------------------------------------

  it('[P1] commit abbreviated hash links to full commit SHA URL (AC #18)', () => {
    const fullSha = 'abcdef1234567890'.repeat(2) + 'abcdef12';
    const commits: CommitLogEntry[] = [createCommitLogEntry({ sha: fullSha })];

    const result = renderCommitLog('test-repo', 'main', commits, 'npub1test');

    const container = document.createElement('div');
    container.innerHTML = result.html;

    const shaLink = container.querySelector(
      'a.commit-sha'
    ) as HTMLAnchorElement;
    expect(shaLink).not.toBeNull();
    // Displays abbreviated hash (first 7 chars)
    expect(shaLink.textContent).toContain(fullSha.slice(0, 7));
    // Links to full SHA in correct URL format
    expect(shaLink.getAttribute('href')).toContain(`/commit/${fullSha}`);
    expect(shaLink.getAttribute('href')).toContain(
      '/npub1test/test-repo/commit/'
    );
  });
});

// ============================================================================
// Story 8.3 Tests - Commit Diff Rendering
// ============================================================================

describe('Templates - Story 8.3: Commit Diff Rendering', () => {
  it('[P1] renders commit header with message, author, date', () => {
    const entry = createCommitLogEntry({
      sha: 'ab'.repeat(20),
      message: 'Fix important bug\n\nDetailed description.',
      author: 'Alice <alice@example.com> 1700000000 +0000',
    });
    const diffEntries: TreeDiffEntry[] = [];
    const fileDiffs: FileDiff[] = [];

    const result = renderCommitDiff(
      'test-repo',
      'ab'.repeat(20),
      entry,
      diffEntries,
      fileDiffs,
      'npub1test'
    );

    expect(result.status).toBe(200);
    expect(result.html).toContain('Fix important bug');
    expect(result.html).toContain('Alice');
  });

  it('[P1] diff entries rendered with correct status badges (A/D/M)', () => {
    const entry = createCommitLogEntry({ sha: 'ab'.repeat(20) });
    const diffEntries: TreeDiffEntry[] = [
      {
        status: 'added',
        name: 'new.ts',
        newSha: 'a'.repeat(40),
        mode: '100644',
      },
      {
        status: 'deleted',
        name: 'old.ts',
        oldSha: 'b'.repeat(40),
        mode: '100644',
      },
      {
        status: 'modified',
        name: 'changed.ts',
        oldSha: 'c'.repeat(40),
        newSha: 'd'.repeat(40),
        mode: '100644',
      },
    ];
    const fileDiffs: FileDiff[] = [
      { name: 'new.ts', status: 'added', hunks: [], isBinary: false },
      { name: 'old.ts', status: 'deleted', hunks: [], isBinary: false },
      { name: 'changed.ts', status: 'modified', hunks: [], isBinary: false },
    ];

    const result = renderCommitDiff(
      'test-repo',
      'ab'.repeat(20),
      entry,
      diffEntries,
      fileDiffs,
      'npub1test'
    );

    expect(result.html).toContain('diff-status-added');
    expect(result.html).toContain('diff-status-deleted');
    expect(result.html).toContain('diff-status-modified');
    expect(result.html).toContain('>A<');
    expect(result.html).toContain('>D<');
    expect(result.html).toContain('>M<');
  });

  it('[P1] inline diff lines rendered with add/delete styling classes', () => {
    const entry = createCommitLogEntry({ sha: 'ab'.repeat(20) });
    const fileDiffs: FileDiff[] = [
      {
        name: 'file.ts',
        status: 'modified',
        isBinary: false,
        hunks: [
          {
            oldStart: 1,
            oldCount: 2,
            newStart: 1,
            newCount: 2,
            lines: [
              { type: 'delete', content: 'old line' },
              { type: 'add', content: 'new line' },
            ],
          },
        ],
      },
    ];

    const result = renderCommitDiff(
      'test-repo',
      'ab'.repeat(20),
      entry,
      [],
      fileDiffs,
      'npub1test'
    );

    expect(result.html).toContain('diff-line-delete');
    expect(result.html).toContain('diff-line-add');
  });

  it('[P0] XSS in diff content is escaped', () => {
    const entry = createCommitLogEntry({
      sha: 'ab'.repeat(20),
      message: '<script>alert(1)</script>',
      author: '<img onerror=alert(1)> <x@x.com> 1700000000 +0000',
    });
    const fileDiffs: FileDiff[] = [
      {
        name: '<script>evil.ts</script>',
        status: 'added',
        isBinary: false,
        hunks: [
          {
            oldStart: 1,
            oldCount: 0,
            newStart: 1,
            newCount: 1,
            lines: [{ type: 'add', content: '<script>alert("xss")</script>' }],
          },
        ],
      },
    ];

    const result = renderCommitDiff(
      'test-repo',
      'ab'.repeat(20),
      entry,
      [],
      fileDiffs,
      'npub1test'
    );

    expect(result.html).not.toContain('<script>alert');
    expect(result.html).toContain('&lt;script&gt;');
  });

  it('[P1] binary file shows "Binary file changed"', () => {
    const entry = createCommitLogEntry({ sha: 'ab'.repeat(20) });
    const fileDiffs: FileDiff[] = [
      {
        name: 'image.png',
        status: 'modified',
        isBinary: true,
        hunks: [],
      },
    ];

    const result = renderCommitDiff(
      'test-repo',
      'ab'.repeat(20),
      entry,
      [],
      fileDiffs,
      'npub1test'
    );

    expect(result.html).toContain('Binary file changed');
  });

  it('[P1] root commit shows parent as "root commit"', () => {
    const entry = createCommitLogEntry({
      sha: 'ab'.repeat(20),
      parentShas: [],
    });

    const result = renderCommitDiff(
      'test-repo',
      'ab'.repeat(20),
      entry,
      [],
      [],
      'npub1test'
    );

    expect(result.html).toContain('root commit');
  });
});

describe('Templates - Blame View', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('[P1] renderBlameView returns 404 with "File not found" for null result (not binary)', () => {
    const result = renderBlameView(
      'test-repo',
      'main',
      'missing-file.ts',
      null
    );

    expect(result.status).toBe(404);
    expect(result.html).toContain('404');
    expect(result.html).toContain('File not found for blame');
  });

  it('[P1] renderBlameView returns 404 with binary message for null result (binary)', () => {
    const result = renderBlameView(
      'test-repo',
      'main',
      'image.png',
      null,
      true
    );

    expect(result.status).toBe(404);
    expect(result.html).toContain('Binary files cannot be blamed');
  });

  it('[P1] renders blame lines with abbreviated hash, author, date, line number, content (8.4-UNIT-004)', () => {
    const blameResult = {
      lines: [
        {
          commitSha: 'abcdef1234567890'.repeat(2) + 'abcdef12',
          author: 'Alice <alice@example.com> 1700000000 +0000',
          timestamp: 1700000000,
          lineNumber: 1,
        },
        {
          commitSha: '1234567890abcdef'.repeat(2) + '12345678',
          author: 'Bob <bob@example.com> 1699990000 +0000',
          timestamp: 1699990000,
          lineNumber: 2,
        },
      ],
      fileContent: 'line one\nline two',
      beyondLimit: false,
      maxDepth: 50,
    };

    const result = renderBlameView(
      'test-repo',
      'main',
      'src/file.ts',
      blameResult,
      false,
      'npub1test'
    );

    expect(result.status).toBe(200);
    // Abbreviated hashes (first 7 chars)
    expect(result.html).toContain('abcdef1');
    expect(result.html).toContain('1234567');
    // Author names
    expect(result.html).toContain('Alice');
    expect(result.html).toContain('Bob');
    // Line numbers
    expect(result.html).toContain('>1<');
    expect(result.html).toContain('>2<');
    // Line content
    expect(result.html).toContain('line one');
    expect(result.html).toContain('line two');
    // Commit links
    expect(result.html).toContain('/commit/');
  });

  it('[P1] consecutive lines from same commit show commit info only on first line', () => {
    const sha = 'ab'.repeat(20);
    const blameResult = {
      lines: [
        {
          commitSha: sha,
          author: 'Alice <alice@example.com> 1700000000 +0000',
          timestamp: 1700000000,
          lineNumber: 1,
        },
        {
          commitSha: sha,
          author: 'Alice <alice@example.com> 1700000000 +0000',
          timestamp: 1700000000,
          lineNumber: 2,
        },
        {
          commitSha: sha,
          author: 'Alice <alice@example.com> 1700000000 +0000',
          timestamp: 1700000000,
          lineNumber: 3,
        },
      ],
      fileContent: 'line 1\nline 2\nline 3',
      beyondLimit: false,
      maxDepth: 50,
    };

    const result = renderBlameView(
      'test-repo',
      'main',
      'file.ts',
      blameResult,
      false,
      'npub1test'
    );

    const container = document.createElement('div');
    container.innerHTML = result.html;

    // Only first row should have the commit SHA link
    const shaLinks = container.querySelectorAll('.blame-sha a');
    expect(shaLinks).toHaveLength(1);

    // Only first row should have author name
    const authorCells = container.querySelectorAll('.blame-author');
    const nonEmptyAuthors = Array.from(authorCells).filter(
      (el) => el.textContent!.trim() !== ''
    );
    expect(nonEmptyAuthors).toHaveLength(1);
  });

  it('[P0] XSS in file content is escaped in blame view', () => {
    const blameResult = {
      lines: [
        {
          commitSha: 'ab'.repeat(20),
          author: 'Test <test@test.com> 1700000000 +0000',
          timestamp: 1700000000,
          lineNumber: 1,
        },
      ],
      fileContent: '<script>alert("xss")</script>',
      beyondLimit: false,
      maxDepth: 50,
    };

    const result = renderBlameView(
      'test-repo',
      'main',
      'file.ts',
      blameResult,
      false,
      'npub1test'
    );

    expect(result.html).not.toContain('<script>alert');
    expect(result.html).toContain('&lt;script&gt;');
  });

  it('[P1] beyondLimit notice is shown when true, including commit count', () => {
    const blameResult = {
      lines: [
        {
          commitSha: 'ab'.repeat(20),
          author: 'Test <test@test.com> 1700000000 +0000',
          timestamp: 1700000000,
          lineNumber: 1,
        },
      ],
      fileContent: 'content',
      beyondLimit: true,
      maxDepth: 50,
    };

    const result = renderBlameView(
      'test-repo',
      'main',
      'file.ts',
      blameResult,
      false,
      'npub1test'
    );

    expect(result.html).toContain('blame-depth-notice');
    expect(result.html).toContain('Blame history limited to 50 commits');
    expect(result.html).toContain('Older attributions may be approximate');
  });

  it('[P1] beyondLimit notice is NOT shown when false', () => {
    const blameResult = {
      lines: [
        {
          commitSha: 'ab'.repeat(20),
          author: 'Test <test@test.com> 1700000000 +0000',
          timestamp: 1700000000,
          lineNumber: 1,
        },
      ],
      fileContent: 'content',
      beyondLimit: false,
      maxDepth: 50,
    };

    const result = renderBlameView(
      'test-repo',
      'main',
      'file.ts',
      blameResult,
      false,
      'npub1test'
    );

    expect(result.html).not.toContain('blame-depth-notice');
  });
});

// ============================================================================
// Story 8.4 Tests - Blob View Blame Link
// ============================================================================

describe('Templates - Story 8.4: Blob View Blame Link', () => {
  it('[P1] renderBlobView includes a blame link for text files', () => {
    const result = renderBlobView(
      'test-repo',
      'main',
      'src/index.ts',
      'const x = 1;',
      false,
      12,
      'npub1test'
    );

    expect(result.html).toContain('blob-blame-link');
    expect(result.html).toContain('Blame');
    expect(result.html).toContain('/blame/main/');
  });

  it('[P1] renderBlobView does NOT include a blame link for binary files', () => {
    const result = renderBlobView(
      'test-repo',
      'main',
      'image.png',
      null,
      true,
      12345,
      'npub1test'
    );

    expect(result.html).not.toContain('blob-blame-link');
    expect(result.html).not.toContain('Blame');
  });
});

// ============================================================================
// Story 8.5 Tests - Issue/PR Templates
// Test IDs: 8.5-UNIT-005, 8.5-UNIT-006, 8.5-UNIT-008
// ============================================================================

function createIssueMetadata(
  overrides: Partial<IssueMetadata> = {}
): IssueMetadata {
  return {
    eventId: overrides.eventId ?? 'i'.repeat(64),
    title: overrides.title ?? 'Bug report',
    content: overrides.content ?? 'Something is broken',
    authorPubkey: overrides.authorPubkey ?? 'ab'.repeat(32),
    createdAt: overrides.createdAt ?? 1700000000,
    labels: overrides.labels ?? [],
    status: overrides.status ?? 'open',
  };
}

function createPRMetadata(overrides: Partial<PRMetadata> = {}): PRMetadata {
  return {
    eventId: overrides.eventId ?? 'p'.repeat(64),
    title: overrides.title ?? 'Add feature',
    content: overrides.content ?? 'Patch content',
    authorPubkey: overrides.authorPubkey ?? 'ab'.repeat(32),
    createdAt: overrides.createdAt ?? 1700000000,
    commitShas: overrides.commitShas ?? ['abc123'],
    baseBranch: overrides.baseBranch ?? 'main',
    status: overrides.status ?? 'open',
  };
}

function createCommentMetadata(
  overrides: Partial<CommentMetadata> = {}
): CommentMetadata {
  return {
    eventId: overrides.eventId ?? 'c'.repeat(64),
    content: overrides.content ?? 'A comment',
    authorPubkey: overrides.authorPubkey ?? 'cd'.repeat(32),
    createdAt: overrides.createdAt ?? 1700001000,
    parentEventId: overrides.parentEventId ?? 'i'.repeat(64),
  };
}

describe('Templates - Story 8.5: Issue List (8.5-UNIT-005)', () => {
  const cache = new ProfileCache();

  it('[P1] renders issues with title, author, date, labels', () => {
    const issues = [
      createIssueMetadata({
        title: 'Fix the parser',
        labels: ['bug', 'urgent'],
      }),
      createIssueMetadata({
        title: 'Add feature X',
        labels: [],
      }),
    ];

    const result = renderIssueList('test-repo', issues, cache, 'npub1test');

    expect(result.status).toBe(200);
    expect(result.html).toContain('Fix the parser');
    expect(result.html).toContain('Add feature X');
    expect(result.html).toContain('bug');
    expect(result.html).toContain('urgent');
    expect(result.html).toContain('issue-title-link');
  });

  it('[P1] renders empty state when no issues', () => {
    const result = renderIssueList('test-repo', [], cache, 'npub1test');

    expect(result.status).toBe(200);
    expect(result.html).toContain('No issues found for this repository');
    expect(result.html).toContain('kind:1621');
  });

  it('[P0] XSS in issue title is escaped', () => {
    const issues = [
      createIssueMetadata({
        title: '<script>alert(1)</script>',
      }),
    ];

    const result = renderIssueList('test-repo', issues, cache, 'npub1test');

    expect(result.html).not.toContain('<script>');
    expect(result.html).toContain('&lt;script&gt;');
  });
});

describe('Templates - Story 8.5: Issue Detail (8.5-UNIT-006)', () => {
  const cache = new ProfileCache();

  it('[P1] renders comments in chronological order', () => {
    const issue = createIssueMetadata({ title: 'Test issue' });
    const comments = [
      createCommentMetadata({
        content: 'First comment',
        createdAt: 1700001000,
      }),
      createCommentMetadata({
        content: 'Second comment',
        createdAt: 1700002000,
      }),
    ];

    const result = renderIssueDetail(
      'test-repo',
      issue,
      comments,
      cache,
      'npub1test'
    );

    expect(result.status).toBe(200);
    const firstIdx = result.html.indexOf('First comment');
    const secondIdx = result.html.indexOf('Second comment');
    expect(firstIdx).toBeLessThan(secondIdx);
  });

  it('[P1] renders issue body and metadata', () => {
    const issue = createIssueMetadata({
      title: 'Important bug',
      content: 'Details about the bug',
      labels: ['critical'],
      status: 'open',
    });

    const result = renderIssueDetail(
      'test-repo',
      issue,
      [],
      cache,
      'npub1test'
    );

    expect(result.html).toContain('Important bug');
    expect(result.html).toContain('Details about the bug');
    expect(result.html).toContain('critical');
    expect(result.html).toContain('status-open');
  });

  it('[P1] includes navigation tabs (AC #22)', () => {
    const issue = createIssueMetadata({ title: 'Tab test' });

    const result = renderIssueDetail(
      'test-repo',
      issue,
      [],
      cache,
      'npub1test'
    );

    expect(result.html).toContain('repo-tabs');
  });
});

describe('Templates - Story 8.5: PR List', () => {
  const cache = new ProfileCache();

  it('[P1] renders PRs with correct status badges', () => {
    const prs = [
      createPRMetadata({ title: 'Open PR', status: 'open' }),
      createPRMetadata({ title: 'Applied PR', status: 'applied' }),
      createPRMetadata({ title: 'Closed PR', status: 'closed' }),
      createPRMetadata({ title: 'Draft PR', status: 'draft' }),
    ];

    const result = renderPRList('test-repo', prs, cache, 'npub1test');

    expect(result.html).toContain('status-open');
    expect(result.html).toContain('status-applied');
    expect(result.html).toContain('status-closed');
    expect(result.html).toContain('status-draft');
  });

  it('[P1] renders empty state when no PRs', () => {
    const result = renderPRList('test-repo', [], cache, 'npub1test');

    expect(result.status).toBe(200);
    expect(result.html).toContain('No pull requests found for this repository');
    expect(result.html).toContain('kind:1617');
  });
});

describe('Templates - Story 8.5: PR Detail', () => {
  const cache = new ProfileCache();

  it('[P1] renders commit SHA links, status badge, comments', () => {
    const pr = createPRMetadata({
      title: 'Feature PR',
      commitShas: ['abc1234567890', 'def4567890abc'],
      baseBranch: 'develop',
      status: 'applied',
    });
    const comments = [createCommentMetadata({ content: 'LGTM' })];

    const result = renderPRDetail(
      'test-repo',
      pr,
      comments,
      cache,
      'npub1test'
    );

    expect(result.html).toContain('abc1234');
    expect(result.html).toContain('def4567');
    expect(result.html).toContain('/commit/');
    expect(result.html).toContain('status-applied');
    expect(result.html).toContain('develop');
    expect(result.html).toContain('LGTM');
  });

  it('[P1] renders patch body content via renderMarkdownSafe (AC #14)', () => {
    const pr = createPRMetadata({
      content: 'Patch body with https://example.com link\n\nSecond paragraph',
    });

    const result = renderPRDetail('test-repo', pr, [], cache, 'npub1test');

    // renderMarkdownSafe auto-links URLs and converts double newlines
    expect(result.html).toContain('<a href=');
    expect(result.html).toContain('https://example.com');
    expect(result.html).toContain('<br><br>');
  });

  it('[P1] includes navigation tabs (AC #22)', () => {
    const pr = createPRMetadata({ title: 'Tab test PR' });

    const result = renderPRDetail('test-repo', pr, [], cache, 'npub1test');

    expect(result.html).toContain('repo-tabs');
  });
});

describe('Templates - Story 8.5: Contribution Banner (8.5-UNIT-008)', () => {
  const cache = new ProfileCache();

  it('[P1] contribution banner is present on issue list page', () => {
    const result = renderIssueList('test-repo', [], cache, 'npub1test');

    expect(result.html).toContain('contribution-banner');
    expect(result.html).toContain('Forge-UI is read-only');
    expect(result.html).toContain('NIP-34');
  });

  it('[P1] contribution banner is present on PR list page', () => {
    const result = renderPRList('test-repo', [], cache, 'npub1test');

    expect(result.html).toContain('contribution-banner');
    expect(result.html).toContain('Forge-UI is read-only');
  });

  it('[P1] contribution banner is present on issue detail page', () => {
    const issue = createIssueMetadata({ title: 'Test' });
    const result = renderIssueDetail(
      'test-repo',
      issue,
      [],
      cache,
      'npub1test'
    );

    expect(result.html).toContain('contribution-banner');
  });

  it('[P1] contribution banner is present on PR detail page', () => {
    const pr = createPRMetadata({ title: 'Test PR' });
    const result = renderPRDetail('test-repo', pr, [], cache, 'npub1test');

    expect(result.html).toContain('contribution-banner');
  });
});

describe('Templates - Story 8.5: Navigation Tabs', () => {
  it('[P1] renders tabs with correct active state for issues', () => {
    const html = renderRepoTabs('npub1test', 'my-repo', 'issues');

    expect(html).toContain('repo-tabs');
    expect(html).toContain('Code');
    expect(html).toContain('Issues');
    expect(html).toContain('Pull Requests');
    // Issues tab should be active
    expect(html).toMatch(/Issues<\/a>/);
    expect(html).toContain('tab-active');
  });

  it('[P1] renders tabs with correct active state for code', () => {
    const html = renderRepoTabs('npub1test', 'my-repo', 'code', 'main');

    expect(html).toContain('/tree/main/');
    expect(html).toContain('tab-active');
  });

  it('[P1] code tab links to bare repo URL when ref is undefined', () => {
    const html = renderRepoTabs('npub1test', 'my-repo', 'issues');

    expect(html).toContain('/npub1test/my-repo/');
    expect(html).toContain('/npub1test/my-repo/issues');
    expect(html).toContain('/npub1test/my-repo/pulls');
  });

  it('[P1] issue and PR list templates include navigation tabs', () => {
    const cache = new ProfileCache();
    const issueResult = renderIssueList('test-repo', [], cache, 'npub1test');
    const prResult = renderPRList('test-repo', [], cache, 'npub1test');

    expect(issueResult.html).toContain('repo-tabs');
    expect(prResult.html).toContain('repo-tabs');
  });

  it('[P1] renders tabs with correct active state for pulls', () => {
    const html = renderRepoTabs('npub1test', 'my-repo', 'pulls');

    expect(html).toContain('Pull Requests');
    // Pulls tab should be active
    const container = document.createElement('div');
    container.innerHTML = html;
    const activeTab = container.querySelector('.tab-active');
    expect(activeTab).not.toBeNull();
    expect(activeTab!.textContent).toBe('Pull Requests');
  });

  it('[P1] issues tab links to /<owner>/<repo>/issues', () => {
    const html = renderRepoTabs('npub1test', 'my-repo', 'code', 'main');

    const container = document.createElement('div');
    container.innerHTML = html;
    const tabs = container.querySelectorAll('.repo-tab');
    const issuesTab = Array.from(tabs).find(
      (t) => t.textContent === 'Issues'
    ) as HTMLAnchorElement;
    expect(issuesTab).not.toBeNull();
    expect(issuesTab.getAttribute('href')).toBe('/npub1test/my-repo/issues');
  });

  it('[P1] pull requests tab links to /<owner>/<repo>/pulls', () => {
    const html = renderRepoTabs('npub1test', 'my-repo', 'code', 'main');

    const container = document.createElement('div');
    container.innerHTML = html;
    const tabs = container.querySelectorAll('.repo-tab');
    const pullsTab = Array.from(tabs).find(
      (t) => t.textContent === 'Pull Requests'
    ) as HTMLAnchorElement;
    expect(pullsTab).not.toBeNull();
    expect(pullsTab.getAttribute('href')).toBe('/npub1test/my-repo/pulls');
  });
});

// ============================================================================
// NFR: XSS Prevention in Comments and Detail Views
// ============================================================================

describe('Templates - NFR: XSS in Issue/PR Comments', () => {
  const cache = new ProfileCache();

  it('[P0] XSS in comment content is escaped via renderMarkdownSafe', () => {
    const issue = createIssueMetadata({ title: 'Test' });
    const comments = [
      createCommentMetadata({
        content: '<script>alert("xss")</script>',
      }),
    ];

    const result = renderIssueDetail(
      'test-repo',
      issue,
      comments,
      cache,
      'npub1test'
    );

    expect(result.html).not.toContain('<script>alert');
    expect(result.html).toContain('&lt;script&gt;');
  });

  it('[P0] XSS in PR comment content is escaped', () => {
    const pr = createPRMetadata({ title: 'Test PR' });
    const comments = [
      createCommentMetadata({
        content: '<img onerror="alert(1)" src=x>',
      }),
    ];

    const result = renderPRDetail(
      'test-repo',
      pr,
      comments,
      cache,
      'npub1test'
    );

    expect(result.html).not.toContain('<img');
    expect(result.html).toContain('&lt;img');
  });

  it('[P0] XSS in issue labels is escaped', () => {
    const issues = [
      createIssueMetadata({
        title: 'Test',
        labels: ['<script>alert(1)</script>'],
      }),
    ];

    const result = renderIssueList('test-repo', issues, cache, 'npub1test');

    expect(result.html).not.toContain('<script>');
    expect(result.html).toContain('&lt;script&gt;');
  });

  it('[P0] XSS in PR title is escaped in detail view', () => {
    const pr = createPRMetadata({
      title: '"><svg onload=alert(1)>',
    });

    const result = renderPRDetail('test-repo', pr, [], cache, 'npub1test');

    const container = document.createElement('div');
    container.innerHTML = result.html;
    expect(container.querySelectorAll('svg')).toHaveLength(0);
    expect(result.html).toContain('&quot;&gt;&lt;svg');
  });

  it('[P1] issue list title links to /<npub>/<repo>/issues/<eventId> (AC #10)', () => {
    const eventId = 'a'.repeat(64);
    const issues = [createIssueMetadata({ eventId, title: 'Test link' })];

    const result = renderIssueList('test-repo', issues, cache, 'npub1test');

    const container = document.createElement('div');
    container.innerHTML = result.html;
    const titleLink = container.querySelector(
      '.issue-title-link'
    ) as HTMLAnchorElement;
    expect(titleLink).not.toBeNull();
    expect(titleLink.getAttribute('href')).toContain(
      `/npub1test/test-repo/issues/${eventId}`
    );
  });

  it('[P1] PR list title links to /<npub>/<repo>/pulls/<eventId> (AC #13)', () => {
    const eventId = 'b'.repeat(64);
    const prs = [createPRMetadata({ eventId, title: 'PR link test' })];

    const result = renderPRList('test-repo', prs, cache, 'npub1test');

    const container = document.createElement('div');
    container.innerHTML = result.html;
    const titleLink = container.querySelector(
      '.pr-title-link'
    ) as HTMLAnchorElement;
    expect(titleLink).not.toBeNull();
    expect(titleLink.getAttribute('href')).toContain(
      `/npub1test/test-repo/pulls/${eventId}`
    );
  });

  it('[P1] PR detail commit SHAs link to /<npub>/<repo>/commit/<sha> (AC #14)', () => {
    const pr = createPRMetadata({
      commitShas: ['abc1234567890def1234567890abcdef12345678'],
    });

    const result = renderPRDetail('test-repo', pr, [], cache, 'npub1test');

    const container = document.createElement('div');
    container.innerHTML = result.html;
    const commitLink = container.querySelector(
      '.commit-sha'
    ) as HTMLAnchorElement;
    expect(commitLink).not.toBeNull();
    expect(commitLink.getAttribute('href')).toContain(
      '/npub1test/test-repo/commit/abc1234567890def1234567890abcdef12345678'
    );
    // Displays abbreviated hash (first 7 chars)
    expect(commitLink.textContent).toBe('abc1234');
  });

  it('[P1] issue detail body uses renderMarkdownSafe for content (AC #11)', () => {
    const issue = createIssueMetadata({
      title: 'Markdown test',
      content: 'Visit https://example.com for info\n\nNew paragraph',
    });

    const result = renderIssueDetail(
      'test-repo',
      issue,
      [],
      cache,
      'npub1test'
    );

    // renderMarkdownSafe should auto-link URLs
    expect(result.html).toContain('<a href=');
    expect(result.html).toContain('https://example.com');
    // Double newline should produce <br><br>
    expect(result.html).toContain('<br><br>');
  });

  it('[P1] PR detail base branch is displayed (AC #14)', () => {
    const pr = createPRMetadata({ baseBranch: 'release/v2' });

    const result = renderPRDetail('test-repo', pr, [], cache, 'npub1test');

    expect(result.html).toContain('release/v2');
    expect(result.html).toContain('pr-base-branch');
  });

  it('[P1] event IDs in detail URLs are properly encoded', () => {
    const issues = [
      createIssueMetadata({
        eventId: 'abc/<script>',
      }),
    ];

    const result = renderIssueList('test-repo', issues, cache, 'npub1test');

    // The event ID should be URI-encoded in the href
    expect(result.html).toContain(encodeURIComponent('abc/<script>'));
    // Must not contain raw script tag
    expect(result.html).not.toContain('<script>');
  });
});

// ============================================================================
// Story 8.1 Tests - Forge-UI Repository List
// ============================================================================

function createRepoMetadata(
  overrides: {
    name?: string;
    description?: string;
    ownerPubkey?: string;
    defaultBranch?: string;
    eventId?: string;
    cloneUrls?: string[];
    webUrls?: string[];
  } = {}
) {
  return {
    name: overrides.name ?? 'test-repo',
    description: overrides.description ?? 'A test repository',
    ownerPubkey: overrides.ownerPubkey ?? 'ab'.repeat(32),
    defaultBranch: overrides.defaultBranch ?? 'main',
    eventId: overrides.eventId ?? 'a'.repeat(64),
    cloneUrls: overrides.cloneUrls ?? [],
    webUrls: overrides.webUrls ?? [],
  };
}

describe('Templates - Story 8.1: Repo List with RepoMetadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('[P1] renders repo list with name, description, owner pubkey, and default branch', () => {
    const repos = [
      createRepoMetadata({
        name: 'forge-ui',
        description: 'A decentralized git forge',
        ownerPubkey: 'cd'.repeat(32),
        defaultBranch: 'develop',
      }),
      createRepoMetadata({
        name: 'toon-core',
        description: 'Core protocol library',
        ownerPubkey: 'ef'.repeat(32),
        defaultBranch: 'main',
      }),
    ];

    const html = renderRepoList(repos);

    expect(html).toContain('forge-ui');
    expect(html).toContain('toon-core');
    expect(html).toContain('A decentralized git forge');
    expect(html).toContain('Core protocol library');
    expect(html).not.toContain('No repositories');
  });

  it('[P1] renders owner pubkey as truncated npub in repo list', () => {
    const repos = [
      createRepoMetadata({
        name: 'owner-test',
        ownerPubkey: 'cd'.repeat(32),
      }),
    ];

    const html = renderRepoList(repos);

    expect(html).toContain('npub1');
    expect(html).toContain('...');
    expect(html).toContain('repo-owner');
  });

  it('[P1] renders default branch badge in repo list', () => {
    const repos = [
      createRepoMetadata({
        name: 'branch-test',
        defaultBranch: 'develop',
      }),
    ];

    const html = renderRepoList(repos);

    expect(html).toContain('develop');
    expect(html).toContain('repo-branch-badge');
  });

  it('[P2] renders "No repositories found" when repos array is empty', () => {
    const repos: ReturnType<typeof createRepoMetadata>[] = [];

    const html = renderRepoList(repos);

    expect(html).toContain('No repositories');
  });
});

describe('Templates - Story 8.1: XSS Prevention in Repo List', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('[P0] repo name containing <script> tag is HTML-escaped in rendered output', () => {
    const repos = [
      createRepoMetadata({
        name: '<script>alert(1)</script>',
        description: 'Normal description',
      }),
    ];

    const html = renderRepoList(repos);

    expect(html).not.toContain('<script>');
    expect(html).not.toContain('</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('[P0] repo description containing <img onerror> is HTML-escaped in rendered output', () => {
    const repos = [
      createRepoMetadata({
        name: 'safe-repo',
        description: '<img onerror=alert(1) src=x>',
      }),
    ];

    const html = renderRepoList(repos);
    const container = document.createElement('div');
    container.innerHTML = html;

    expect(container.querySelectorAll('img[onerror]')).toHaveLength(0);
    expect(html).toContain('&lt;img');
  });

  it('[P0] repo name with nested XSS payload is escaped', () => {
    const repos = [
      createRepoMetadata({
        name: '"><svg onload=alert(1)>',
        description: 'Normal',
      }),
    ];

    const html = renderRepoList(repos);
    const container = document.createElement('div');
    container.innerHTML = html;

    expect(container.querySelectorAll('svg')).toHaveLength(0);
    expect(container.querySelectorAll('svg[onload]')).toHaveLength(0);
  });

  it('[P0] repo description with javascript: URI is escaped', () => {
    const repos = [
      createRepoMetadata({
        name: 'normal-repo',
        description: '<a href="javascript:alert(1)">click</a>',
      }),
    ];

    const html = renderRepoList(repos);
    const container = document.createElement('div');
    container.innerHTML = html;

    const links = container.querySelectorAll('a[href^="javascript:"]');
    expect(links).toHaveLength(0);
    expect(html).toContain('&lt;a');
  });
});

// ============================================================================
// Story 8.2 Tests - Tree View and Blob View
// ============================================================================

describe('Templates - Story 8.2: Tree View Rendering', () => {
  it('[P1] renders directory listing with names and links', () => {
    const entries: TreeEntry[] = [
      createMockTreeEntry({ mode: '100644', name: 'index.ts' }),
      createMockTreeEntry({ mode: '40000', name: 'src' }),
    ];

    const result = renderTreeView(
      'test-repo',
      'main',
      '',
      entries,
      'npub1test'
    );

    expect(result.status).toBe(200);
    expect(result.html).toContain('index.ts');
    expect(result.html).toContain('src');
    expect(result.html).toContain('<a href=');
  });

  it('[P1] sorts directories before files', () => {
    const entries: TreeEntry[] = [
      createMockTreeEntry({ mode: '100644', name: 'zz-file.ts' }),
      createMockTreeEntry({ mode: '40000', name: 'aa-dir' }),
      createMockTreeEntry({ mode: '100644', name: 'aa-file.ts' }),
      createMockTreeEntry({ mode: '40000', name: 'zz-dir' }),
    ];

    const result = renderTreeView(
      'test-repo',
      'main',
      '',
      entries,
      'npub1test'
    );

    const html = result.html;
    // Directories should appear before files
    const aaDirPos = html.indexOf('aa-dir');
    const zzDirPos = html.indexOf('zz-dir');
    const aaFilePos = html.indexOf('aa-file.ts');
    const zzFilePos = html.indexOf('zz-file.ts');

    expect(aaDirPos).toBeLessThan(aaFilePos);
    expect(zzDirPos).toBeLessThan(aaFilePos);
    // Within directories: alphabetical
    expect(aaDirPos).toBeLessThan(zzDirPos);
    // Within files: alphabetical
    expect(aaFilePos).toBeLessThan(zzFilePos);
  });

  it('[P1] directories link to tree routes, files link to blob routes', () => {
    const entries: TreeEntry[] = [
      createMockTreeEntry({ mode: '40000', name: 'src' }),
      createMockTreeEntry({ mode: '100644', name: 'README.md' }),
    ];

    const result = renderTreeView(
      'test-repo',
      'main',
      '',
      entries,
      'npub1test'
    );

    expect(result.html).toContain('/tree/');
    expect(result.html).toContain('/blob/');
  });

  it('[P0] XSS in file names is escaped in tree view', () => {
    const entries: TreeEntry[] = [
      createMockTreeEntry({
        mode: '100644',
        name: '<script>alert(1)</script>',
      }),
    ];

    const result = renderTreeView(
      'test-repo',
      'main',
      '',
      entries,
      'npub1test'
    );

    expect(result.html).not.toContain('<script>alert');
    expect(result.html).toContain('&lt;script&gt;');
  });

  it('[P1] renders breadcrumb navigation for nested paths', () => {
    const entries: TreeEntry[] = [
      createMockTreeEntry({ mode: '100644', name: 'index.ts' }),
    ];

    const result = renderTreeView(
      'test-repo',
      'main',
      'src/web',
      entries,
      'npub1test'
    );

    expect(result.html).toContain('breadcrumb');
    expect(result.html).toContain('src');
    expect(result.html).toContain('web');
  });

  it('[P1] displays mode values for each tree entry (AC #11)', () => {
    const entries: TreeEntry[] = [
      createMockTreeEntry({ mode: '100644', name: 'file.ts' }),
      createMockTreeEntry({ mode: '40000', name: 'dir' }),
      createMockTreeEntry({ mode: '100755', name: 'run.sh' }),
    ];

    const result = renderTreeView(
      'test-repo',
      'main',
      '',
      entries,
      'npub1test'
    );

    expect(result.html).toContain('100644');
    expect(result.html).toContain('40000');
    expect(result.html).toContain('100755');
    expect(result.html).toContain('tree-entry-mode');
  });

  it('[P1] renders different icons for directories, files, symlinks, and submodules (AC #11)', () => {
    const entries: TreeEntry[] = [
      createMockTreeEntry({ mode: '40000', name: 'dir' }),
      createMockTreeEntry({ mode: '100644', name: 'file.ts' }),
      createMockTreeEntry({ mode: '120000', name: 'link' }),
      createMockTreeEntry({ mode: '160000', name: 'submod' }),
    ];

    const result = renderTreeView(
      'test-repo',
      'main',
      '',
      entries,
      'npub1test'
    );

    const container = document.createElement('div');
    container.innerHTML = result.html;

    const icons = container.querySelectorAll('.tree-entry-icon');
    expect(icons).toHaveLength(4);

    // Each icon cell should have content (the icon entity)
    const iconTexts = Array.from(icons).map((el) => el.innerHTML);
    // Verify icons are not all the same (different modes get different icons)
    const uniqueIcons = new Set(iconTexts);
    expect(uniqueIcons.size).toBeGreaterThanOrEqual(3);
  });

  it('[P1] breadcrumb segments are clickable links to correct directory levels (AC #13)', () => {
    const entries: TreeEntry[] = [
      createMockTreeEntry({ mode: '100644', name: 'templates.ts' }),
    ];

    const result = renderTreeView(
      'test-repo',
      'main',
      'src/web',
      entries,
      'npub1test'
    );

    const container = document.createElement('div');
    container.innerHTML = result.html;

    const breadcrumbLinks = container.querySelectorAll('.breadcrumb-link');
    expect(breadcrumbLinks.length).toBeGreaterThanOrEqual(3);

    // First link: repo root
    const rootLink = breadcrumbLinks[0] as HTMLAnchorElement;
    expect(rootLink.textContent).toBe('test-repo');
    expect(rootLink.getAttribute('href')).toContain('/tree/main/');

    // Second link: src directory
    const srcLink = breadcrumbLinks[1] as HTMLAnchorElement;
    expect(srcLink.textContent).toBe('src');
    expect(srcLink.getAttribute('href')).toContain('/tree/main/src');

    // Third link: src/web directory
    const webLink = breadcrumbLinks[2] as HTMLAnchorElement;
    expect(webLink.textContent).toBe('web');
    expect(webLink.getAttribute('href')).toContain('/tree/main/src/web');
  });

  it('[P1] subdirectory entries link to correct nested tree paths (AC #12)', () => {
    const entries: TreeEntry[] = [
      createMockTreeEntry({ mode: '40000', name: 'templates' }),
      createMockTreeEntry({ mode: '100644', name: 'utils.ts' }),
    ];

    const result = renderTreeView(
      'test-repo',
      'main',
      'src/web',
      entries,
      'npub1test'
    );

    const container = document.createElement('div');
    container.innerHTML = result.html;

    const links = container.querySelectorAll('.tree-entry-name a');
    // Find the directory link
    const dirLink = Array.from(links).find(
      (a) => a.textContent === 'templates'
    ) as HTMLAnchorElement;
    expect(dirLink).toBeDefined();
    // Directory link should go to tree route with nested path
    expect(dirLink.getAttribute('href')).toContain(
      '/tree/main/src/web/templates'
    );

    // Find the file link
    const fileLink = Array.from(links).find(
      (a) => a.textContent === 'utils.ts'
    ) as HTMLAnchorElement;
    expect(fileLink).toBeDefined();
    // File link should go to blob route
    expect(fileLink.getAttribute('href')).toContain(
      '/blob/main/src/web/utils.ts'
    );
  });

  // ---------------------------------------------------------------------------
  // Story 8.3 AC #17: Commits link in tree view breadcrumbs
  // ---------------------------------------------------------------------------

  it('[P1] tree view breadcrumbs contain Commits link pointing to commits route (AC #17)', () => {
    const entries: TreeEntry[] = [
      createMockTreeEntry({ mode: '100644', name: 'index.ts' }),
    ];

    const result = renderTreeView(
      'test-repo',
      'main',
      '',
      entries,
      'npub1test'
    );

    const container = document.createElement('div');
    container.innerHTML = result.html;

    const commitsLink = container.querySelector(
      '.breadcrumb-commits-link'
    ) as HTMLAnchorElement;
    expect(commitsLink).not.toBeNull();
    expect(commitsLink.textContent).toBe('Commits');
    expect(commitsLink.getAttribute('href')).toContain(
      '/npub1test/test-repo/commits/main'
    );
  });
});

describe('Templates - Story 8.2: Blob View Rendering', () => {
  it('[P1] renders text content with line numbers', () => {
    const content = 'line one\nline two\nline three';

    const result = renderBlobView(
      'test-repo',
      'main',
      'src/index.ts',
      content,
      false,
      27,
      'npub1test'
    );

    expect(result.status).toBe(200);
    expect(result.html).toContain('line one');
    expect(result.html).toContain('line two');
    expect(result.html).toContain('line-number');
    expect(result.html).toContain('<pre');
    expect(result.html).toContain('<code>');
  });

  it('[P1] renders "Binary file" message for binary blobs', () => {
    const result = renderBlobView(
      'test-repo',
      'main',
      'image.png',
      null,
      true,
      12345,
      'npub1test'
    );

    expect(result.status).toBe(200);
    expect(result.html).toContain('Binary file');
    expect(result.html).toContain('12345 bytes');
    expect(result.html).toContain('not displayed');
  });

  it('[P0] XSS in blob content (script tags) is escaped', () => {
    const content = '<script>alert("xss")</script>';

    const result = renderBlobView(
      'test-repo',
      'main',
      'test.html',
      content,
      false,
      content.length,
      'npub1test'
    );

    expect(result.html).not.toContain('<script>alert');
    expect(result.html).toContain('&lt;script&gt;');

    // Verify in DOM
    const container = document.createElement('div');
    container.innerHTML = result.html;
    expect(container.querySelectorAll('script')).toHaveLength(0);
  });

  it('[P0] XSS in blob content (img onerror) is escaped', () => {
    const content = '<img src=x onerror=alert(1)>';

    const result = renderBlobView(
      'test-repo',
      'main',
      'test.html',
      content,
      false,
      content.length,
      'npub1test'
    );

    const container = document.createElement('div');
    container.innerHTML = result.html;
    expect(container.querySelectorAll('img[onerror]')).toHaveLength(0);
  });

  it('[P1] renders breadcrumbs for blob view', () => {
    const result = renderBlobView(
      'test-repo',
      'main',
      'src/web/index.ts',
      'content',
      false,
      7,
      'npub1test'
    );

    expect(result.html).toContain('breadcrumb');
    expect(result.html).toContain('src');
    expect(result.html).toContain('web');
  });

  it('[P1] blob view displays filename and size in header (AC #14)', () => {
    const result = renderBlobView(
      'test-repo',
      'main',
      'src/index.ts',
      'const x = 1;',
      false,
      12,
      'npub1test'
    );

    expect(result.html).toContain('index.ts');
    expect(result.html).toContain('12 bytes');
    expect(result.html).toContain('blob-header');
  });

  it('[P1] blob breadcrumb segments are clickable links to directory levels (AC #14)', () => {
    const result = renderBlobView(
      'test-repo',
      'main',
      'src/web/index.ts',
      'content',
      false,
      7,
      'npub1test'
    );

    const container = document.createElement('div');
    container.innerHTML = result.html;

    const breadcrumbLinks = container.querySelectorAll('.breadcrumb-link');
    expect(breadcrumbLinks.length).toBeGreaterThanOrEqual(3);

    // Root repo link
    const rootLink = breadcrumbLinks[0] as HTMLAnchorElement;
    expect(rootLink.textContent).toBe('test-repo');
    expect(rootLink.getAttribute('href')).toContain('/tree/main/');

    // src link
    const srcLink = breadcrumbLinks[1] as HTMLAnchorElement;
    expect(srcLink.textContent).toBe('src');
    expect(srcLink.getAttribute('href')).toContain('/tree/main/src');
  });

  it('[P1] blob view renders correct number of line numbers (AC #14)', () => {
    const content = 'line1\nline2\nline3\nline4\nline5';

    const result = renderBlobView(
      'test-repo',
      'main',
      'file.ts',
      content,
      false,
      content.length,
      'npub1test'
    );

    const container = document.createElement('div');
    container.innerHTML = result.html;

    const lineNumbers = container.querySelectorAll('.line-number');
    expect(lineNumbers).toHaveLength(5);
    expect(lineNumbers[0]!.textContent).toBe('1');
    expect(lineNumbers[4]!.textContent).toBe('5');
  });

  // ---------------------------------------------------------------------------
  // Story 8.3 AC #17: Commits link in blob view breadcrumbs
  // ---------------------------------------------------------------------------

  it('[P1] blob view breadcrumbs contain Commits link pointing to commits route (AC #17)', () => {
    const result = renderBlobView(
      'test-repo',
      'main',
      'src/index.ts',
      'const x = 1;',
      false,
      12,
      'npub1test'
    );

    const container = document.createElement('div');
    container.innerHTML = result.html;

    const commitsLink = container.querySelector(
      '.breadcrumb-commits-link'
    ) as HTMLAnchorElement;
    expect(commitsLink).not.toBeNull();
    expect(commitsLink.textContent).toBe('Commits');
    expect(commitsLink.getAttribute('href')).toContain(
      '/npub1test/test-repo/commits/main'
    );
  });
});
