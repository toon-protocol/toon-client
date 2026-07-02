// @vitest-environment jsdom
// Test IDs: 8.3-UNIT-001, 8.3-UNIT-002
// AC covered: #1, #2, #3

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { walkCommitChain } from './commit-walker.js';

// Mock the Arweave client module
vi.mock('./arweave-client.js', () => ({
  resolveGitSha: vi.fn(),
  fetchArweaveObject: vi.fn(),
}));

import { resolveGitSha, fetchArweaveObject } from './arweave-client.js';

const mockResolveGitSha = vi.mocked(resolveGitSha);
const mockFetchArweaveObject = vi.mocked(fetchArweaveObject);

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
    `author ${opts.author ?? 'Test <test@example.com> 1700000000 +0000'}`
  );
  lines.push(
    `committer ${opts.author ?? 'Test <test@example.com> 1700000000 +0000'}`
  );
  lines.push('');
  lines.push(opts.message ?? 'commit message');
  return new TextEncoder().encode(lines.join('\n'));
}

// ============================================================================
// Tests
// ============================================================================

describe('Commit Chain Walker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // 8.3-UNIT-001: Linear chain walk
  // ---------------------------------------------------------------------------

  it('[P1] walks a 3-commit linear chain and returns all in order (8.3-UNIT-001)', async () => {
    const sha1 = 'a'.repeat(40);
    const sha2 = 'b'.repeat(40);
    const sha3 = 'c'.repeat(40);
    const treeSha = 'd'.repeat(40);

    // Commit 1 (newest) -> parent: commit 2
    // Commit 2 -> parent: commit 3
    // Commit 3 (root) -> no parent

    mockResolveGitSha
      .mockResolvedValueOnce('tx1') // sha1
      .mockResolvedValueOnce('tx2') // sha2
      .mockResolvedValueOnce('tx3'); // sha3

    mockFetchArweaveObject
      .mockResolvedValueOnce(
        buildCommitBytes({ treeSha, parentShas: [sha2], message: 'third' })
      )
      .mockResolvedValueOnce(
        buildCommitBytes({ treeSha, parentShas: [sha3], message: 'second' })
      )
      .mockResolvedValueOnce(
        buildCommitBytes({ treeSha, parentShas: [], message: 'first' })
      );

    const result = await walkCommitChain(sha1, 'test-repo');

    expect(result).toHaveLength(3);
    expect(result[0]!.sha).toBe(sha1);
    expect(result[0]!.commit.message).toBe('third');
    expect(result[1]!.sha).toBe(sha2);
    expect(result[1]!.commit.message).toBe('second');
    expect(result[2]!.sha).toBe(sha3);
    expect(result[2]!.commit.message).toBe('first');
  });

  // ---------------------------------------------------------------------------
  // 8.3-UNIT-002: Merge commit follows first parent only
  // ---------------------------------------------------------------------------

  it('[P1] follows only first parent of merge commit (8.3-UNIT-002)', async () => {
    const sha1 = 'a'.repeat(40);
    const sha2 = 'b'.repeat(40);
    const sha3 = 'c'.repeat(40); // second parent (not followed)
    const treeSha = 'd'.repeat(40);

    mockResolveGitSha
      .mockResolvedValueOnce('tx1') // sha1
      .mockResolvedValueOnce('tx2'); // sha2

    mockFetchArweaveObject
      .mockResolvedValueOnce(
        buildCommitBytes({
          treeSha,
          parentShas: [sha2, sha3],
          message: 'merge commit',
        })
      )
      .mockResolvedValueOnce(
        buildCommitBytes({ treeSha, parentShas: [], message: 'root' })
      );

    const result = await walkCommitChain(sha1, 'test-repo');

    expect(result).toHaveLength(2);
    expect(result[0]!.commit.parentShas).toEqual([sha2, sha3]); // preserves all parent SHAs
    expect(result[1]!.sha).toBe(sha2); // followed first parent, not sha3
  });

  it('[P2] stops at maxDepth', async () => {
    const shas = Array.from({ length: 5 }, (_, i) =>
      String(i).repeat(40).slice(0, 40)
    );
    const treeSha = 'f'.repeat(40);

    for (let i = 0; i < 5; i++) {
      mockResolveGitSha.mockResolvedValueOnce(`tx${i}`);
      const parentShas = i < 4 ? [shas[i + 1]!] : [];
      mockFetchArweaveObject.mockResolvedValueOnce(
        buildCommitBytes({ treeSha, parentShas, message: `commit ${i}` })
      );
    }

    const result = await walkCommitChain(shas[0]!, 'test-repo', 2);

    expect(result).toHaveLength(2);
  });

  it('[P2] stops gracefully when parent SHA resolution fails', async () => {
    const sha1 = 'a'.repeat(40);
    const sha2 = 'b'.repeat(40);
    const treeSha = 'd'.repeat(40);

    mockResolveGitSha.mockReset();
    mockFetchArweaveObject.mockReset();

    mockResolveGitSha.mockImplementation(async (sha: string) => {
      if (sha === sha1) return 'tx1';
      return null; // sha2 fails
    });

    mockFetchArweaveObject.mockResolvedValueOnce(
      buildCommitBytes({ treeSha, parentShas: [sha2], message: 'latest' })
    );

    const result = await walkCommitChain(sha1, 'test-repo');

    expect(result).toHaveLength(1);
    expect(result[0]!.sha).toBe(sha1);
  });

  it('[P2] root commit (no parents) returns single commit', async () => {
    const sha = 'a'.repeat(40);
    const treeSha = 'ee'.repeat(20);

    mockResolveGitSha.mockReset();
    mockFetchArweaveObject.mockReset();

    mockResolveGitSha.mockResolvedValueOnce('tx1');
    mockFetchArweaveObject.mockResolvedValueOnce(
      buildCommitBytes({ treeSha, parentShas: [], message: 'initial' })
    );

    const result = await walkCommitChain(sha, 'test-repo');

    expect(result).toHaveLength(1);
    expect(result[0]!.commit.parentShas).toEqual([]);
  });

  it('[P2] stops gracefully when fetchArweaveObject throws an error', async () => {
    const sha1 = 'a'.repeat(40);
    const sha2 = 'b'.repeat(40);
    const treeSha = 'd'.repeat(40);

    mockResolveGitSha.mockReset();
    mockFetchArweaveObject.mockReset();

    mockResolveGitSha.mockResolvedValueOnce('tx1').mockResolvedValueOnce('tx2');

    mockFetchArweaveObject
      .mockResolvedValueOnce(
        buildCommitBytes({ treeSha, parentShas: [sha2], message: 'latest' })
      )
      .mockRejectedValueOnce(new Error('Network error'));

    const result = await walkCommitChain(sha1, 'test-repo');

    expect(result).toHaveLength(1);
    expect(result[0]!.sha).toBe(sha1);
  });

  it('[P2] returns empty array when starting SHA cannot be resolved', async () => {
    const sha = 'a'.repeat(40);

    mockResolveGitSha.mockReset();
    mockFetchArweaveObject.mockReset();

    mockResolveGitSha.mockResolvedValueOnce(null);

    const result = await walkCommitChain(sha, 'test-repo');

    expect(result).toHaveLength(0);
  });
});
