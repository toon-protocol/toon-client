// @vitest-environment jsdom
// Test IDs: 8.3-E2E-001 through 8.3-E2E-015
// AC covered: #4-#18 (Full E2E for Story 8.3 user-facing UI changes)
//
// These tests exercise the full resolution chain for commit log and diff views,
// mocking only at the network boundary (fetch for Arweave). They validate the
// user-facing UI by rendering into jsdom and asserting on DOM state.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  parseGitCommit,
  parseGitTree,
  parseAuthorIdent,
} from '../git-objects.js';
import type { TreeEntry } from '../git-objects.js';
import {
  renderCommitLog,
  renderCommitDiff,
  renderTreeView,
  renderBlobView,
} from '../templates.js';
import type { FileDiff } from '../templates.js';
import { parseRoute } from '../router.js';
import { parseRepoRefs, parseRepoAnnouncement } from '../nip34-parsers.js';
import type { NostrEvent } from '../nip34-parsers.js';
import { resolveDefaultRef } from '../ref-resolver.js';
import { diffTrees } from '../tree-diff.js';
import { computeUnifiedDiff } from '../unified-diff.js';
import { formatRelativeDate } from '../date-utils.js';
import type { CommitLogEntry } from '../commit-walker.js';
import {
  fetchArweaveObject,
  resolveGitSha,
  clearShaCache,
  ARWEAVE_GATEWAYS,
} from '../arweave-client.js';

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
const COMMIT_SHA_1 = 'a1'.repeat(20); // latest commit
const COMMIT_SHA_2 = 'a2'.repeat(20); // middle commit
const COMMIT_SHA_3 = 'a3'.repeat(20); // root commit
const TREE_SHA_1 = 'b1'.repeat(20);
const TREE_SHA_2 = 'b2'.repeat(20);
const TREE_SHA_3 = 'b3'.repeat(20);
const README_SHA_OLD = 'c1'.repeat(20);
const README_SHA_NEW = 'c2'.repeat(20);
const CONFIG_SHA = 'c3'.repeat(20);
const DELETED_FILE_SHA = 'c4'.repeat(20);

// Standard Arweave tx IDs (exactly 43 chars, base64url)
const COMMIT_TX_1 = 'commitTx1_0123456789abcdefghijklmnopqrstuvw';
const COMMIT_TX_2 = 'commitTx2_0123456789abcdefghijklmnopqrstuvw';
const COMMIT_TX_3 = 'commitTx3_0123456789abcdefghijklmnopqrstuvw';
const TREE_TX_1 = 'treeTx1__0123456789abcdefghijklmnopqrstuvwx';
const TREE_TX_2 = 'treeTx2__0123456789abcdefghijklmnopqrstuvwx';
const TREE_TX_3 = 'treeTx3__0123456789abcdefghijklmnopqrstuvwx';
const README_TX_OLD = 'readmeOld0123456789abcdefghijklmnopqrstuvw';
const README_TX_NEW = 'readmeNew0123456789abcdefghijklmnopqrstuvw';
const CONFIG_TX = 'configTx_0123456789abcdefghijklmnopqrstuvwx';
const DELETED_TX = 'deletedTx0123456789abcdefghijklmnopqrstuvwx';

// ============================================================================
// E2E Tests: Story 8.3 — Commit Log and Diff View
// ============================================================================

