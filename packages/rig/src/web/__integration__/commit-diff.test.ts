// @vitest-environment jsdom
// Test IDs: 8.3-INT-002
// AC covered: #10, #11 (Commit diff integration)

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { parseGitCommit, parseGitTree } from '../git-objects.js';
import { diffTrees } from '../tree-diff.js';
import { computeUnifiedDiff } from '../unified-diff.js';
import { renderCommitDiff } from '../templates.js';
import type { FileDiff } from '../templates.js';
import type { CommitLogEntry } from '../commit-walker.js';

// ============================================================================
// Helpers
// ============================================================================

function buildCommitBytes(opts: {
  treeSha: string;
  parentShas?: string[];
  author?: string;
  message?: string;
}): Uint8Array {
  const lines: string[] = [];
  lines.push(`tree ${opts.treeSha}`);
  for (const parent of opts.parentShas ?? []) {
    lines.push(`parent ${parent}`);
  }
  lines.push(
    `author ${opts.author ?? 'Test User <test@example.com> 1700000000 +0000'}`
  );
  lines.push(
    `committer ${opts.author ?? 'Test User <test@example.com> 1700000000 +0000'}`
  );
  lines.push('');
  lines.push(opts.message ?? 'Test commit');
  return new TextEncoder().encode(lines.join('\n'));
}

function buildTreeEntry(mode: string, name: string, shaHex: string): number[] {
  const bytes: number[] = [];
  for (const ch of mode) bytes.push(ch.charCodeAt(0));
  bytes.push(0x20);
  const nameBytes = new TextEncoder().encode(name);
  for (const b of nameBytes) bytes.push(b);
  bytes.push(0x00);
  for (let i = 0; i < 40; i += 2) {
    bytes.push(parseInt(shaHex.slice(i, i + 2), 16));
  }
  return bytes;
}

function buildTreeObject(
  entries: { mode: string; name: string; sha: string }[]
): Uint8Array {
  const allBytes: number[] = [];
  for (const entry of entries) {
    allBytes.push(...buildTreeEntry(entry.mode, entry.name, entry.sha));
  }
  return new Uint8Array(allBytes);
}

// ============================================================================
// Tests
// ============================================================================

describe('Integration: Commit Diff', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it('[P1] renders diff view with file changes and inline diff (8.3-INT-002)', () => {
    const sha = 'ab'.repeat(20);
    const parentSha = 'cd'.repeat(20);
    const treeSha = 'ee'.repeat(20);
    const _parentTreeSha = 'ff'.repeat(20);

    // Parse commit
    const commit = parseGitCommit(
      buildCommitBytes({
        treeSha,
        parentShas: [parentSha],
        author: 'Alice <alice@example.com> 1700000000 +0000',
        message: 'Update README and add config',
      })
    );
    expect(commit).not.toBeNull();

    // Build trees
    const parentTree = parseGitTree(
      buildTreeObject([
        { mode: '100644', name: 'README.md', sha: 'a1'.repeat(20) },
        { mode: '100644', name: 'old-file.ts', sha: 'a2'.repeat(20) },
      ])
    );

    const currentTree = parseGitTree(
      buildTreeObject([
        { mode: '100644', name: 'README.md', sha: 'b1'.repeat(20) }, // modified
        { mode: '100644', name: 'config.json', sha: 'b2'.repeat(20) }, // added
        // old-file.ts deleted
      ])
    );

    // Compute diff
    const treeDiffEntries = diffTrees(parentTree, currentTree);

    // Build file diffs (simulating blob fetches)
    const readmeDiff = computeUnifiedDiff(
      '# My Project\n\nOld description',
      '# My Project\n\nNew description with updates'
    );

    const configDiff = computeUnifiedDiff('', '{\n  "key": "value"\n}');

    const fileDiffs: FileDiff[] = [
      {
        name: 'old-file.ts',
        status: 'deleted',
        hunks: computeUnifiedDiff('const x = 1;', ''),
        isBinary: false,
      },
      {
        name: 'README.md',
        status: 'modified',
        hunks: readmeDiff,
        isBinary: false,
      },
      {
        name: 'config.json',
        status: 'added',
        hunks: configDiff,
        isBinary: false,
      },
    ];

    const entry: CommitLogEntry = { sha, commit: commit! };
    const result = renderCommitDiff(
      'test-repo',
      sha,
      entry,
      treeDiffEntries,
      fileDiffs,
      'npub1test'
    );

    container.innerHTML = result.html;

    // Verify commit message
    expect(container.textContent).toContain('Update README and add config');
    expect(container.textContent).toContain('Alice');

    // Verify file names in diff
    expect(container.textContent).toContain('README.md');
    expect(container.textContent).toContain('config.json');
    expect(container.textContent).toContain('old-file.ts');

    // Verify status badges exist
    const badges = container.querySelectorAll('.diff-status-badge');
    expect(badges.length).toBeGreaterThanOrEqual(3);

    // Verify diff content has add/delete lines
    const addLines = container.querySelectorAll('.diff-line-add');
    const delLines = container.querySelectorAll('.diff-line-delete');
    expect(addLines.length).toBeGreaterThan(0);
    expect(delLines.length).toBeGreaterThan(0);

    // Verify diff summary
    expect(container.textContent).toContain('added');
    expect(container.textContent).toContain('deleted');
    expect(container.textContent).toContain('modified');
  });

  it('[P1] root commit shows all files as added', () => {
    const sha = 'ab'.repeat(20);
    const treeSha = 'ee'.repeat(20);

    const commit = parseGitCommit(
      buildCommitBytes({
        treeSha,
        parentShas: [],
        message: 'Initial commit',
      })
    );
    expect(commit).not.toBeNull();

    // For root commit, parent tree is empty
    const currentTree = parseGitTree(
      buildTreeObject([
        { mode: '100644', name: 'README.md', sha: 'b1'.repeat(20) },
        { mode: '100644', name: 'index.ts', sha: 'b2'.repeat(20) },
      ])
    );

    const treeDiffEntries = diffTrees([], currentTree);

    // All files added
    expect(treeDiffEntries.every((e) => e.status === 'added')).toBe(true);

    const fileDiffs: FileDiff[] = treeDiffEntries.map((e) => ({
      name: e.name,
      status: e.status,
      hunks: computeUnifiedDiff('', 'content of ' + e.name),
      isBinary: false,
    }));

    const entry: CommitLogEntry = { sha, commit: commit! };
    const result = renderCommitDiff(
      'test-repo',
      sha,
      entry,
      treeDiffEntries,
      fileDiffs,
      'npub1test'
    );

    container.innerHTML = result.html;

    expect(container.textContent).toContain('root commit');
    expect(container.textContent).toContain('README.md');
    expect(container.textContent).toContain('index.ts');

    // All diff lines should be additions
    const addLines = container.querySelectorAll('.diff-line-add');
    expect(addLines.length).toBeGreaterThan(0);
  });
});
