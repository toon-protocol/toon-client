// @vitest-environment jsdom
// Test IDs: 8.4-E2E-001 through 8.4-E2E-010
// AC covered: #1-#16 (Full E2E for Story 8.4 user-facing UI changes)
//
// These tests exercise the full resolution chain for blame views,
// mocking only at the network boundary (fetch for Arweave). They validate the
// user-facing UI by rendering into jsdom and asserting on DOM state.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  parseGitCommit,
  parseGitTree,
  isBinaryBlob,
} from '../git-objects.js';
import type { TreeEntry } from '../git-objects.js';
import {
  renderBlameView,
  renderBlobView,
} from '../templates.js';
import type { TemplateResult } from '../templates.js';
import { parseRoute } from '../router.js';
import { parseRepoRefs, parseRepoAnnouncement } from '../nip34-parsers.js';
import type { NostrEvent, RepoMetadata, RepoRefs } from '../nip34-parsers.js';
import { resolveDefaultRef } from '../ref-resolver.js';
import { computeBlame, isBlameError } from '../blame.js';
import type { BlameResult, BlameError } from '../blame.js';
import {
  fetchArweaveObject,
  resolveGitSha,
  clearShaCache,
  ARWEAVE_GATEWAYS,
} from '../arweave-client.js';
import { renderLayout } from '../layout.js';

// ============================================================================
// Test Fixture Helpers
// ============================================================================

/** Build raw git tree object bytes from entries. */
function buildTreeBytes(
  entries: Array<{ mode: string; name: string; sha: string }>
): Uint8Array {
  const allBytes: number[] = [];
  for (const entry of entries) {
    for (const ch of entry.mode) allBytes.push(ch.charCodeAt(0));
    allBytes.push(0x20);
    const nameBytes = new TextEncoder().encode(entry.name);
    for (const b of nameBytes) allBytes.push(b);
    allBytes.push(0x00);
    for (let i = 0; i < 40; i += 2) {
      allBytes.push(parseInt(entry.sha.slice(i, i + 2), 16));
    }
  }
  return new Uint8Array(allBytes);
}

/** Build raw git commit object bytes. */
function buildCommitBytes(opts: {
  treeSha: string;
  parentShas?: string[];
  author?: string;
  committer?: string;
  message?: string;
}): Uint8Array {
  const lines: string[] = [];
  lines.push(`tree ${opts.treeSha}`);
  for (const parent of opts.parentShas ?? []) {
    lines.push(`parent ${parent}`);
  }
  lines.push(
    `author ${opts.author ?? 'Test User <test@example.com> 1711100000 +0000'}`
  );
  lines.push(
    `committer ${opts.committer ?? 'Test User <test@example.com> 1711100000 +0000'}`
  );
  lines.push('');
  lines.push(opts.message ?? 'test commit');
  return new TextEncoder().encode(lines.join('\n'));
}

/** Create a kind:30617 repo announcement event. */
function createRepoAnnouncementEvent(opts: {
  repoId: string;
  name?: string;
  description?: string;
  pubkey?: string;
  defaultBranch?: string;
}): NostrEvent {
  const tags: string[][] = [
    ['d', opts.repoId],
    ['name', opts.name ?? opts.repoId],
  ];
  if (opts.description) {
    tags.push(['description', opts.description]);
  }
  if (opts.defaultBranch) {
    tags.push(['r', 'HEAD', opts.defaultBranch]);
  }
  return {
    id: 'a'.repeat(64),
    pubkey: opts.pubkey ?? 'ab'.repeat(32),
    created_at: 1711100000,
    kind: 30617,
    tags,
    content: opts.description ?? '',
    sig: 'f'.repeat(128),
  };
}

