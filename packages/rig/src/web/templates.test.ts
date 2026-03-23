// @vitest-environment jsdom
// Tests for Forge-UI templates
//
// Test IDs: 3.7-UNIT-001, 3.8-UNIT-001, 3.9-UNIT-001, 3.10-UNIT-001,
//           3.11-UNIT-001, 3.11-UNIT-002
//           8.1-UNIT-002, 8.1-UNIT-003, 8.1-UNIT-009, 8.1-UNIT-010
// Risk links: E3-R004 (XSS via Nostr event content), E3-R011 (template port fidelity)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  renderRepoList,
  renderTreeView,
  renderBlobView,
  renderCommitDiff,
  renderBlameView,
  renderIssueContent,
  renderIssuesPage,
} from './templates.js';

// ============================================================================
// Factories
// ============================================================================

/**
 * Factory for creating a mock tree entry (directory/file listing).
 * Retained for future Story 8.2 (file tree view) tests.
 */
function _createMockTreeEntry(
  overrides: {
    mode?: string;
    type?: 'blob' | 'tree';
    name?: string;
    hash?: string;
  } = {}
) {
  return {
    mode: overrides.mode ?? '100644',
    type: overrides.type ?? 'blob',
    name: overrides.name ?? 'README.md',
    hash: overrides.hash ?? 'a'.repeat(40),
  };
}

/**
 * Factory for creating a mock issue sourced from a Nostr event.
 */
function createMockIssue(
  overrides: {
    id?: string;
    pubkey?: string;
    title?: string;
    content?: string;
    createdAt?: number;
  } = {}
) {
  return {
    id: overrides.id ?? 'a'.repeat(64),
    pubkey: overrides.pubkey ?? 'ab'.repeat(32),
    title: overrides.title ?? 'Bug report',
    content: overrides.content ?? 'Something is broken',
    createdAt: overrides.createdAt ?? 1700000000,
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
    // Arrange
    const repos: ReturnType<typeof createRepoMetadata>[] = [];

    // Act
    const html = renderRepoList(repos);

    // Assert
    expect(html).toContain('No repositories');
    expect(html).not.toContain('<a href="/');
  });

  it('[P2] renders repo list when repositories exist', () => {
    // Arrange
    const repos = [
      createRepoMetadata({ name: 'repo-alpha', description: 'First repo' }),
      createRepoMetadata({ name: 'repo-beta', description: 'Second repo' }),
    ];

    // Act
    const html = renderRepoList(repos);

    // Assert
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
    // Arrange
    const repoName = 'test-repo';
    const ref = 'main';
    const path = 'does/not/exist';
    const treeEntries: ReturnType<typeof _createMockTreeEntry>[] | null = null;

    // Act
    const result = renderTreeView(repoName, ref, path, treeEntries);

    // Assert
    expect(result.status).toBe(404);
    expect(result.html).toContain('404');
  });

  it('[P2] renderBlobView returns 404 response for non-existent file', () => {
    // Arrange
    const repoName = 'test-repo';
    const ref = 'main';
    const path = 'nonexistent-file.ts';
    const content: string | null = null;

    // Act
    const result = renderBlobView(repoName, ref, path, content);

    // Assert
    expect(result.status).toBe(404);
    expect(result.html).toContain('404');
  });
});

describe('Templates - Commit Diff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // 3.9-UNIT-001: 404 for invalid commit SHA
  // ---------------------------------------------------------------------------

  it('[P2] renderCommitDiff returns 404 for non-existent commit SHA', () => {
    // Arrange
    const repoName = 'test-repo';
    const sha = 'deadbeef'.repeat(5); // 40-char nonexistent SHA
    const commitData = null;

    // Act
    const result = renderCommitDiff(repoName, sha, commitData);

    // Assert
    expect(result.status).toBe(404);
    expect(result.html).toContain('404');
  });

  it('[P2] renderCommitDiff returns 404 for malformed SHA', () => {
    // Arrange
    const repoName = 'test-repo';
    const sha = 'not-a-valid-sha';
    const commitData = null;

    // Act
    const result = renderCommitDiff(repoName, sha, commitData);

    // Assert
    expect(result.status).toBe(404);
  });
});

