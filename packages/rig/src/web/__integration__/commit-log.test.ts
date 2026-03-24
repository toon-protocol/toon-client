// @vitest-environment jsdom
// Test IDs: 8.3-INT-001
// AC covered: #4 (Commit log integration)

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { parseGitCommit } from '../git-objects.js';
import { renderCommitLog } from '../templates.js';
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

// ============================================================================
// Tests
// ============================================================================

describe('Integration: Commit Log', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it('[P1] renders commit log from parsed commit data in correct order (8.3-INT-001)', () => {
    const treeSha = 'ff'.repeat(20);
    const sha1 = 'aa'.repeat(20);
    const sha2 = 'bb'.repeat(20);
    const sha3 = 'cc'.repeat(20);

    // Parse commit bytes
    const commit1 = parseGitCommit(
      buildCommitBytes({
        treeSha,
        parentShas: [sha2],
        author: 'Alice <alice@example.com> 1700003000 +0000',
        message: 'Third commit (latest)',
      })
    );
    const commit2 = parseGitCommit(
      buildCommitBytes({
        treeSha,
        parentShas: [sha3],
        author: 'Bob <bob@example.com> 1700002000 +0000',
        message: 'Second commit',
      })
    );
    const commit3 = parseGitCommit(
      buildCommitBytes({
        treeSha,
        parentShas: [],
        author: 'Carol <carol@example.com> 1700001000 +0000',
        message: 'First commit (root)',
      })
    );

    expect(commit1).not.toBeNull();
    expect(commit2).not.toBeNull();
    expect(commit3).not.toBeNull();

    const entries: CommitLogEntry[] = [
      { sha: sha1, commit: commit1! },
      { sha: sha2, commit: commit2! },
      { sha: sha3, commit: commit3! },
    ];

    // Render
    const result = renderCommitLog('test-repo', 'main', entries, 'npub1test');
    container.innerHTML = result.html;

    // Verify all commits displayed
    expect(container.textContent).toContain('Third commit (latest)');
    expect(container.textContent).toContain('Second commit');
    expect(container.textContent).toContain('First commit (root)');

    // Verify authors displayed
    expect(container.textContent).toContain('Alice');
    expect(container.textContent).toContain('Bob');
    expect(container.textContent).toContain('Carol');

    // Verify abbreviated hashes
    expect(container.textContent).toContain(sha1.slice(0, 7));
    expect(container.textContent).toContain(sha2.slice(0, 7));
    expect(container.textContent).toContain(sha3.slice(0, 7));

    // Verify order: newest first
    const allText = container.textContent ?? '';
    const pos1 = allText.indexOf('Third commit');
    const pos2 = allText.indexOf('Second commit');
    const pos3 = allText.indexOf('First commit');
    expect(pos1).toBeLessThan(pos2);
    expect(pos2).toBeLessThan(pos3);

    // Verify links exist
    const links = container.querySelectorAll('a.commit-sha');
    expect(links).toHaveLength(3);
  });

  it('[P0] XSS in commit messages is escaped in rendered DOM', () => {
    const treeSha = 'ff'.repeat(20);
    const sha = 'aa'.repeat(20);

    const commit = parseGitCommit(
      buildCommitBytes({
        treeSha,
        message: '<script>alert("xss")</script>',
      })
    );
    expect(commit).not.toBeNull();

    const entries: CommitLogEntry[] = [{ sha, commit: commit! }];
    const result = renderCommitLog('test-repo', 'main', entries, 'npub1test');
    container.innerHTML = result.html;

    expect(container.querySelectorAll('script')).toHaveLength(0);
    expect(container.textContent).toContain('<script>');
  });
});