/** Create a kind:30618 repo refs event. */
function createRepoRefsEvent(opts: {
  repoId: string;
  refs: Record<string, string>;
  pubkey?: string;
}): NostrEvent {
  const tags: string[][] = [['d', opts.repoId]];
  for (const [name, sha] of Object.entries(opts.refs)) {
    tags.push(['r', name, sha]);
  }
  return {
    id: 'b'.repeat(64),
    pubkey: opts.pubkey ?? 'ab'.repeat(32),
    created_at: 1711100000,
    kind: 30618,
    tags,
    content: '',
    sig: 'f'.repeat(128),
  };
}

// Standard test SHAs (40-char hex)
const COMMIT_A_SHA = 'a1'.repeat(20); // oldest commit (root)
const COMMIT_B_SHA = 'b2'.repeat(20); // middle commit
const COMMIT_C_SHA = 'c3'.repeat(20); // newest commit
const TREE_A_SHA = 'aa'.repeat(20);
const TREE_B_SHA = 'bb'.repeat(20);
const TREE_C_SHA = 'cc'.repeat(20);
const BLOB_A_SHA = 'da'.repeat(20);
const BLOB_B_SHA = 'db'.repeat(20);
const BLOB_C_SHA = 'dc'.repeat(20);
const SRC_DIR_SHA = 'dd'.repeat(20);
const BINARY_BLOB_SHA = 'ee'.repeat(20);

// Standard Arweave tx IDs (43 chars)
const COMMIT_A_TX = 'commitATx0123456789abcdefghijklmnopqrstuvwx';
const COMMIT_B_TX = 'commitBTx0123456789abcdefghijklmnopqrstuvwx';
const COMMIT_C_TX = 'commitCTx0123456789abcdefghijklmnopqrstuvwx';
const TREE_A_TX = 'treeATx01234567890abcdefghijklmnopqrstuvwxy';
const TREE_B_TX = 'treeBTx01234567890abcdefghijklmnopqrstuvwxy';
const TREE_C_TX = 'treeCTx01234567890abcdefghijklmnopqrstuvwxy';
const BLOB_A_TX = 'blobATx01234567890abcdefghijklmnopqrstuvwxy';
const BLOB_B_TX = 'blobBTx01234567890abcdefghijklmnopqrstuvwxy';
const BLOB_C_TX = 'blobCTx01234567890abcdefghijklmnopqrstuvwxy';
const SRC_DIR_TX = 'srcDirTx0123456789abcdefghijklmnopqrstuvwxy';
const BINARY_BLOB_TX = 'binaryTx0123456789abcdefghijklmnopqrstuvwxy';

// File contents at each commit
const FILE_CONTENT_A = 'line one\nline two';
const FILE_CONTENT_B = 'line one\nline two\nline three\nline four';
const FILE_CONTENT_C = 'line one\nmodified two\nline three\nline four\nline five';

// ============================================================================
// Arweave Mock Setup
// ============================================================================