describe('Templates - Blame View', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // 3.10-UNIT-001: 404 for non-existent blame file at ref
  // ---------------------------------------------------------------------------

  it('[P3] renderBlameView returns 404 for file not in repo', () => {
    // Arrange
    const repoName = 'test-repo';
    const ref = 'main';
    const path = 'missing-file.ts';
    const blameData = null;

    // Act
    const result = renderBlameView(repoName, ref, path, blameData);

    // Assert
    expect(result.status).toBe(404);
    expect(result.html).toContain('404');
  });
});

describe('Templates - XSS Prevention', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // 3.11-UNIT-001: XSS payloads escaped in templates
  // Risk: E3-R004 (XSS via Nostr event content)
  // ---------------------------------------------------------------------------

  it('[P0] script tags in issue content are escaped', () => {
    // Arrange
    const maliciousIssue = createMockIssue({
      content: '<script>alert(1)</script>',
      title: 'Normal title',
    });

    // Act
    const html = renderIssueContent(maliciousIssue);

    // Assert
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('[P0] onerror handler in img tag is escaped', () => {
    // Arrange
    const maliciousIssue = createMockIssue({
      content: '<img onerror=alert(1) src=x>',
    });

    // Act
    const html = renderIssueContent(maliciousIssue);
    const container = document.createElement('div');
    container.innerHTML = html;

    // Assert -- no img elements should be created in DOM
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(container.querySelectorAll('img[onerror]')).toHaveLength(0);
    // The raw < should be escaped
    expect(html).toContain('&lt;img');
  });

  it('[P0] javascript: URI in content is escaped', () => {
    // Arrange
    const maliciousIssue = createMockIssue({
      content: '<a href="javascript:alert(1)">click me</a>',
    });

    // Act
    const html = renderIssueContent(maliciousIssue);
    const container = document.createElement('div');
    container.innerHTML = html;

    // Assert -- no anchor with javascript: href should be created
    const links = container.querySelectorAll('a[href^="javascript:"]');
    expect(links).toHaveLength(0);
    // The raw < should be escaped
    expect(html).toContain('&lt;a');
  });

  it('[P0] XSS in issue title is escaped', () => {
    // Arrange
    const maliciousIssue = createMockIssue({
      title: '<script>document.cookie</script>',
      content: 'Normal content',
    });

    // Act
    const html = renderIssueContent(maliciousIssue);

    // Assert
    expect(html).not.toContain('<script>');
  });

  it('[P0] nested XSS payload is escaped', () => {
    // Arrange
    const maliciousIssue = createMockIssue({
      content: '"><svg onload=alert(1)>',
    });

    // Act
    const html = renderIssueContent(maliciousIssue);
    const container = document.createElement('div');
    container.innerHTML = html;

    // Assert -- no svg elements should be created in DOM
    expect(container.querySelectorAll('svg')).toHaveLength(0);
    expect(container.querySelectorAll('svg[onload]')).toHaveLength(0);
  });
});

describe('Templates - Contribution Banner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // 3.11-UNIT-002: Contribution banner renders with docs link
  // ---------------------------------------------------------------------------

  it('[P3] issues page renders contribution banner with ILP/Nostr requirement', () => {
    // Arrange
    const repoName = 'test-repo';
    const issues = [createMockIssue()];

    // Act
    const html = renderIssuesPage(repoName, issues);

    // Assert
    expect(html).toContain('participation requires an ILP/Nostr client');
  });

  it('[P3] contribution banner includes documentation link', () => {
    // Arrange
    const repoName = 'test-repo';
    const issues = [createMockIssue()];

    // Act
    const html = renderIssuesPage(repoName, issues);

    // Assert
    // Banner should link to documentation about submitting NIP-34 events
    expect(html).toMatch(/<a[^>]*href="[^"]*"[^>]*>/);
    expect(html).toMatch(/documentation|docs|getting started/i);
  });
});

// ============================================================================
// Story 8.1 Tests - Forge-UI Repository List
// ============================================================================

