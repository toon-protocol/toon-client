// @vitest-environment jsdom
// Test IDs: 8.2-E2E-001 through 8.2-E2E-012
// AC covered: #1-#17 (Full E2E for Story 8.2 user-facing UI changes)
//
// These tests exercise the full resolution chain from route to rendered content,
// mocking only at the network boundary (fetch for Arweave, WebSocket for relay).
// They validate the user-facing UI by rendering into jsdom and asserting on DOM state.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { parseGitTree, parseGitCommit, isBinaryBlob } from '../git-objects.js';
import type { TreeEntry } from '../git-objects.js';
import { renderTreeView, renderBlobView } from '../templates.js';
import { parseRoute } from '../router.js';
import { parseRepoRefs, parseRepoAnnouncement } from '../nip34-parsers.js';
import type { NostrEvent, RepoMetadata, RepoRefs } from '../nip34-parsers.js';
import { resolveDefaultRef } from '../ref-resolver.js';
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
    // mode as ASCII
    for (const ch of entry.mode) allBytes.push(ch.charCodeAt(0));
    allBytes.push(0x20); // space
    // name as UTF-8
    const nameBytes = new TextEncoder().encode(entry.name);
    for (const b of nameBytes) allBytes.push(b);
    allBytes.push(0x00); // null terminator
    // SHA as 20 raw bytes
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
  lines.push(`author ${opts.author ?? 'Test User <test@example.com> 1711100000 +0000'}`);
  lines.push(`committer ${opts.committer ?? 'Test User <test@example.com> 1711100000 +0000'}`);
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
const COMMIT_SHA = 'aa'.repeat(20);
const ROOT_TREE_SHA = 'bb'.repeat(20);
const SRC_DIR_SHA = 'cc'.repeat(20);
const README_SHA = 'dd'.repeat(20);
const INDEX_SHA = 'ee'.repeat(20);
const UTILS_SHA = '11'.repeat(20);
const BINARY_SHA = '22'.repeat(20);
const SYMLINK_SHA = '33'.repeat(20);
const SUBMODULE_SHA = '44'.repeat(20);

// Standard Arweave tx IDs (exactly 43 chars, base64url)
const COMMIT_TX = 'commitTx0123456789abcdefghijklmnopqrstuvwxy';
const ROOT_TREE_TX = 'rootTreeTx0123456789abcdefghijklmnopqrstuvw';
const SRC_DIR_TX = 'srcDirTx0123456789abcdefghijklmnopqrstuvwxy';
const README_TX = 'readmeTx0123456789abcdefghijklmnopqrstuvwxy';
const INDEX_TX = 'indexTx0123456789abcdefghijklmnopqrstuvwxyz';
const UTILS_TX = 'utilsTx0123456789abcdefghijklmnopqrstuvwxyz';
const BINARY_TX = 'binaryTx0123456789abcdefghijklmnopqrstuvwxy';

// ============================================================================
// E2E Tests: Full Resolution Chain
// ============================================================================