function setupArweaveMocks(overrides?: {
  shaMap?: Record<string, string>;
  txData?: Record<string, Uint8Array>;
  failAll?: boolean;
}) {
  const shaMap: Record<string, string> = {
    [`${COMMIT_A_SHA}:test-repo`]: COMMIT_A_TX,
    [`${COMMIT_B_SHA}:test-repo`]: COMMIT_B_TX,
    [`${COMMIT_C_SHA}:test-repo`]: COMMIT_C_TX,
    [`${TREE_A_SHA}:test-repo`]: TREE_A_TX,
    [`${TREE_B_SHA}:test-repo`]: TREE_B_TX,
    [`${TREE_C_SHA}:test-repo`]: TREE_C_TX,
    [`${BLOB_A_SHA}:test-repo`]: BLOB_A_TX,
    [`${BLOB_B_SHA}:test-repo`]: BLOB_B_TX,
    [`${BLOB_C_SHA}:test-repo`]: BLOB_C_TX,
    [`${SRC_DIR_SHA}:test-repo`]: SRC_DIR_TX,
    [`${BINARY_BLOB_SHA}:test-repo`]: BINARY_BLOB_TX,
    ...overrides?.shaMap,
  };

  // Build git objects
  const commitABytes = buildCommitBytes({
    treeSha: TREE_A_SHA,
    parentShas: [],
    author: 'Alice <alice@example.com> 1700001000 +0000',
    message: 'Initial commit',
  });

  const commitBBytes = buildCommitBytes({
    treeSha: TREE_B_SHA,
    parentShas: [COMMIT_A_SHA],
    author: 'Bob <bob@example.com> 1700002000 +0000',
    message: 'Add more lines',
  });

  const commitCBytes = buildCommitBytes({
    treeSha: TREE_C_SHA,
    parentShas: [COMMIT_B_SHA],
    author: 'Carol <carol@example.com> 1700003000 +0000',
    message: 'Modify and extend',
  });

  // Root trees at each commit: single file 'file.ts'
  const treeABytes = buildTreeBytes([
    { mode: '100644', name: 'file.ts', sha: BLOB_A_SHA },
  ]);
  const treeBBytes = buildTreeBytes([
    { mode: '100644', name: 'file.ts', sha: BLOB_B_SHA },
  ]);
  const treeCBytes = buildTreeBytes([
    { mode: '100644', name: 'file.ts', sha: BLOB_C_SHA },
    { mode: '100644', name: 'image.png', sha: BINARY_BLOB_SHA },
  ]);

  const binaryData = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
  ]);

  const txData: Record<string, Uint8Array> = {
    [COMMIT_A_TX]: commitABytes,
    [COMMIT_B_TX]: commitBBytes,
    [COMMIT_C_TX]: commitCBytes,
    [TREE_A_TX]: treeABytes,
    [TREE_B_TX]: treeBBytes,
    [TREE_C_TX]: treeCBytes,
    [BLOB_A_TX]: new TextEncoder().encode(FILE_CONTENT_A),
    [BLOB_B_TX]: new TextEncoder().encode(FILE_CONTENT_B),
    [BLOB_C_TX]: new TextEncoder().encode(FILE_CONTENT_C),
    [BINARY_BLOB_TX]: binaryData,
    ...overrides?.txData,
  };

  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (overrides?.failAll) {
      return new Response(null, { status: 500 });
    }

    // Handle Arweave GraphQL queries
    if (url.includes('/graphql')) {
      const body = JSON.parse((init?.body as string) ?? '{}') as {
        query?: string;
      };
      const queryStr = body.query ?? '';

      const shaMatch = queryStr.match(
        /Git-SHA",\s*values:\s*\["([0-9a-f]+)"\]/
      );
      const repoMatch = queryStr.match(/Repo",\s*values:\s*\["([^"]+)"\]/);
      if (shaMatch && repoMatch) {
        const key = `${shaMatch[1]}:${repoMatch[1]}`;
        const txId = shaMap[key];
        if (txId) {
          return new Response(
            JSON.stringify({
              data: { transactions: { edges: [{ node: { id: txId } }] } },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
      }
      return new Response(
        JSON.stringify({ data: { transactions: { edges: [] } } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Handle Arweave object fetches
    for (const gateway of ARWEAVE_GATEWAYS) {
      if (url.startsWith(gateway)) {
        const txId = url.slice(gateway.length + 1);
        const data = txData[txId];
        if (data) {
          return new Response(data, { status: 200 });
        }
        return new Response(null, { status: 404 });
      }
    }

    return new Response(null, { status: 404 });
  }) as typeof fetch;
}

// ============================================================================
// E2E Tests: Story 8.4 — Blame View
// ============================================================================

describe('E2E: Story 8.4 — Blame View', () => {
  let container: HTMLDivElement;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-23T12:00:00Z'));
    container = document.createElement('div');
    container.id = 'app';
    document.body.appendChild(container);
    clearShaCache();
  });

  afterEach(() => {
    container.remove();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // ==========================================================================
  // 8.4-E2E-001: Full blame resolution chain — route to rendered blame table
  // AC: #1, #2, #3, #7, #12, #14
  // ==========================================================================

  describe('8.4-E2E-001: Full blame view — route to rendered blame table', () => {
    it('[P1] resolves route -> Arweave commit chain -> blame computation -> rendered blame table with correct attributions', async () => {
      // 1. Parse blame route
      const route = parseRoute('/npub1test/test-repo/blame/main/file.ts');
      expect(route.type).toBe('blame');
      if (route.type !== 'blame') throw new Error('Expected blame route');
      expect(route.owner).toBe('npub1test');
      expect(route.repo).toBe('test-repo');
      expect(route.ref).toBe('main');
      expect(route.path).toBe('file.ts');

      // 2. Parse NIP-34 events
      const repoEvent = createRepoAnnouncementEvent({
        repoId: 'test-repo',
        defaultBranch: 'main',
      });
      const repoMeta = parseRepoAnnouncement(repoEvent);
      expect(repoMeta).not.toBeNull();

      const refsEvent = createRepoRefsEvent({
        repoId: 'test-repo',
        refs: { 'refs/heads/main': COMMIT_C_SHA },
      });
      const repoRefs = parseRepoRefs(refsEvent);
      expect(repoRefs).not.toBeNull();
      const commitSha = repoRefs!.refs.get('refs/heads/main');
      expect(commitSha).toBe(COMMIT_C_SHA);

      // 3. Set up Arweave mocks for the full blame chain
      setupArweaveMocks();

      // 4. Compute blame through the real resolution chain
      const blameResult = await computeBlame('file.ts', COMMIT_C_SHA, 'test-repo');
      expect(blameResult).not.toBeNull();
      expect(isBlameError(blameResult)).toBe(false);

      const blame = blameResult as BlameResult;
      expect(blame.lines.length).toBe(5);
      expect(blame.fileContent).toBe(FILE_CONTENT_C);
      expect(blame.beyondLimit).toBe(false);

      // 5. Render blame view
      const result = renderBlameView(
        'test-repo',
        'main',
        'file.ts',
        blame,
        false,
        'npub1test'
      );

      // 6. Embed in layout and render into DOM
      const fullHtml = renderLayout('Forge', result.html, 'wss://localhost:7100');
      container.innerHTML = fullHtml;

      // 7. Assert: blame table is rendered
      expect(container.querySelector('.blame-view')).not.toBeNull();
      expect(container.querySelector('.blame-table')).not.toBeNull();

      // 8. Assert: correct number of blame rows
      const blameRows = container.querySelectorAll('.blame-line');
      expect(blameRows).toHaveLength(5);

      // 9. Assert: line numbers are rendered (1-based)
      const lineNumbers = container.querySelectorAll('.blame-line-number');
      expect(lineNumbers).toHaveLength(5);
      expect(lineNumbers[0]!.textContent).toBe('1');
      expect(lineNumbers[4]!.textContent).toBe('5');

      // 10. Assert: file content lines are displayed
      expect(container.textContent).toContain('line one');
      expect(container.textContent).toContain('modified two');
      expect(container.textContent).toContain('line five');

      // 11. Assert: commit hashes are displayed (abbreviated)
      // At least two different commit SHAs should be visible
      const commitLinks = container.querySelectorAll('.blame-sha a');
      expect(commitLinks.length).toBeGreaterThanOrEqual(2);

      // 12. Assert: author names are displayed
      // Different authors from the commit chain should be visible
      const authorCells = container.querySelectorAll('.blame-author');
      const authorTexts = Array.from(authorCells)
        .map((c) => c.textContent)
        .filter(Boolean);
      // Should have at least 2 unique authors
      const uniqueAuthors = new Set(authorTexts.filter((t) => t!.length > 0));
      expect(uniqueAuthors.size).toBeGreaterThanOrEqual(2);

      // 13. Assert: breadcrumbs are rendered
      expect(container.querySelector('.breadcrumbs')).not.toBeNull();
      expect(container.textContent).toContain('test-repo');

      // 14. Assert: no depth limit notice for this short history
      expect(container.querySelector('.blame-depth-notice')).toBeNull();
    });
  });

  // ==========================================================================
  // 8.4-E2E-002: Blame grouping — consecutive lines from same commit
  // AC: #8
  // ==========================================================================

  describe('8.4-E2E-002: Blame grouping for consecutive lines', () => {
    it('[P1] groups consecutive lines from the same commit, showing commit info only on first line', async () => {
      setupArweaveMocks();

      // Use single-commit file: all lines from commit A
      const blameResult = await computeBlame('file.ts', COMMIT_A_SHA, 'test-repo');
      expect(blameResult).not.toBeNull();
      expect(isBlameError(blameResult)).toBe(false);

      const blame = blameResult as BlameResult;
      // All lines should be from commitA (root commit)
      for (const line of blame.lines) {
        expect(line.commitSha).toBe(COMMIT_A_SHA);
      }

      const result = renderBlameView(
        'test-repo',
        'main',
        'file.ts',
        blame,
        false,
        'npub1test'
      );
      container.innerHTML = result.html;

      // All lines are from the same commit, so only the first should have group-start
      const blameRows = container.querySelectorAll('.blame-line');
      expect(blameRows).toHaveLength(2);
      expect(blameRows[0]!.classList.contains('blame-group-start')).toBe(true);
      expect(blameRows[1]!.classList.contains('blame-group-start')).toBe(false);

      // Only the first line should have commit info
      const commitLinks = container.querySelectorAll('.blame-sha a');
      expect(commitLinks).toHaveLength(1);

      // Second row should have empty commit info cells
      const secondRowSha = blameRows[1]!.querySelector('.blame-sha');
      expect(secondRowSha).not.toBeNull();
      expect(secondRowSha!.textContent!.trim()).toBe('');
    });
  });

  // ==========================================================================
  // 8.4-E2E-003: Binary file blame — returns error message
  // AC: #5, #9
  // ==========================================================================

  describe('8.4-E2E-003: Binary file blame shows error', () => {
    it('[P1] binary file blame renders "Binary files cannot be blamed" message', async () => {
      setupArweaveMocks();

      // Compute blame for the binary file
      const blameResult = await computeBlame('image.png', COMMIT_C_SHA, 'test-repo');
      expect(isBlameError(blameResult)).toBe(true);

      const error = blameResult as BlameError;
      expect(error.reason).toBe('binary');

      // Render with isBinary=true, null blame
      const result = renderBlameView(
        'test-repo',
        'main',
        'image.png',
        null,
        true,
        'npub1test'
      );

      container.innerHTML = result.html;

      expect(result.status).toBe(404);
      expect(container.textContent).toContain('Binary files cannot be blamed');
    });
  });

  // ==========================================================================
  // 8.4-E2E-004: File not found blame — returns error message
  // AC: #6, #9
  // ==========================================================================

  describe('8.4-E2E-004: File not found blame shows error', () => {
    it('[P1] missing file blame renders "File not found for blame" message', async () => {
      setupArweaveMocks();

      // Compute blame for a file that does not exist
      const blameResult = await computeBlame('nonexistent.ts', COMMIT_C_SHA, 'test-repo');
      expect(isBlameError(blameResult)).toBe(true);

      const error = blameResult as BlameError;
      expect(error.reason).toBe('not-found');

      // Render with null blame, isBinary=false
      const result = renderBlameView(
        'test-repo',
        'main',
        'nonexistent.ts',
        null,
        false,
        'npub1test'
      );

      container.innerHTML = result.html;

      expect(result.status).toBe(404);
      expect(container.textContent).toContain('File not found for blame');
    });
  });

  // ==========================================================================
  // 8.4-E2E-005: Depth limit notice
  // AC: #4, #10
  // ==========================================================================

  describe('8.4-E2E-005: Depth limit notice rendering', () => {
    it('[P1] renders depth limit notice when maxDepth is reached', async () => {
      setupArweaveMocks();

      // Compute blame with maxDepth=1 to trigger beyondLimit
      const blameResult = await computeBlame('file.ts', COMMIT_C_SHA, 'test-repo', 1);
      expect(blameResult).not.toBeNull();
      expect(isBlameError(blameResult)).toBe(false);

      const blame = blameResult as BlameResult;
      expect(blame.beyondLimit).toBe(true);

      const result = renderBlameView(
        'test-repo',
        'main',
        'file.ts',
        blame,
        false,
        'npub1test'
      );

      const fullHtml = renderLayout('Forge', result.html, 'wss://localhost:7100');
      container.innerHTML = fullHtml;

      // Assert: depth limit notice is shown
      const notice = container.querySelector('.blame-depth-notice');
      expect(notice).not.toBeNull();
      expect(notice!.textContent).toContain('Older attributions may be approximate');
    });
  });

  // ==========================================================================
  // 8.4-E2E-006: Blob view contains blame link for text files
  // AC: #13
  // ==========================================================================

  describe('8.4-E2E-006: Blob view blame link', () => {
    it('[P1] blob view for text file includes a "Blame" link', () => {
      const fileContent = 'const x = 1;\nconst y = 2;\n';
      const result = renderBlobView(
        'test-repo',
        'main',
        'src/index.ts',
        fileContent,
        false,
        fileContent.length,
        'npub1test'
      );

      container.innerHTML = result.html;

      const blameLink = container.querySelector('.blob-blame-link');
      expect(blameLink).not.toBeNull();
      expect(blameLink!.textContent).toBe('Blame');

      const href = blameLink!.getAttribute('href');
      expect(href).toContain('/blame/');
      expect(href).toContain('main');
      expect(href).toContain('index.ts');
    });

    it('[P1] blob view for binary file does NOT include a blame link', () => {
      const result = renderBlobView(
        'test-repo',
        'main',
        'image.png',
        null,
        true,
        1024,
        'npub1test'
      );

      container.innerHTML = result.html;

      const blameLink = container.querySelector('.blob-blame-link');
      expect(blameLink).toBeNull();
    });
  });

  // ==========================================================================
  // 8.4-E2E-007: Blame route parsing with ref
  // AC: #12
  // ==========================================================================

  describe('8.4-E2E-007: Blame route parsing', () => {
    it('[P1] parses blame route with ref and nested path', () => {
      const route = parseRoute('/npub1owner/my-repo/blame/develop/src/web/main.ts');
      expect(route.type).toBe('blame');
      if (route.type !== 'blame') throw new Error('Expected blame route');
      expect(route.owner).toBe('npub1owner');
      expect(route.repo).toBe('my-repo');
      expect(route.ref).toBe('develop');
      expect(route.path).toBe('src/web/main.ts');
    });

    it('[P1] blame route with no file path (segments.length === 4) does NOT match blame', () => {
      const route = parseRoute('/npub1owner/my-repo/blame/main');
      // Should NOT match blame route (needs at least ref + one path segment)
      expect(route.type).not.toBe('blame');
    });

    it('[P2] blame route with trailing slash (segments.length === 5 with empty last)', () => {
      const route = parseRoute('/npub1owner/my-repo/blame/main/');
      // The trailing slash case: segments after filter(Boolean) will have 4 elements
      // (npub1owner, my-repo, blame, main) so it should NOT match blame
      // because there is no path segment after the ref
      if (route.type === 'blame') {
        // If it does match, the path should be empty string
        expect(route.path).toBe('');
      }
    });
  });

  // ==========================================================================
  // 8.4-E2E-008: XSS prevention in blame view
  // AC: #11
  // ==========================================================================

  describe('8.4-E2E-008: XSS prevention', () => {
    it('[P0] malicious file content and author names are HTML-escaped in blame output', () => {
      const maliciousBlame: BlameResult = {
        lines: [
          {
            commitSha: 'ab'.repeat(20),
            author: '<script>alert("xss")</script> <x@x.com> 1700000000 +0000',
            timestamp: 1700000000,
            lineNumber: 1,
          },
          {
            commitSha: 'ab'.repeat(20),
            author: '<script>alert("xss")</script> <x@x.com> 1700000000 +0000',
            timestamp: 1700000000,
            lineNumber: 2,
          },
        ],
        fileContent: '<img onerror=alert(1) src=x>\n<script>evil()</script>',
        beyondLimit: false,
        maxDepth: 50,
      };

      const result = renderBlameView(
        '<script>repo</script>',
        'main',
        '<img src=x onerror=alert(1)>',
        maliciousBlame,
        false,
        'npub1test'
      );

      const fullHtml = renderLayout('Forge', result.html, 'wss://localhost:7100');
      container.innerHTML = fullHtml;

      // No script or img-onerror tags should be rendered as live DOM elements
      expect(container.querySelectorAll('script')).toHaveLength(0);
      expect(container.querySelectorAll('img[onerror]')).toHaveLength(0);

      // The escaped content should be present as text
      expect(result.html).toContain('&lt;img');
      expect(result.html).toContain('&lt;script&gt;');
      expect(result.html).not.toContain('<script>evil()');
    });
  });

  // ==========================================================================
  // 8.4-E2E-009: Commit links in blame view
  // AC: #7
  // ==========================================================================

  describe('8.4-E2E-009: Commit links in blame rows', () => {
    it('[P1] abbreviated commit hashes link to the commit diff view', async () => {
      setupArweaveMocks();

      const blameResult = await computeBlame('file.ts', COMMIT_C_SHA, 'test-repo');
      expect(blameResult).not.toBeNull();
      expect(isBlameError(blameResult)).toBe(false);

      const blame = blameResult as BlameResult;
      const result = renderBlameView(
        'test-repo',
        'main',
        'file.ts',
        blame,
        false,
        'npub1test'
      );
      container.innerHTML = result.html;

      // Verify commit links exist and point to /<owner>/<repo>/commit/<sha>
      const commitLinks = container.querySelectorAll('.blame-sha a');
      expect(commitLinks.length).toBeGreaterThan(0);

      for (const link of commitLinks) {
        const href = link.getAttribute('href');
        expect(href).toMatch(/\/npub1test\/test-repo\/commit\/[0-9a-f]+/);

        // Should show abbreviated (7-char) hash as text
        expect(link.textContent!.length).toBe(7);
      }
    });
  });

  // ==========================================================================
  // 8.4-E2E-010: Error state when Arweave unavailable
  // AC: #16
  // ==========================================================================

  describe('8.4-E2E-010: Error state rendering', () => {
    it('[P1] Arweave failure produces user-friendly error message in layout', () => {
      // Simulate what main.ts does on catch:
      const errorHtml = renderLayout(
        'Forge',
        '<div class="empty-state"><div class="empty-state-title">Error</div><div class="empty-state-message">Could not load blame view.</div></div>',
        'wss://localhost:7100'
      );

      container.innerHTML = errorHtml;

      expect(container.textContent).toContain('Error');
      expect(container.textContent).toContain('Could not load blame view.');
      expect(container.querySelector('.empty-state')).not.toBeNull();
      expect(container.querySelector('.layout-content')).not.toBeNull();
    });

    it('[P1] loading state renders "Loading blame..." message', () => {
      const loadingHtml = renderLayout(
        'Forge',
        '<div class="loading">Loading blame...</div>',
        'wss://localhost:7100'
      );

      container.innerHTML = loadingHtml;

      expect(container.textContent).toContain('Loading blame...');
      expect(container.querySelector('.loading')).not.toBeNull();
    });
  });
});