/**
 * Factory for creating a RepoMetadata object (Story 8.1 format).
 * This matches the RepoMetadata interface expected by the updated renderRepoList().
 */
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

  // ---------------------------------------------------------------------------
  // 8.1-UNIT-002: Repo list renders name, description, owner, branch
  // AC: #5
  // ---------------------------------------------------------------------------

  it('[P1] renders repo list with name, description, owner pubkey, and default branch', () => {
    // Arrange
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

    // Act
    const html = renderRepoList(repos);

    // Assert -- names present
    expect(html).toContain('forge-ui');
    expect(html).toContain('toon-core');
    // Assert -- descriptions present
    expect(html).toContain('A decentralized git forge');
    expect(html).toContain('Core protocol library');
    // Assert -- no empty state
    expect(html).not.toContain('No repositories');
  });

  // ---------------------------------------------------------------------------
  // AC5 gap: verify owner pubkey display and default branch badge
  // ---------------------------------------------------------------------------

  it('[P1] renders owner pubkey as truncated npub in repo list', () => {
    // Arrange
    const repos = [
      createRepoMetadata({
        name: 'owner-test',
        ownerPubkey: 'cd'.repeat(32),
      }),
    ];

    // Act
    const html = renderRepoList(repos);

    // Assert -- should contain npub-derived display (truncated)
    expect(html).toContain('npub1');
    expect(html).toContain('...');
    expect(html).toContain('repo-owner');
  });

  it('[P1] renders default branch badge in repo list', () => {
    // Arrange
    const repos = [
      createRepoMetadata({
        name: 'branch-test',
        defaultBranch: 'develop',
      }),
    ];

    // Act
    const html = renderRepoList(repos);

    // Assert
    expect(html).toContain('develop');
    expect(html).toContain('repo-branch-badge');
  });

  // ---------------------------------------------------------------------------
  // 8.1-UNIT-003: Empty state message
  // AC: #7
  // ---------------------------------------------------------------------------

  it('[P2] renders "No repositories found" when repos array is empty', () => {
    // Arrange
    const repos: ReturnType<typeof createRepoMetadata>[] = [];

    // Act
    const html = renderRepoList(repos);

    // Assert
    expect(html).toContain('No repositories');
  });
});

describe('Templates - Story 8.1: XSS Prevention in Repo List', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // 8.1-UNIT-009: XSS in repo name is escaped
  // AC: #12  Risk: E3-R004
  // ---------------------------------------------------------------------------

  it('[P0] repo name containing <script> tag is HTML-escaped in rendered output', () => {
    // Arrange
    const repos = [
      createRepoMetadata({
        name: '<script>alert(1)</script>',
        description: 'Normal description',
      }),
    ];

    // Act
    const html = renderRepoList(repos);

    // Assert -- raw script tag must NOT appear
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('</script>');
    // Assert -- escaped version MUST appear
    expect(html).toContain('&lt;script&gt;');
  });

  // ---------------------------------------------------------------------------
  // 8.1-UNIT-010: XSS in repo description is escaped
  // AC: #12  Risk: E3-R004
  // ---------------------------------------------------------------------------

  it('[P0] repo description containing <img onerror> is HTML-escaped in rendered output', () => {
    // Arrange
    const repos = [
      createRepoMetadata({
        name: 'safe-repo',
        description: '<img onerror=alert(1) src=x>',
      }),
    ];

    // Act
    const html = renderRepoList(repos);
    const container = document.createElement('div');
    container.innerHTML = html;

    // Assert -- no img elements with onerror should be created in DOM
    expect(container.querySelectorAll('img[onerror]')).toHaveLength(0);
    // The raw < should be escaped
    expect(html).toContain('&lt;img');
  });

  it('[P0] repo name with nested XSS payload is escaped', () => {
    // Arrange
    const repos = [
      createRepoMetadata({
        name: '"><svg onload=alert(1)>',
        description: 'Normal',
      }),
    ];

    // Act
    const html = renderRepoList(repos);
    const container = document.createElement('div');
    container.innerHTML = html;

    // Assert -- no svg elements should be created in DOM
    expect(container.querySelectorAll('svg')).toHaveLength(0);
    expect(container.querySelectorAll('svg[onload]')).toHaveLength(0);
  });

  it('[P0] repo description with javascript: URI is escaped', () => {
    // Arrange
    const repos = [
      createRepoMetadata({
        name: 'normal-repo',
        description: '<a href="javascript:alert(1)">click</a>',
      }),
    ];

    // Act
    const html = renderRepoList(repos);
    const container = document.createElement('div');
    container.innerHTML = html;

    // Assert -- no anchor with javascript: href should be created in DOM
    const links = container.querySelectorAll('a[href^="javascript:"]');
    expect(links).toHaveLength(0);
    // The raw < should be escaped
    expect(html).toContain('&lt;a');
  });
});