describe('E2E: Story 8.2 — File Tree and Blob View', () => {
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
  // Fixture: standard repo tree layout
  // root/
  //   src/           (directory)
  //     index.ts     (file)
  //     utils.ts     (file)
  //   README.md      (file)
  //   image.png      (binary)
  //   link -> target (symlink)
  //   ext-module     (submodule)
  // --------------------------------------------------------------------------

  const rootTreeEntries = [
    { mode: '40000', name: 'src', sha: SRC_DIR_SHA },
    { mode: '100644', name: 'README.md', sha: README_SHA },
    { mode: '100644', name: 'image.png', sha: BINARY_SHA },
    { mode: '120000', name: 'link', sha: SYMLINK_SHA },
    { mode: '160000', name: 'ext-module', sha: SUBMODULE_SHA },
  ];

  const srcTreeEntries = [
    { mode: '100644', name: 'index.ts', sha: INDEX_SHA },
    { mode: '100755', name: 'utils.ts', sha: UTILS_SHA },
  ];

  const rootTreeBytes = buildTreeBytes(rootTreeEntries);
  const srcTreeBytes = buildTreeBytes(srcTreeEntries);
  const commitBytes = buildCommitBytes({ treeSha: ROOT_TREE_SHA });

  function setupArweaveMocks(overrides?: {
    shaMap?: Record<string, string>;
    txData?: Record<string, Uint8Array>;
    failPrimary?: boolean;
  }) {
    const shaMap: Record<string, string> = {
      [`${COMMIT_SHA}:test-repo`]: COMMIT_TX,
      [`${ROOT_TREE_SHA}:test-repo`]: ROOT_TREE_TX,
      [`${SRC_DIR_SHA}:test-repo`]: SRC_DIR_TX,
      [`${README_SHA}:test-repo`]: README_TX,
      [`${INDEX_SHA}:test-repo`]: INDEX_TX,
      [`${UTILS_SHA}:test-repo`]: UTILS_TX,
      [`${BINARY_SHA}:test-repo`]: BINARY_TX,
      ...overrides?.shaMap,
    };

    const readmeContent = '# Test Repo\n\nThis is a test repository.\n';
    const indexContent = 'export function main() {\n  console.log("hello");\n}\n';
    const utilsContent = 'export function add(a: number, b: number) {\n  return a + b;\n}\n';
    const binaryData = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

    const txData: Record<string, Uint8Array> = {
      [COMMIT_TX]: commitBytes,
      [ROOT_TREE_TX]: rootTreeBytes,
      [SRC_DIR_TX]: srcTreeBytes,
      [README_TX]: new TextEncoder().encode(readmeContent),
      [INDEX_TX]: new TextEncoder().encode(indexContent),
      [UTILS_TX]: new TextEncoder().encode(utilsContent),
      [BINARY_TX]: binaryData,
      ...overrides?.txData,
    };

    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      // Handle Arweave GraphQL queries
      if (url.includes('/graphql')) {
        const body = JSON.parse(
          (init?.body as string) ?? '{}'
        ) as { query?: string };
        const queryStr = body.query ?? '';

        // Extract SHA and repo from GraphQL query
        // The query looks like: { name: "Git-SHA", values: ["<sha>"] }
        const shaMatch = queryStr.match(/Git-SHA",\s*values:\s*\["([0-9a-f]+)"\]/);
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
          if (overrides?.failPrimary && gateway === ARWEAVE_GATEWAYS[0]) {
            return new Response(null, { status: 500 });
          }
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
  // 8.2-E2E-001: Full tree view resolution chain
  // ==========================================================================

  describe('8.2-E2E-001: Full tree view — route to rendered directory listing', () => {
    it('[P1] resolves route -> refs -> commit -> tree -> rendered directory listing', async () => {
      // 1. Parse route
      const route = parseRoute('/npub1test/test-repo/tree/main/');
      expect(route.type).toBe('tree');
      if (route.type !== 'tree') throw new Error('Expected tree route');
      expect(route.ref).toBe('main');
      expect(route.path).toBe('');

      // 2. Parse NIP-34 events
      const repoEvent = createRepoAnnouncementEvent({
        repoId: 'test-repo',
        defaultBranch: 'main',
      });
      const repoMeta = parseRepoAnnouncement(repoEvent);
      expect(repoMeta).not.toBeNull();

      const refsEvent = createRepoRefsEvent({
        repoId: 'test-repo',
        refs: { main: COMMIT_SHA, HEAD: COMMIT_SHA },
      });
      const repoRefs = parseRepoRefs(refsEvent);
      expect(repoRefs).not.toBeNull();

      // 3. Resolve ref
      const resolved = resolveDefaultRef(repoMeta!, repoRefs!);
      expect(resolved).not.toBeNull();
      expect(resolved!.refName).toBe('main');
      expect(resolved!.commitSha).toBe(COMMIT_SHA);

      // 4. Mock Arweave and run full resolution chain
      setupArweaveMocks();

      const commitTxId = await resolveGitSha(COMMIT_SHA, 'test-repo');
      expect(commitTxId).toBe(COMMIT_TX);

      const commitData = await fetchArweaveObject(commitTxId!);
      expect(commitData).not.toBeNull();

      const commit = parseGitCommit(commitData!);
      expect(commit).not.toBeNull();
      expect(commit!.treeSha).toBe(ROOT_TREE_SHA);

      const treeTxId = await resolveGitSha(commit!.treeSha, 'test-repo');
      expect(treeTxId).toBe(ROOT_TREE_TX);

      const treeData = await fetchArweaveObject(treeTxId!);
      expect(treeData).not.toBeNull();

      const treeEntries = parseGitTree(treeData!);
      expect(treeEntries.length).toBe(5);

      // 5. Render tree view and validate DOM
      const result = renderTreeView(
        'test-repo',
        'main',
        '',
        treeEntries,
        'npub1test'
      );
      expect(result.status).toBe(200);
      container.innerHTML = result.html;

      // Verify all entries are rendered
      expect(container.textContent).toContain('src');
      expect(container.textContent).toContain('README.md');
      expect(container.textContent).toContain('image.png');
      expect(container.textContent).toContain('link');
      expect(container.textContent).toContain('ext-module');

      // Verify directories are sorted before files
      const allText = container.textContent ?? '';
      const srcPos = allText.indexOf('src');
      const readmePos = allText.indexOf('README.md');
      expect(srcPos).toBeLessThan(readmePos);

      // Verify links are generated
      const links = container.querySelectorAll('a[href]');
      expect(links.length).toBeGreaterThanOrEqual(5);

      // Verify directory links point to /tree/ routes
      const srcLink = Array.from(links).find((a) =>
        a.textContent?.includes('src')
      );
      expect(srcLink).toBeDefined();
      expect(srcLink!.getAttribute('href')).toContain('/tree/');

      // Verify file links point to /blob/ routes
      const readmeLink = Array.from(links).find((a) =>
        a.textContent?.includes('README.md')
      );
      expect(readmeLink).toBeDefined();
      expect(readmeLink!.getAttribute('href')).toContain('/blob/');
    });
  });

  // ==========================================================================
  // 8.2-E2E-002: Subdirectory navigation
  // ==========================================================================

  describe('8.2-E2E-002: Subdirectory navigation', () => {
    it('[P1] navigating to subdirectory renders subtree entries with breadcrumbs', async () => {
      setupArweaveMocks();

      // Resolve the src directory tree
      const srcTxId = await resolveGitSha(SRC_DIR_SHA, 'test-repo');
      expect(srcTxId).toBe(SRC_DIR_TX);

      const srcData = await fetchArweaveObject(srcTxId!);
      expect(srcData).not.toBeNull();

      const srcEntries = parseGitTree(srcData!);
      expect(srcEntries.length).toBe(2);
      expect(srcEntries.find((e) => e.name === 'index.ts')).toBeDefined();
      expect(srcEntries.find((e) => e.name === 'utils.ts')).toBeDefined();

      // Render subtree at path 'src'
      const result = renderTreeView(
        'test-repo',
        'main',
        'src',
        srcEntries,
        'npub1test'
      );
      expect(result.status).toBe(200);
      container.innerHTML = result.html;

      // Verify subtree entries
      expect(container.textContent).toContain('index.ts');
      expect(container.textContent).toContain('utils.ts');

      // Verify breadcrumbs show path
      const breadcrumbs = container.querySelector('.breadcrumbs');
      expect(breadcrumbs).not.toBeNull();
      expect(breadcrumbs!.textContent).toContain('test-repo');
      expect(breadcrumbs!.textContent).toContain('src');

      // Verify breadcrumb links
      const breadcrumbLinks = breadcrumbs!.querySelectorAll('a');
      expect(breadcrumbLinks.length).toBeGreaterThanOrEqual(2); // repo root + src
    });
  });

  // ==========================================================================
  // 8.2-E2E-003: Blob view — text file with line numbers
  // ==========================================================================

  describe('8.2-E2E-003: Blob view renders text file with line numbers', () => {
    it('[P1] full chain: resolve blob -> fetch -> render with line numbers', async () => {
      setupArweaveMocks();

      // Route parsing
      const route = parseRoute('/npub1test/test-repo/blob/main/README.md');
      expect(route.type).toBe('blob');
      if (route.type !== 'blob') throw new Error('Expected blob route');
      expect(route.ref).toBe('main');
      expect(route.path).toBe('README.md');

      // Fetch blob
      const blobTxId = await resolveGitSha(README_SHA, 'test-repo');
      expect(blobTxId).toBe(README_TX);

      const blobData = await fetchArweaveObject(blobTxId!);
      expect(blobData).not.toBeNull();

      // Verify not binary
      expect(isBinaryBlob(blobData!)).toBe(false);

      // Decode and render
      const content = new TextDecoder().decode(blobData!);
      const result = renderBlobView(
        'test-repo',
        'main',
        'README.md',
        content,
        false,
        blobData!.length,
        'npub1test'
      );
      expect(result.status).toBe(200);
      container.innerHTML = result.html;

      // Verify content is rendered
      expect(container.textContent).toContain('Test Repo');
      expect(container.textContent).toContain('This is a test repository.');

      // Verify line numbers are present
      const lineNumbers = container.querySelectorAll('.line-number');
      expect(lineNumbers.length).toBeGreaterThan(0);

      // Verify file name in header
      expect(container.textContent).toContain('README.md');
    });
  });

  // ==========================================================================
  // 8.2-E2E-004: Blob view — nested file path
  // ==========================================================================

  describe('8.2-E2E-004: Blob view for nested file with breadcrumbs', () => {
    it('[P1] nested path renders breadcrumbs and correct content', async () => {
      setupArweaveMocks();

      // Fetch nested file blob
      const blobTxId = await resolveGitSha(INDEX_SHA, 'test-repo');
      const blobData = await fetchArweaveObject(blobTxId!);
      expect(blobData).not.toBeNull();

      const content = new TextDecoder().decode(blobData!);
      const result = renderBlobView(
        'test-repo',
        'main',
        'src/index.ts',
        content,
        false,
        blobData!.length,
        'npub1test'
      );
      container.innerHTML = result.html;

      // Verify breadcrumbs show full path
      const breadcrumbs = container.querySelector('.breadcrumbs');
      expect(breadcrumbs).not.toBeNull();
      expect(breadcrumbs!.textContent).toContain('test-repo');
      expect(breadcrumbs!.textContent).toContain('src');
      expect(breadcrumbs!.textContent).toContain('index.ts');

      // Verify breadcrumb links for each segment
      const breadcrumbLinks = breadcrumbs!.querySelectorAll('a');
      expect(breadcrumbLinks.length).toBeGreaterThanOrEqual(3); // repo + src + index.ts

      // Verify content
      expect(container.textContent).toContain('export function main()');
      expect(container.textContent).toContain('console.log');
    });
  });

  // ==========================================================================
  // 8.2-E2E-005: Binary blob handling
  // ==========================================================================

  describe('8.2-E2E-005: Binary blob shows "not displayed" message', () => {
    it('[P1] binary file (PNG) renders message instead of garbled content', async () => {
      setupArweaveMocks();

      const blobTxId = await resolveGitSha(BINARY_SHA, 'test-repo');
      const blobData = await fetchArweaveObject(blobTxId!);
      expect(blobData).not.toBeNull();

      // Verify binary detection
      expect(isBinaryBlob(blobData!)).toBe(true);

      // Render binary blob view
      const result = renderBlobView(
        'test-repo',
        'main',
        'image.png',
        null,
        true,
        blobData!.length,
        'npub1test'
      );
      expect(result.status).toBe(200);
      container.innerHTML = result.html;

      // Should show binary notice
      expect(container.textContent).toContain('Binary file');
      expect(container.textContent).toContain('not displayed');
      expect(container.textContent).toContain(String(blobData!.length));

      // Should NOT render line numbers or code blocks
      expect(container.querySelectorAll('.line-number')).toHaveLength(0);
      expect(container.querySelectorAll('.blob-code')).toHaveLength(0);
    });
  });

  // ==========================================================================
  // 8.2-E2E-006: XSS prevention — malicious file names in tree view
  // ==========================================================================

  describe('8.2-E2E-006: XSS prevention in tree view', () => {
    it('[P0] script tags in file names are escaped in DOM', () => {
      const maliciousEntries: TreeEntry[] = [
        { mode: '100644', name: '<script>alert("xss")</script>.js', sha: 'ff'.repeat(20) },
        { mode: '40000', name: '<img src=x onerror=alert(1)>', sha: 'ee'.repeat(20) },
        { mode: '100644', name: '"><svg onload=alert(1)>', sha: 'dd'.repeat(20) },
      ];

      const result = renderTreeView('test-repo', 'main', '', maliciousEntries, 'npub1test');
      container.innerHTML = result.html;

      // No script/svg elements created by injection
      expect(container.querySelectorAll('script')).toHaveLength(0);
      expect(container.querySelectorAll('svg[onload]')).toHaveLength(0);
      expect(container.querySelectorAll('img[onerror]')).toHaveLength(0);

      // The text is visible as escaped content
      expect(container.textContent).toContain('<script>');
      expect(container.textContent).toContain('alert');
    });

    it('[P0] XSS in path segments of breadcrumbs is escaped', () => {
      const entries: TreeEntry[] = [
        { mode: '100644', name: 'safe.txt', sha: 'aa'.repeat(20) },
      ];

      const result = renderTreeView(
        'test-repo',
        'main',
        '<script>alert("path-xss")</script>',
        entries,
        'npub1test'
      );
      container.innerHTML = result.html;

      expect(container.querySelectorAll('script')).toHaveLength(0);
    });
  });

  // ==========================================================================
  // 8.2-E2E-007: XSS prevention — malicious blob content
  // ==========================================================================

  describe('8.2-E2E-007: XSS prevention in blob view', () => {
    it('[P0] HTML file with script tags renders as text, not executed', () => {
      const htmlContent = `<!DOCTYPE html>
<html>
<head>
  <script>document.cookie="stolen"</script>
  <script src="https://evil.com/steal.js"></script>
</head>
<body onload="alert('xss')">
  <img src=x onerror="alert('img-xss')">
  <a href="javascript:alert('link-xss')">Click</a>
</body>
</html>`;

      const result = renderBlobView(
        'test-repo',
        'main',
        'evil.html',
        htmlContent,
        false,
        htmlContent.length,
        'npub1test'
      );
      container.innerHTML = result.html;

      // No executable elements should be created
      expect(container.querySelectorAll('script')).toHaveLength(0);
      expect(container.querySelectorAll('body[onload]')).toHaveLength(0);
      expect(container.querySelectorAll('img[onerror]')).toHaveLength(0);
      expect(container.querySelectorAll('a[href^="javascript:"]')).toHaveLength(0);

      // The text content should be visible
      expect(container.textContent).toContain('<script>');
      expect(container.textContent).toContain('document.cookie');
    });

    it('[P0] SVG with embedded script in blob view is neutralized', () => {
      const svgContent = `<svg xmlns="http://www.w3.org/2000/svg">
  <script>alert("svg-xss")</script>
  <circle cx="50" cy="50" r="40" />
</svg>`;

      const result = renderBlobView(
        'test-repo',
        'main',
        'icon.svg',
        svgContent,
        false,
        svgContent.length,
        'npub1test'
      );
      container.innerHTML = result.html;

      expect(container.querySelectorAll('script')).toHaveLength(0);
      expect(container.querySelectorAll('svg')).toHaveLength(0);
      expect(container.textContent).toContain('<svg');
    });
  });

  // ==========================================================================
  // 8.2-E2E-008: Router — tree and blob routes
  // ==========================================================================

  describe('8.2-E2E-008: Router tree/blob route parsing', () => {
    it('[P1] parses tree route with ref and nested path', () => {
      const route = parseRoute('/npub1abc/my-repo/tree/main/src/web');
      expect(route).toEqual({
        type: 'tree',
        owner: 'npub1abc',
        repo: 'my-repo',
        ref: 'main',
        path: 'src/web',
      });
    });

    it('[P1] parses blob route with ref and file path', () => {
      const route = parseRoute('/npub1abc/my-repo/blob/develop/src/index.ts');
      expect(route).toEqual({
        type: 'blob',
        owner: 'npub1abc',
        repo: 'my-repo',
        ref: 'develop',
        path: 'src/index.ts',
      });
    });

    it('[P1] bare repo route resolves to tree with empty ref', () => {
      const route = parseRoute('/npub1abc/my-repo/');
      expect(route).toEqual({
        type: 'tree',
        owner: 'npub1abc',
        repo: 'my-repo',
        ref: '',
        path: '',
      });
    });

    it('[P1] tree route with ref only (no path)', () => {
      const route = parseRoute('/npub1abc/my-repo/tree/v1.0');
      expect(route).toEqual({
        type: 'tree',
        owner: 'npub1abc',
        repo: 'my-repo',
        ref: 'v1.0',
        path: '',
      });
    });

    it('[P1] deeply nested blob path', () => {
      const route = parseRoute(
        '/npub1abc/my-repo/blob/main/packages/web/src/components/Button.tsx'
      );
      expect(route.type).toBe('blob');
      if (route.type !== 'blob') throw new Error('Expected blob route');
      expect(route.path).toBe('packages/web/src/components/Button.tsx');
    });
  });

  // ==========================================================================
  // 8.2-E2E-009: NIP-34 ref resolution flow
  // ==========================================================================

  describe('8.2-E2E-009: NIP-34 ref resolution — full flow', () => {
    it('[P1] kind:30618 refs resolve default branch to commit SHA', () => {
      const repoEvent = createRepoAnnouncementEvent({
        repoId: 'my-repo',
        defaultBranch: 'develop',
      });
      const repoMeta = parseRepoAnnouncement(repoEvent)!;

      const refsEvent = createRepoRefsEvent({
        repoId: 'my-repo',
        refs: {
          main: 'aa'.repeat(20),
          develop: 'bb'.repeat(20),
          HEAD: 'aa'.repeat(20),
        },
      });
      const repoRefs = parseRepoRefs(refsEvent)!;

      // Should pick 'develop' as default (from repo metadata)
      const resolved = resolveDefaultRef(repoMeta, repoRefs);
      expect(resolved).not.toBeNull();
      expect(resolved!.refName).toBe('develop');
      expect(resolved!.commitSha).toBe('bb'.repeat(20));
    });

    it('[P1] falls back to HEAD when default branch not in refs', () => {
      const repoEvent = createRepoAnnouncementEvent({
        repoId: 'my-repo',
        defaultBranch: 'nonexistent',
      });
      const repoMeta = parseRepoAnnouncement(repoEvent)!;

      const refsEvent = createRepoRefsEvent({
        repoId: 'my-repo',
        refs: {
          main: 'cc'.repeat(20),
          HEAD: 'cc'.repeat(20),
        },
      });
      const repoRefs = parseRepoRefs(refsEvent)!;

      const resolved = resolveDefaultRef(repoMeta, repoRefs);
      expect(resolved!.refName).toBe('HEAD');
    });

    it('[P1] falls back to first available ref when neither default nor HEAD exist', () => {
      const repoEvent = createRepoAnnouncementEvent({
        repoId: 'my-repo',
        defaultBranch: 'nonexistent',
      });
      const repoMeta = parseRepoAnnouncement(repoEvent)!;

      const refsEvent = createRepoRefsEvent({
        repoId: 'my-repo',
        refs: { 'feature/xyz': 'dd'.repeat(20) },
      });
      const repoRefs = parseRepoRefs(refsEvent)!;

      const resolved = resolveDefaultRef(repoMeta, repoRefs);
      expect(resolved).not.toBeNull();
      expect(resolved!.refName).toBe('feature/xyz');
    });

    it('[P1] returns null when refs map is empty', () => {
      const repoEvent = createRepoAnnouncementEvent({
        repoId: 'my-repo',
        defaultBranch: 'main',
      });
      const repoMeta = parseRepoAnnouncement(repoEvent)!;

      const refsEvent = createRepoRefsEvent({
        repoId: 'my-repo',
        refs: {},
      });
      const repoRefs = parseRepoRefs(refsEvent)!;

      const resolved = resolveDefaultRef(repoMeta, repoRefs);
      expect(resolved).toBeNull();
    });

    it('[P2] malformed kind:30618 (wrong kind) returns null', () => {
      const event: NostrEvent = {
        id: 'x'.repeat(64),
        pubkey: 'ab'.repeat(32),
        created_at: 1711100000,
        kind: 30617, // wrong kind
        tags: [['d', 'my-repo'], ['r', 'main', 'aa'.repeat(20)]],
        content: '',
        sig: 'f'.repeat(128),
      };
      expect(parseRepoRefs(event)).toBeNull();
    });

    it('[P2] malformed kind:30618 (missing d tag) returns null', () => {
      const event: NostrEvent = {
        id: 'x'.repeat(64),
        pubkey: 'ab'.repeat(32),
        created_at: 1711100000,
        kind: 30618,
        tags: [['r', 'main', 'aa'.repeat(20)]],
        content: '',
        sig: 'f'.repeat(128),
      };
      expect(parseRepoRefs(event)).toBeNull();
    });
  });

  // ==========================================================================
  // 8.2-E2E-010: Gateway fallback during full resolution
  // ==========================================================================

  describe('8.2-E2E-010: Arweave gateway fallback during resolution', () => {
    it('[P1] primary gateway fails, fallback serves content successfully', async () => {
      setupArweaveMocks({ failPrimary: true });

      // The SHA resolution goes through GraphQL (only primary), but object
      // fetch falls back to secondary gateway
      const blobTxId = await resolveGitSha(README_SHA, 'test-repo');
      expect(blobTxId).toBe(README_TX);

      const blobData = await fetchArweaveObject(blobTxId!);
      expect(blobData).not.toBeNull();

      const content = new TextDecoder().decode(blobData!);
      expect(content).toContain('Test Repo');
    });

    it('[P1] all gateways fail — returns null gracefully', async () => {
      globalThis.fetch = vi.fn(async () => {
        return new Response(null, { status: 500 });
      }) as typeof fetch;

      const result = await fetchArweaveObject(COMMIT_TX);
      expect(result).toBeNull();
    });
  });

  // ==========================================================================
  // 8.2-E2E-011: SHA-to-txId caching
  // ==========================================================================

  describe('8.2-E2E-011: SHA-to-txId cache prevents duplicate lookups', () => {
    it('[P1] second resolveGitSha call uses cache, no duplicate fetch', async () => {
      setupArweaveMocks();

      // First call — should trigger fetch
      const txId1 = await resolveGitSha(COMMIT_SHA, 'test-repo');
      expect(txId1).toBe(COMMIT_TX);
      const fetchCallCount1 = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;

      // Second call — should use cache
      const txId2 = await resolveGitSha(COMMIT_SHA, 'test-repo');
      expect(txId2).toBe(COMMIT_TX);
      const fetchCallCount2 = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;

      // No additional fetch calls
      expect(fetchCallCount2).toBe(fetchCallCount1);
    });
  });

  // ==========================================================================
  // 8.2-E2E-012: Error states — 404 and missing content
  // ==========================================================================

  describe('8.2-E2E-012: Error states render gracefully', () => {
    it('[P1] tree view with null entries renders 404', () => {
      const result = renderTreeView('test-repo', 'main', 'nonexistent', null, 'npub1test');
      expect(result.status).toBe(404);
      container.innerHTML = result.html;
      expect(container.textContent).toContain('404');
      expect(container.textContent).toContain('not found');
    });

    it('[P1] blob view with null content renders 404', () => {
      const result = renderBlobView('test-repo', 'main', 'missing.txt', null, false, 0, 'npub1test');
      expect(result.status).toBe(404);
      container.innerHTML = result.html;
      expect(container.textContent).toContain('404');
      expect(container.textContent).toContain('not found');
    });

    it('[P1] SHA not found in Arweave returns null', async () => {
      setupArweaveMocks();

      const result = await resolveGitSha('00'.repeat(20), 'test-repo');
      expect(result).toBeNull();
    });
  });

  // ==========================================================================
  // 8.2-E2E-EXTRA: Git object parser edge cases in full flow
  // ==========================================================================

  describe('8.2-E2E-EXTRA: Git object edge cases in rendering pipeline', () => {
    it('[P1] empty tree renders empty directory listing', () => {
      const emptyTree = new Uint8Array(0);
      const entries = parseGitTree(emptyTree);
      expect(entries).toEqual([]);

      const result = renderTreeView('test-repo', 'main', '', entries, 'npub1test');
      expect(result.status).toBe(200);
      container.innerHTML = result.html;
      // Should render the tree-view container but with no entries
      expect(container.querySelector('.tree-view')).not.toBeNull();
    });

    it('[P1] unicode filenames are preserved through parse-render pipeline', () => {
      const unicodeEntries = [
        { mode: '100644', name: 'cafe\u0301.txt', sha: 'ab'.repeat(20) },
        { mode: '100644', name: '\u4F60\u597D.md', sha: 'cd'.repeat(20) },
        { mode: '40000', name: '\u{1F4C1}_docs', sha: 'ef'.repeat(20) },
      ];
      const treeBytes = buildTreeBytes(unicodeEntries);
      const parsed = parseGitTree(treeBytes);

      expect(parsed.length).toBe(3);

      const result = renderTreeView('test-repo', 'main', '', parsed, 'npub1test');
      container.innerHTML = result.html;

      // Unicode content should be preserved
      expect(container.textContent).toContain('\u4F60\u597D.md');
    });

    it('[P1] symlink and submodule entries render with correct indicators', () => {
      const specialEntries: TreeEntry[] = [
        { mode: '120000', name: 'config-link', sha: 'aa'.repeat(20) },
        { mode: '160000', name: 'external-lib', sha: 'bb'.repeat(20) },
        { mode: '100644', name: 'normal.txt', sha: 'cc'.repeat(20) },
      ];

      const result = renderTreeView('test-repo', 'main', '', specialEntries, 'npub1test');
      container.innerHTML = result.html;

      expect(container.textContent).toContain('config-link');
      expect(container.textContent).toContain('external-lib');
      expect(container.textContent).toContain('normal.txt');

      // Verify different mode values are displayed
      const modeElements = container.querySelectorAll('.tree-entry-mode');
      const modes = Array.from(modeElements).map((el) => el.textContent);
      expect(modes).toContain('120000');
      expect(modes).toContain('160000');
      expect(modes).toContain('100644');
    });

    it('[P1] merge commit with multiple parents is parsed correctly', () => {
      const mergeCommit = buildCommitBytes({
        treeSha: ROOT_TREE_SHA,
        parentShas: ['11'.repeat(20), '22'.repeat(20)],
        message: 'Merge branch feature into main',
      });
      const parsed = parseGitCommit(mergeCommit);
      expect(parsed).not.toBeNull();
      expect(parsed!.parentShas).toHaveLength(2);
      expect(parsed!.parentShas[0]).toBe('11'.repeat(20));
      expect(parsed!.parentShas[1]).toBe('22'.repeat(20));
    });

    it('[P1] executable file (mode 100755) renders same as regular file', () => {
      const entries: TreeEntry[] = [
        { mode: '100755', name: 'run.sh', sha: 'aa'.repeat(20) },
        { mode: '100644', name: 'readme.txt', sha: 'bb'.repeat(20) },
      ];

      const result = renderTreeView('test-repo', 'main', '', entries, 'npub1test');
      container.innerHTML = result.html;

      // Both should have blob links
      const links = container.querySelectorAll('a[href*="/blob/"]');
      expect(links.length).toBe(2);
    });
  });

  // ==========================================================================
  // 8.2-E2E-EXTRA: Breadcrumb navigation correctness
  // ==========================================================================

  describe('8.2-E2E-EXTRA: Breadcrumb navigation', () => {
    it('[P1] deeply nested path renders all breadcrumb segments as links', () => {
      const entries: TreeEntry[] = [
        { mode: '100644', name: 'Component.tsx', sha: 'aa'.repeat(20) },
      ];

      const result = renderTreeView(
        'my-repo',
        'main',
        'packages/web/src/components',
        entries,
        'npub1owner'
      );
      container.innerHTML = result.html;

      const breadcrumbs = container.querySelector('.breadcrumbs');
      expect(breadcrumbs).not.toBeNull();

      // Should have breadcrumb links for: my-repo, packages, web, src, components
      const crumbLinks = breadcrumbs!.querySelectorAll('.breadcrumb-link');
      expect(crumbLinks.length).toBe(5);

      // Verify each segment is present
      const crumbTexts = Array.from(crumbLinks).map((el) => el.textContent);
      expect(crumbTexts).toContain('my-repo');
      expect(crumbTexts).toContain('packages');
      expect(crumbTexts).toContain('web');
      expect(crumbTexts).toContain('src');
      expect(crumbTexts).toContain('components');

      // Each breadcrumb link should point to a tree route
      for (const link of crumbLinks) {
        const href = link.getAttribute('href')!;
        expect(href).toContain('/tree/main/');
      }
    });

    it('[P1] root path renders only repo name in breadcrumbs', () => {
      const entries: TreeEntry[] = [
        { mode: '100644', name: 'file.txt', sha: 'aa'.repeat(20) },
      ];

      const result = renderTreeView('my-repo', 'main', '', entries, 'npub1owner');
      container.innerHTML = result.html;

      const crumbLinks = container.querySelectorAll('.breadcrumb-link');
      expect(crumbLinks.length).toBe(1);
      expect(crumbLinks[0]!.textContent).toBe('my-repo');
    });

    it('[P1] ref name is displayed in breadcrumbs', () => {
      const entries: TreeEntry[] = [
        { mode: '100644', name: 'file.txt', sha: 'aa'.repeat(20) },
      ];

      const result = renderTreeView('my-repo', 'v2.0.0', '', entries, 'npub1owner');
      container.innerHTML = result.html;

      const refBadge = container.querySelector('.breadcrumb-ref');
      expect(refBadge).not.toBeNull();
      expect(refBadge!.textContent).toBe('v2.0.0');
    });
  });
});
