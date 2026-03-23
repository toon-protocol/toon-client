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
  renderBlameView,
  renderIssueContent,
  renderIssuesPage,
} from './templates.js';
import type { TreeEntry } from './git-objects.js';

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

describe('Templates - Blame View', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('[P3] renderBlameView returns 404 for file not in repo', () => {
    const result = renderBlameView(
      'test-repo',
      'main',
      'missing-file.ts',
      null
    );

    expect(result.status).toBe(404);
    expect(result.html).toContain('404');
  });
});

describe('Templates - XSS Prevention', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('[P0] script tags in issue content are escaped', () => {
    const maliciousIssue = createMockIssue({
      content: '<script>alert(1)</script>',
      title: 'Normal title',
    });

    const html = renderIssueContent(maliciousIssue);

    expect(html).not.toContain('<script>');
    expect(html).not.toContain('</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('[P0] onerror handler in img tag is escaped', () => {
    const maliciousIssue = createMockIssue({
      content: '<img onerror=alert(1) src=x>',
    });

    const html = renderIssueContent(maliciousIssue);
    const container = document.createElement('div');
    container.innerHTML = html;

    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(container.querySelectorAll('img[onerror]')).toHaveLength(0);
    expect(html).toContain('&lt;img');
  });

  it('[P0] javascript: URI in content is escaped', () => {
    const maliciousIssue = createMockIssue({
      content: '<a href="javascript:alert(1)">click me</a>',
    });

    const html = renderIssueContent(maliciousIssue);
    const container = document.createElement('div');
    container.innerHTML = html;

    const links = container.querySelectorAll('a[href^="javascript:"]');
    expect(links).toHaveLength(0);
    expect(html).toContain('&lt;a');
  });

  it('[P0] XSS in issue title is escaped', () => {
    const maliciousIssue = createMockIssue({
      title: '<script>document.cookie</script>',
      content: 'Normal content',
    });

    const html = renderIssueContent(maliciousIssue);

    expect(html).not.toContain('<script>');
  });

  it('[P0] nested XSS payload is escaped', () => {
    const maliciousIssue = createMockIssue({
      content: '"><svg onload=alert(1)>',
    });

    const html = renderIssueContent(maliciousIssue);
    const container = document.createElement('div');
    container.innerHTML = html;

    expect(container.querySelectorAll('svg')).toHaveLength(0);
    expect(container.querySelectorAll('svg[onload]')).toHaveLength(0);
  });
});

describe('Templates - Contribution Banner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('[P3] issues page renders contribution banner with ILP/Nostr requirement', () => {
    const html = renderIssuesPage('test-repo', [createMockIssue()]);

    expect(html).toContain('participation requires an ILP/Nostr client');
  });

  it('[P3] contribution banner includes documentation link', () => {
    const html = renderIssuesPage('test-repo', [createMockIssue()]);

    expect(html).toMatch(/<a[^>]*href="[^"]*"[^>]*>/);
    expect(html).toMatch(/documentation|docs|getting started/i);
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
});