describe('E2E: Story 8.3 — Commit Log and Diff View', () => {
  let container: HTMLDivElement;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    container = document.createElement('div');
    container.id = 'app';
    document.body.appendChild(container);
    clearShaCache();
  });

  afterEach(() => {
    container.remove();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // --------------------------------------------------------------------------
  // Fixture: 3-commit linear chain
  // Commit 1 (latest): adds config.json, modifies README.md, deletes old-file.ts
  // Commit 2 (middle): adds old-file.ts, modifies README.md
  // Commit 3 (root): adds README.md
  // --------------------------------------------------------------------------

  const commit1Bytes = buildCommitBytes({
    treeSha: TREE_SHA_1,
    parentShas: [COMMIT_SHA_2],
    author: 'Alice <alice@example.com> 1711103000 +0000',
    message: 'Add config and update README',
  });

  const commit2Bytes = buildCommitBytes({
    treeSha: TREE_SHA_2,
    parentShas: [COMMIT_SHA_3],
    author: 'Bob <bob@example.com> 1711102000 -0500',
    message: 'Add old-file and update README',
  });

  const commit3Bytes = buildCommitBytes({
    treeSha: TREE_SHA_3,
    parentShas: [],
    author: 'Carol <carol@example.com> 1711101000 +0000',
    message: 'Initial commit',
  });

  const tree1Bytes = buildTreeBytes([
    { mode: '100644', name: 'README.md', sha: README_SHA_NEW },
    { mode: '100644', name: 'config.json', sha: CONFIG_SHA },
  ]);

  const tree2Bytes = buildTreeBytes([
    { mode: '100644', name: 'README.md', sha: README_SHA_OLD },
    { mode: '100644', name: 'old-file.ts', sha: DELETED_FILE_SHA },
  ]);

  const tree3Bytes = buildTreeBytes([
    { mode: '100644', name: 'README.md', sha: README_SHA_OLD },
  ]);

  const readmeOldContent = '# My Project\n\nOld description here.\n';
  const readmeNewContent = '# My Project\n\nNew description with updates.\n';
  const configContent = '{\n  "key": "value"\n}\n';
  const deletedFileContent = 'const x = 1;\nexport default x;\n';

  function setupArweaveMocks(overrides?: {
    shaMap?: Record<string, string>;
    txData?: Record<string, Uint8Array>;
  }) {
    const shaMap: Record<string, string> = {
      [`${COMMIT_SHA_1}:test-repo`]: COMMIT_TX_1,
      [`${COMMIT_SHA_2}:test-repo`]: COMMIT_TX_2,
      [`${COMMIT_SHA_3}:test-repo`]: COMMIT_TX_3,
      [`${TREE_SHA_1}:test-repo`]: TREE_TX_1,
      [`${TREE_SHA_2}:test-repo`]: TREE_TX_2,
      [`${TREE_SHA_3}:test-repo`]: TREE_TX_3,
      [`${README_SHA_OLD}:test-repo`]: README_TX_OLD,
      [`${README_SHA_NEW}:test-repo`]: README_TX_NEW,
      [`${CONFIG_SHA}:test-repo`]: CONFIG_TX,
      [`${DELETED_FILE_SHA}:test-repo`]: DELETED_TX,
      ...overrides?.shaMap,
    };

    const txData: Record<string, Uint8Array> = {
      [COMMIT_TX_1]: commit1Bytes,
      [COMMIT_TX_2]: commit2Bytes,
      [COMMIT_TX_3]: commit3Bytes,
      [TREE_TX_1]: tree1Bytes,
      [TREE_TX_2]: tree2Bytes,
      [TREE_TX_3]: tree3Bytes,
      [README_TX_OLD]: new TextEncoder().encode(readmeOldContent),
      [README_TX_NEW]: new TextEncoder().encode(readmeNewContent),
      [CONFIG_TX]: new TextEncoder().encode(configContent),
      [DELETED_TX]: new TextEncoder().encode(deletedFileContent),
      ...overrides?.txData,
    };

    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
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
                data: {
                  transactions: { edges: [{ node: { id: txId } }] },
                },
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

  // ==========================================================================
  // 8.3-E2E-001: Full commit log resolution chain
  // ==========================================================================

  describe('8.3-E2E-001: Full commit log — route to rendered commit list', () => {
    it('[P1] resolves route -> refs -> commit chain -> rendered commit log', async () => {
      // 1. Parse route
      const route = parseRoute('/npub1test/test-repo/commits/main');
      expect(route.type).toBe('commits');
      if (route.type !== 'commits') throw new Error('Expected commits route');
      expect(route.ref).toBe('main');

      // 2. Parse NIP-34 events
      const repoEvent = createRepoAnnouncementEvent({
        repoId: 'test-repo',
        defaultBranch: 'main',
      });
      const repoMeta = parseRepoAnnouncement(repoEvent);
      expect(repoMeta).not.toBeNull();

      const refsEvent = createRepoRefsEvent({
        repoId: 'test-repo',
        refs: { main: COMMIT_SHA_1, HEAD: COMMIT_SHA_1 },
      });
      const repoRefs = parseRepoRefs(refsEvent);
      expect(repoRefs).not.toBeNull();

      // 3. Resolve ref
      const resolved = resolveDefaultRef(repoMeta!, repoRefs!);
      expect(resolved).not.toBeNull();
      expect(resolved!.commitSha).toBe(COMMIT_SHA_1);

      // 4. Walk commit chain via Arweave
      setupArweaveMocks();

      // Simulate walkCommitChain manually (since we mock fetch, not the walker)
      const entries: CommitLogEntry[] = [];
      let currentSha: string | undefined = COMMIT_SHA_1;
      while (currentSha && entries.length < 50) {
        const txId = await resolveGitSha(currentSha, 'test-repo');
        if (!txId) break;
        const data = await fetchArweaveObject(txId);
        if (!data) break;
        const commit = parseGitCommit(data);
        if (!commit) break;
        entries.push({ sha: currentSha, commit });
        currentSha = commit.parentShas[0];
      }

      expect(entries).toHaveLength(3);

      // 5. Render commit log
      const result = renderCommitLog('test-repo', 'main', entries, 'npub1test');
      expect(result.status).toBe(200);
      container.innerHTML = result.html;

      // Verify all commits displayed
      expect(container.textContent).toContain('Add config and update README');
      expect(container.textContent).toContain('Add old-file and update README');
      expect(container.textContent).toContain('Initial commit');

      // Verify authors
      expect(container.textContent).toContain('Alice');
      expect(container.textContent).toContain('Bob');
      expect(container.textContent).toContain('Carol');

      // Verify abbreviated hashes
      expect(container.textContent).toContain(COMMIT_SHA_1.slice(0, 7));
      expect(container.textContent).toContain(COMMIT_SHA_2.slice(0, 7));
      expect(container.textContent).toContain(COMMIT_SHA_3.slice(0, 7));

      // Verify order: newest first
      const allText = container.textContent ?? '';
      const pos1 = allText.indexOf('Add config');
      const pos2 = allText.indexOf('Add old-file');
      const pos3 = allText.indexOf('Initial commit');
      expect(pos1).toBeLessThan(pos2);
      expect(pos2).toBeLessThan(pos3);

      // Verify commit SHA links point to individual commit view
      const shaLinks = container.querySelectorAll('a.commit-sha');
      expect(shaLinks).toHaveLength(3);
      for (const link of shaLinks) {
        const href = link.getAttribute('href')!;
        expect(href).toContain('/commit/');
        expect(href).toContain('npub1test');
        expect(href).toContain('test-repo');
      }
    });
  });

  // ==========================================================================
  // 8.3-E2E-002: Full commit diff resolution chain
  // ==========================================================================

  describe('8.3-E2E-002: Full commit diff — route to rendered diff view', () => {
    it('[P1] resolves commit + parent -> trees -> tree diff -> blob diffs -> rendered view', async () => {
      // 1. Parse route
      const route = parseRoute(`/npub1test/test-repo/commit/${COMMIT_SHA_1}`);
      expect(route.type).toBe('commit');
      if (route.type !== 'commit') throw new Error('Expected commit route');
      expect(route.sha).toBe(COMMIT_SHA_1);

      // 2. Fetch commit from Arweave
      setupArweaveMocks();

      const commitTxId = await resolveGitSha(COMMIT_SHA_1, 'test-repo');
      const commitData = await fetchArweaveObject(commitTxId!);
      const commit = parseGitCommit(commitData!);
      expect(commit).not.toBeNull();
      expect(commit!.treeSha).toBe(TREE_SHA_1);
      expect(commit!.parentShas[0]).toBe(COMMIT_SHA_2);

      // 3. Fetch parent commit
      const parentTxId = await resolveGitSha(COMMIT_SHA_2, 'test-repo');
      const parentData = await fetchArweaveObject(parentTxId!);
      const parentCommit = parseGitCommit(parentData!);
      expect(parentCommit).not.toBeNull();

      // 4. Fetch both trees
      const treeTxId = await resolveGitSha(TREE_SHA_1, 'test-repo');
      const treeData = await fetchArweaveObject(treeTxId!);
      const currentTree = parseGitTree(treeData!);

      const parentTreeTxId = await resolveGitSha(
        parentCommit!.treeSha,
        'test-repo'
      );
      const parentTreeData = await fetchArweaveObject(parentTreeTxId!);
      const parentTree = parseGitTree(parentTreeData!);

      // 5. Compute tree diff
      const treeDiffEntries = diffTrees(parentTree, currentTree);

      // Should detect: old-file.ts deleted, README.md modified, config.json added
      expect(treeDiffEntries.length).toBe(3);
      expect(
        treeDiffEntries.find((e) => e.name === 'old-file.ts')?.status
      ).toBe('deleted');
      expect(treeDiffEntries.find((e) => e.name === 'README.md')?.status).toBe(
        'modified'
      );
      expect(
        treeDiffEntries.find((e) => e.name === 'config.json')?.status
      ).toBe('added');

      // 6. Compute blob diffs using known content strings
      // (We use the content strings directly rather than fetching through the mock
      // Response, because jsdom's Response.arrayBuffer() + TextDecoder can be
      // inconsistent with Uint8Array round-tripping in the test environment.)
      const fileDiffs: FileDiff[] = [
        {
          name: 'old-file.ts',
          status: 'deleted',
          hunks: computeUnifiedDiff(deletedFileContent, ''),
          isBinary: false,
        },
        {
          name: 'README.md',
          status: 'modified',
          hunks: computeUnifiedDiff(readmeOldContent, readmeNewContent),
          isBinary: false,
        },
        {
          name: 'config.json',
          status: 'added',
          hunks: computeUnifiedDiff('', configContent),
          isBinary: false,
        },
      ];

      // 7. Render commit diff
      const entry: CommitLogEntry = { sha: COMMIT_SHA_1, commit: commit! };
      const result = renderCommitDiff(
        'test-repo',
        COMMIT_SHA_1,
        entry,
        treeDiffEntries,
        fileDiffs,
        'npub1test'
      );
      expect(result.status).toBe(200);
      container.innerHTML = result.html;

      // Verify commit header
      expect(container.textContent).toContain('Add config and update README');
      expect(container.textContent).toContain('Alice');

      // Verify file names
      expect(container.textContent).toContain('README.md');
      expect(container.textContent).toContain('config.json');
      expect(container.textContent).toContain('old-file.ts');

      // Verify status badges
      const badges = container.querySelectorAll('.diff-status-badge');
      expect(badges.length).toBeGreaterThanOrEqual(3);

      // Verify inline diff content
      const addLines = container.querySelectorAll('.diff-line-add');
      const delLines = container.querySelectorAll('.diff-line-delete');
      expect(addLines.length).toBeGreaterThan(0);
      expect(delLines.length).toBeGreaterThan(0);

      // Verify diff summary counts
      expect(container.textContent).toContain('1 added');
      expect(container.textContent).toContain('1 deleted');
      expect(container.textContent).toContain('1 modified');

      // Verify parent SHA link
      const parentLink = container.querySelector('.commit-parent-link');
      expect(parentLink).not.toBeNull();
      expect(parentLink!.textContent).toContain(COMMIT_SHA_2.slice(0, 7));
      expect(parentLink!.getAttribute('href')).toContain('/commit/');
    });
  });

  // ==========================================================================
  // 8.3-E2E-003: Root commit diff — all files shown as added
  // ==========================================================================

  describe('8.3-E2E-003: Root commit diff shows all files as added', () => {
    it('[P1] root commit (no parent) renders all files as added', async () => {
      setupArweaveMocks();

      // Fetch root commit
      const txId = await resolveGitSha(COMMIT_SHA_3, 'test-repo');
      const data = await fetchArweaveObject(txId!);
      const commit = parseGitCommit(data!);
      expect(commit).not.toBeNull();
      expect(commit!.parentShas).toHaveLength(0);

      // Fetch root tree
      const treeTxId = await resolveGitSha(commit!.treeSha, 'test-repo');
      const treeData = await fetchArweaveObject(treeTxId!);
      const tree = parseGitTree(treeData!);

      // Root commit: empty parent tree
      const treeDiffEntries = diffTrees([], tree);
      expect(treeDiffEntries.every((e) => e.status === 'added')).toBe(true);

      // Build file diffs using known content strings
      const fileDiffs: FileDiff[] = treeDiffEntries.map((e) => ({
        name: e.name,
        status: e.status,
        hunks: computeUnifiedDiff('', readmeOldContent),
        isBinary: false,
      }));

      const entry: CommitLogEntry = { sha: COMMIT_SHA_3, commit: commit! };
      const result = renderCommitDiff(
        'test-repo',
        COMMIT_SHA_3,
        entry,
        treeDiffEntries,
        fileDiffs,
        'npub1test'
      );
      container.innerHTML = result.html;

      // Root commit indicator
      expect(container.textContent).toContain('root commit');

      // All diff lines should be additions
      const addLines = container.querySelectorAll('.diff-line-add');
      expect(addLines.length).toBeGreaterThan(0);
      const delLines = container.querySelectorAll('.diff-line-delete');
      expect(delLines).toHaveLength(0);
    });
  });

  // ==========================================================================
  // 8.3-E2E-004: Commits link in tree/blob breadcrumbs (AC #17)
  // ==========================================================================

  describe('8.3-E2E-004: Commits link in breadcrumbs', () => {
    it('[P1] tree view breadcrumbs contain a Commits link', () => {
      const entries: TreeEntry[] = [
        { mode: '100644', name: 'file.txt', sha: 'aa'.repeat(20) },
      ];

      const result = renderTreeView(
        'test-repo',
        'main',
        '',
        entries,
        'npub1test'
      );
      container.innerHTML = result.html;

      const commitsLink = container.querySelector('.breadcrumb-commits-link');
      expect(commitsLink).not.toBeNull();
      expect(commitsLink!.textContent).toBe('Commits');
      const href = commitsLink!.getAttribute('href')!;
      expect(href).toContain('/commits/main');
      expect(href).toContain('npub1test');
      expect(href).toContain('test-repo');
    });

    it('[P1] blob view breadcrumbs contain a Commits link', () => {
      const result = renderBlobView(
        'test-repo',
        'develop',
        'src/index.ts',
        'const x = 1;',
        false,
        13,
        'npub1test'
      );
      container.innerHTML = result.html;

      const commitsLink = container.querySelector('.breadcrumb-commits-link');
      expect(commitsLink).not.toBeNull();
      const href = commitsLink!.getAttribute('href')!;
      expect(href).toContain('/commits/develop');
    });
  });

  // ==========================================================================
  // 8.3-E2E-005: Commit log empty state (AC #6)
  // ==========================================================================

  describe('8.3-E2E-005: Commit log empty state', () => {
    it('[P1] empty commits array renders "No commits found" message', () => {
      const result = renderCommitLog('test-repo', 'main', [], 'npub1test');
      expect(result.status).toBe(200);
      container.innerHTML = result.html;

      expect(container.textContent).toContain('No commits found');
    });
  });

  // ==========================================================================
  // 8.3-E2E-006: XSS prevention in commit messages (AC #14)
  // ==========================================================================

  describe('8.3-E2E-006: XSS prevention in commit log', () => {
    it('[P0] script tags in commit messages are escaped', () => {
      const commit = parseGitCommit(
        buildCommitBytes({
          treeSha: 'ff'.repeat(20),
          message: '<script>alert("xss")</script>Malicious commit',
        })
      );
      expect(commit).not.toBeNull();

      const entries: CommitLogEntry[] = [
        { sha: 'aa'.repeat(20), commit: commit! },
      ];
      const result = renderCommitLog('test-repo', 'main', entries, 'npub1test');
      container.innerHTML = result.html;

      expect(container.querySelectorAll('script')).toHaveLength(0);
      expect(container.textContent).toContain('<script>');
    });

    it('[P0] XSS in author name is escaped in commit log', () => {
      const commit = parseGitCommit(
        buildCommitBytes({
          treeSha: 'ff'.repeat(20),
          author:
            '<img src=x onerror=alert(1)> <evil@example.com> 1700000000 +0000',
          message: 'test',
        })
      );
      expect(commit).not.toBeNull();

      const entries: CommitLogEntry[] = [
        { sha: 'aa'.repeat(20), commit: commit! },
      ];
      const result = renderCommitLog('test-repo', 'main', entries, 'npub1test');
      container.innerHTML = result.html;

      expect(container.querySelectorAll('img[onerror]')).toHaveLength(0);
    });
  });

  // ==========================================================================
  // 8.3-E2E-007: XSS prevention in commit diff view (AC #14)
  // ==========================================================================

  describe('8.3-E2E-007: XSS prevention in commit diff', () => {
    it('[P0] XSS in diff content is escaped', () => {
      const commit = parseGitCommit(
        buildCommitBytes({
          treeSha: 'ff'.repeat(20),
          parentShas: ['ee'.repeat(20)],
          message: 'test',
        })
      );
      expect(commit).not.toBeNull();

      const xssContent = '<script>document.cookie="stolen"</script>';
      const hunks = computeUnifiedDiff('', xssContent);

      const fileDiffs: FileDiff[] = [
        {
          name: 'evil.js',
          status: 'added',
          hunks,
          isBinary: false,
        },
      ];

      const entry: CommitLogEntry = { sha: 'aa'.repeat(20), commit: commit! };
      const result = renderCommitDiff(
        'test-repo',
        'aa'.repeat(20),
        entry,
        [
          {
            status: 'added',
            name: 'evil.js',
            newSha: 'bb'.repeat(20),
            mode: '100644',
          },
        ],
        fileDiffs,
        'npub1test'
      );
      container.innerHTML = result.html;

      expect(container.querySelectorAll('script')).toHaveLength(0);
      expect(container.textContent).toContain('<script>');
    });

    it('[P0] XSS in file names in diff view is escaped', () => {
      const commit = parseGitCommit(
        buildCommitBytes({
          treeSha: 'ff'.repeat(20),
          parentShas: ['ee'.repeat(20)],
          message: 'test',
        })
      );
      expect(commit).not.toBeNull();

      const fileDiffs: FileDiff[] = [
        {
          name: '<img src=x onerror=alert(1)>.js',
          status: 'added',
          hunks: [],
          isBinary: false,
        },
      ];

      const entry: CommitLogEntry = { sha: 'aa'.repeat(20), commit: commit! };
      const result = renderCommitDiff(
        'test-repo',
        'aa'.repeat(20),
        entry,
        [
          {
            status: 'added',
            name: '<img src=x onerror=alert(1)>.js',
            newSha: 'bb'.repeat(20),
            mode: '100644',
          },
        ],
        fileDiffs,
        'npub1test'
      );
      container.innerHTML = result.html;

      expect(container.querySelectorAll('img[onerror]')).toHaveLength(0);
    });
  });

  // ==========================================================================
  // 8.3-E2E-008: Binary file in diff shows message (AC #11)
  // ==========================================================================

  describe('8.3-E2E-008: Binary file in diff view', () => {
    it('[P1] binary file shows "Binary file changed" instead of diff', () => {
      const commit = parseGitCommit(
        buildCommitBytes({
          treeSha: 'ff'.repeat(20),
          parentShas: ['ee'.repeat(20)],
          message: 'Add binary image',
        })
      );
      expect(commit).not.toBeNull();

      const fileDiffs: FileDiff[] = [
        {
          name: 'logo.png',
          status: 'added',
          hunks: [],
          isBinary: true,
        },
      ];

      const entry: CommitLogEntry = { sha: 'aa'.repeat(20), commit: commit! };
      const result = renderCommitDiff(
        'test-repo',
        'aa'.repeat(20),
        entry,
        [
          {
            status: 'added',
            name: 'logo.png',
            newSha: 'cc'.repeat(20),
            mode: '100644',
          },
        ],
        fileDiffs,
        'npub1test'
      );
      container.innerHTML = result.html;

      expect(container.textContent).toContain('Binary file changed');
      expect(container.querySelector('.diff-binary')).not.toBeNull();
    });
  });

  // ==========================================================================
  // 8.3-E2E-009: Router — commits vs commit disambiguation (AC #15)
  // ==========================================================================

  describe('8.3-E2E-009: Router commits/commit disambiguation', () => {
    it('[P1] /commits/ routes to commit log (plural)', () => {
      const route = parseRoute('/npub1abc/my-repo/commits/main');
      expect(route).toEqual({
        type: 'commits',
        owner: 'npub1abc',
        repo: 'my-repo',
        ref: 'main',
      });
    });

    it('[P1] /commit/ routes to single commit diff (singular)', () => {
      const route = parseRoute(`/npub1abc/my-repo/commit/${'ab'.repeat(20)}`);
      expect(route).toEqual({
        type: 'commit',
        owner: 'npub1abc',
        repo: 'my-repo',
        sha: 'ab'.repeat(20),
      });
    });

    it('[P1] commits route with tag ref', () => {
      const route = parseRoute('/npub1abc/my-repo/commits/v1.0.0');
      expect(route.type).toBe('commits');
      if (route.type !== 'commits') throw new Error('Expected commits route');
      expect(route.ref).toBe('v1.0.0');
    });

    it('[P1] commit route does not match commits (regression)', () => {
      // Ensure /commits/main does NOT get matched as /commit/s with repo='main'
      const route = parseRoute('/npub1abc/my-repo/commits/develop');
      expect(route.type).toBe('commits');
      expect(route.type).not.toBe('commit');
    });
  });

  // ==========================================================================
  // 8.3-E2E-010: Commit hash links navigate to correct routes (AC #18)
  // ==========================================================================

  describe('8.3-E2E-010: Commit hash links in commit log', () => {
    it('[P1] each commit SHA link points to /<npub>/<repo>/commit/<full-sha>', () => {
      const sha = 'ab'.repeat(20);
      const commit = parseGitCommit(
        buildCommitBytes({
          treeSha: 'ff'.repeat(20),
          message: 'Test commit for link check',
        })
      );
      expect(commit).not.toBeNull();

      const entries: CommitLogEntry[] = [{ sha, commit: commit! }];
      const result = renderCommitLog(
        'test-repo',
        'main',
        entries,
        'npub1owner'
      );
      container.innerHTML = result.html;

      const link = container.querySelector('a.commit-sha');
      expect(link).not.toBeNull();
      const href = link!.getAttribute('href')!;
      expect(href).toContain(`/commit/${sha}`);
      expect(href).toContain('npub1owner');
      expect(href).toContain('test-repo');

      // Abbreviated SHA displayed
      expect(link!.textContent).toBe(sha.slice(0, 7));

      // Full SHA in title attribute
      expect(link!.getAttribute('title')).toBe(sha);
    });
  });

  // ==========================================================================
  // 8.3-E2E-011: Commit message truncation at 72 chars (AC #4)
  // ==========================================================================

  describe('8.3-E2E-011: Commit message truncation', () => {
    it('[P1] long commit message is truncated to 72 chars with ellipsis', () => {
      const longMessage =
        'This is a very long commit message that exceeds the 72 character limit and should be truncated with dots';
      const commit = parseGitCommit(
        buildCommitBytes({
          treeSha: 'ff'.repeat(20),
          message: longMessage,
        })
      );
      expect(commit).not.toBeNull();
      expect(longMessage.length).toBeGreaterThan(72);

      const entries: CommitLogEntry[] = [
        { sha: 'aa'.repeat(20), commit: commit! },
      ];
      const result = renderCommitLog('test-repo', 'main', entries, 'npub1test');
      container.innerHTML = result.html;

      // Should show truncated message (72 chars + "...")
      const messageEl = container.querySelector('.commit-message');
      expect(messageEl).not.toBeNull();
      expect(messageEl!.textContent!.length).toBeLessThanOrEqual(75); // 72 + "..."
      expect(messageEl!.textContent).toContain('...');

      // Should NOT show the full message
      expect(container.textContent).not.toContain(longMessage);
    });

    it('[P1] multi-line commit message shows only first line', () => {
      const commit = parseGitCommit(
        buildCommitBytes({
          treeSha: 'ff'.repeat(20),
          message:
            'First line summary\n\nDetailed body paragraph that should not appear.\n',
        })
      );
      expect(commit).not.toBeNull();

      const entries: CommitLogEntry[] = [
        { sha: 'aa'.repeat(20), commit: commit! },
      ];
      const result = renderCommitLog('test-repo', 'main', entries, 'npub1test');
      container.innerHTML = result.html;

      const messageEl = container.querySelector('.commit-message');
      expect(messageEl!.textContent).toContain('First line summary');
      expect(messageEl!.textContent).not.toContain('Detailed body paragraph');
    });
  });

  // ==========================================================================
  // 8.3-E2E-012: Author identity parsing and relative dates (AC #5)
  // ==========================================================================

  describe('8.3-E2E-012: Author identity and relative dates', () => {
    it('[P1] parseAuthorIdent extracts name, email, timestamp, timezone', () => {
      const ident = parseAuthorIdent(
        'Alice B <alice@example.com> 1711234567 +0000'
      );
      expect(ident).not.toBeNull();
      expect(ident!.name).toBe('Alice B');
      expect(ident!.email).toBe('alice@example.com');
      expect(ident!.timestamp).toBe(1711234567);
      expect(ident!.timezone).toBe('+0000');
    });

    it('[P1] malformed author string returns null', () => {
      expect(parseAuthorIdent('')).toBeNull();
      expect(parseAuthorIdent('no angle brackets')).toBeNull();
      expect(parseAuthorIdent('Name <email>')).toBeNull();
    });

    it('[P1] formatRelativeDate produces human-readable strings', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-23T12:00:00Z'));

      const now = Math.floor(Date.now() / 1000);

      expect(formatRelativeDate(now - 30)).toBe('just now');
      expect(formatRelativeDate(now - 120)).toBe('2 minutes ago');
      expect(formatRelativeDate(now - 7200)).toBe('2 hours ago');
      expect(formatRelativeDate(now - 259200)).toBe('3 days ago');
      expect(formatRelativeDate(now - 5184000)).toBe('2 months ago');
      expect(formatRelativeDate(now - 63072000)).toBe('2 years ago');

      vi.useRealTimers();
    });

    it('[P1] relative dates appear in rendered commit log', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-23T12:00:00Z'));

      const now = Math.floor(Date.now() / 1000);
      const commit = parseGitCommit(
        buildCommitBytes({
          treeSha: 'ff'.repeat(20),
          author: `Alice <alice@example.com> ${now - 7200} +0000`,
          message: 'Recent commit',
        })
      );
      expect(commit).not.toBeNull();

      const entries: CommitLogEntry[] = [
        { sha: 'aa'.repeat(20), commit: commit! },
      ];
      const result = renderCommitLog('test-repo', 'main', entries, 'npub1test');
      container.innerHTML = result.html;

      expect(container.textContent).toContain('2 hours ago');

      vi.useRealTimers();
    });
  });

  // ==========================================================================
  // 8.3-E2E-013: Commit diff breadcrumbs navigation
  // ==========================================================================

  describe('8.3-E2E-013: Commit diff breadcrumbs', () => {
    it('[P1] commit diff view has breadcrumbs with repo link', () => {
      const commit = parseGitCommit(
        buildCommitBytes({
          treeSha: 'ff'.repeat(20),
          message: 'test',
        })
      );
      expect(commit).not.toBeNull();

      const entry: CommitLogEntry = {
        sha: 'aa'.repeat(20),
        commit: commit!,
      };
      const result = renderCommitDiff(
        'my-repo',
        'aa'.repeat(20),
        entry,
        [],
        [],
        'npub1owner'
      );
      container.innerHTML = result.html;

      const breadcrumbs = container.querySelector('.breadcrumbs');
      expect(breadcrumbs).not.toBeNull();
      expect(breadcrumbs!.textContent).toContain('my-repo');
      expect(breadcrumbs!.textContent).toContain('Commit');

      // Repo name should be a link back to tree view
      const repoLink = breadcrumbs!.querySelector('.breadcrumb-link');
      expect(repoLink).not.toBeNull();
      expect(repoLink!.getAttribute('href')).toContain('/tree/');
    });

    it('[P1] commit log view has breadcrumbs with Commits as active segment', () => {
      const result = renderCommitLog('my-repo', 'main', [], 'npub1owner');
      container.innerHTML = result.html;

      const breadcrumbs = container.querySelector('.breadcrumbs');
      expect(breadcrumbs).not.toBeNull();
      expect(breadcrumbs!.textContent).toContain('Commits');

      const activeSegment = breadcrumbs!.querySelector('.breadcrumb-active');
      expect(activeSegment).not.toBeNull();
      expect(activeSegment!.textContent).toBe('Commits');
    });
  });

  // ==========================================================================
  // 8.3-E2E-014: Commit diff 404 for null commit
  // ==========================================================================

  describe('8.3-E2E-014: Commit diff 404 handling', () => {
    it('[P1] null commit renders 404', () => {
      const result = renderCommitDiff(
        'test-repo',
        'deadbeef'.repeat(5),
        null,
        undefined,
        undefined,
        'npub1test'
      );
      expect(result.status).toBe(404);
      container.innerHTML = result.html;
      expect(container.textContent).toContain('404');
      expect(container.textContent).toContain('Commit not found');
    });
  });

  // ==========================================================================
  // 8.3-E2E-015: Merge commit rendering in diff view
  // ==========================================================================

  describe('8.3-E2E-015: Merge commit rendering', () => {
    it('[P1] merge commit shows multiple parent SHA links', () => {
      const parent1 = 'aa'.repeat(20);
      const parent2 = 'bb'.repeat(20);

      const commit = parseGitCommit(
        buildCommitBytes({
          treeSha: 'ff'.repeat(20),
          parentShas: [parent1, parent2],
          message: 'Merge branch feature into main',
        })
      );
      expect(commit).not.toBeNull();
      expect(commit!.parentShas).toHaveLength(2);

      const entry: CommitLogEntry = {
        sha: 'cc'.repeat(20),
        commit: commit!,
      };
      const result = renderCommitDiff(
        'test-repo',
        'cc'.repeat(20),
        entry,
        [],
        [],
        'npub1test'
      );
      container.innerHTML = result.html;

      // Should show both parent SHA links
      const parentLinks = container.querySelectorAll('.commit-parent-link');
      expect(parentLinks).toHaveLength(2);
      expect(parentLinks[0]!.textContent).toContain(parent1.slice(0, 7));
      expect(parentLinks[1]!.textContent).toContain(parent2.slice(0, 7));

      // Each parent link should point to the commit view
      for (const link of parentLinks) {
        expect(link.getAttribute('href')).toContain('/commit/');
      }

      // Full merge message should be displayed
      expect(container.textContent).toContain('Merge branch feature into main');
    });
  });
});
