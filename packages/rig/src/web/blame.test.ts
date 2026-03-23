// @vitest-environment jsdom
// Test IDs: 8.4-UNIT-001, 8.4-UNIT-002, 8.4-UNIT-003
// AC covered: #1, #2, #3, #4, #5, #6

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { computeBlame, resolveFileSha, isBlameError } from './blame.js';

// Mock arweave-client and git-objects
vi.mock('./arweave-client.js', () => ({
  resolveGitSha: vi.fn(),
  fetchArweaveObject: vi.fn(),
}));

vi.mock('./git-objects.js', () => ({
  parseGitCommit: vi.fn(),
  parseGitTree: vi.fn(),
  isBinaryBlob: vi.fn(),
}));

import { resolveGitSha, fetchArweaveObject } from './arweave-client.js';
import { parseGitCommit, parseGitTree, isBinaryBlob } from './git-objects.js';

const mockResolveGitSha = vi.mocked(resolveGitSha);
const mockFetchArweaveObject = vi.mocked(fetchArweaveObject);
const mockParseGitCommit = vi.mocked(parseGitCommit);
const mockParseGitTree = vi.mocked(parseGitTree);
const mockIsBinaryBlob = vi.mocked(isBinaryBlob);

// ============================================================================
// Helpers
// ============================================================================

function textToBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function makeSha(prefix: string): string {
  return prefix.repeat(Math.ceil(40 / prefix.length)).slice(0, 40);
}

// ============================================================================
// Tests: resolveFileSha
// ============================================================================

describe('Blame - resolveFileSha', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('[P1] walks nested tree path correctly (8.4-UNIT-008)', async () => {
    const rootTreeSha = makeSha('aa');
    const srcTreeSha = makeSha('bb');
    const webTreeSha = makeSha('cc');
    const fileBlobSha = makeSha('dd');

    // Root tree -> src dir
    mockResolveGitSha.mockImplementation(async (sha) => {
      if (sha === rootTreeSha) return 'tx-root';
      if (sha === srcTreeSha) return 'tx-src';
      if (sha === webTreeSha) return 'tx-web';
      return null;
    });

    mockFetchArweaveObject.mockImplementation(async (txId) => {
      if (txId === 'tx-root') return textToBytes('root-tree');
      if (txId === 'tx-src') return textToBytes('src-tree');
      if (txId === 'tx-web') return textToBytes('web-tree');
      return null;
    });

    mockParseGitTree.mockImplementation((_data) => {
      const dataStr = new TextDecoder().decode(_data as Uint8Array);
      if (dataStr === 'root-tree') {
        return [{ mode: '40000', name: 'src', sha: srcTreeSha }];
      }
      if (dataStr === 'src-tree') {
        return [{ mode: '40000', name: 'web', sha: webTreeSha }];
      }
      if (dataStr === 'web-tree') {
        return [{ mode: '100644', name: 'main.ts', sha: fileBlobSha }];
      }
      return [];
    });

    const result = await resolveFileSha(
      rootTreeSha,
      'src/web/main.ts',
      'test-repo'
    );
    expect(result).toBe(fileBlobSha);
  });

  it('[P1] returns null for file not found in tree', async () => {
    const rootTreeSha = makeSha('aa');

    mockResolveGitSha.mockResolvedValue('tx-root');
    mockFetchArweaveObject.mockResolvedValue(textToBytes('root-tree'));
    mockParseGitTree.mockReturnValue([
      { mode: '100644', name: 'other-file.ts', sha: makeSha('xx') },
    ]);

    const result = await resolveFileSha(rootTreeSha, 'missing.ts', 'test-repo');
    expect(result).toBeNull();
  });

  it('[P2] returns null for empty path', async () => {
    const result = await resolveFileSha(makeSha('aa'), '', 'test-repo');
    expect(result).toBeNull();
  });

  it('[P2] returns null when tree SHA cannot be resolved on Arweave', async () => {
    mockResolveGitSha.mockResolvedValue(null);

    const result = await resolveFileSha(makeSha('aa'), 'file.ts', 'test-repo');
    expect(result).toBeNull();
  });
});

// ============================================================================
// Tests: computeBlame
// ============================================================================

describe('Blame - computeBlame', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsBinaryBlob.mockReturnValue(false);
  });

  // ---------------------------------------------------------------------------
  // 8.4-UNIT-001: Single-commit file — all lines attributed to that commit
  // ---------------------------------------------------------------------------

  it('[P1] single-commit file: all lines attributed to that commit (8.4-UNIT-001)', async () => {
    const commitSha = makeSha('c1');
    const treeSha = makeSha('t1');
    const blobSha = makeSha('b1');
    const fileContent = 'line one\nline two\nline three';

    // Commit resolution
    mockResolveGitSha.mockImplementation(async (sha) => {
      if (sha === commitSha) return 'tx-commit';
      if (sha === treeSha) return 'tx-tree';
      if (sha === blobSha) return 'tx-blob';
      return null;
    });

    mockFetchArweaveObject.mockImplementation(async (txId) => {
      if (txId === 'tx-commit') return textToBytes('commit-data');
      if (txId === 'tx-tree') return textToBytes('tree-data');
      if (txId === 'tx-blob') return textToBytes(fileContent);
      return null;
    });

    mockParseGitCommit.mockReturnValue({
      treeSha,
      parentShas: [], // root commit
      author: 'Alice <alice@example.com> 1700000000 +0000',
      committer: 'Alice <alice@example.com> 1700000000 +0000',
      message: 'Initial commit',
    });

    mockParseGitTree.mockReturnValue([
      { mode: '100644', name: 'file.ts', sha: blobSha },
    ]);

    const result = await computeBlame('file.ts', commitSha, 'test-repo');

    expect(result).not.toBeNull();
    expect(result!.lines).toHaveLength(3);
    expect(result!.fileContent).toBe(fileContent);
    expect(result!.beyondLimit).toBe(false);

    // All lines attributed to the single commit
    for (const line of result!.lines) {
      expect(line.commitSha).toBe(commitSha);
      expect(line.author).toBe('Alice <alice@example.com> 1700000000 +0000');
      expect(line.timestamp).toBe(1700000000);
    }

    // Line numbers are 1-based
    expect(result!.lines[0]!.lineNumber).toBe(1);
    expect(result!.lines[1]!.lineNumber).toBe(2);
    expect(result!.lines[2]!.lineNumber).toBe(3);
  });

  // ---------------------------------------------------------------------------
  // 8.4-UNIT-002: Multi-commit blame — lines attributed to correct commits
  // ---------------------------------------------------------------------------

  it('[P1] multi-commit blame: lines attributed to correct commits (8.4-UNIT-002)', async () => {
    const commitC = makeSha('c3'); // newest
    const commitB = makeSha('c2');
    const commitA = makeSha('c1'); // oldest (root)
    const treeShaC = makeSha('t3');
    const treeShaB = makeSha('t2');
    const treeShaA = makeSha('t1');
    const blobShaC = makeSha('b3'); // current file
    const blobShaB = makeSha('b2');
    const blobShaA = makeSha('b1');

    // File content at each commit:
    // Commit A (root): "line A1\nline A2"
    // Commit B: "line B1\nline B2\nline A2"  (modified line 1, added line 2, kept A2)
    // Commit C: "line B1\nline B2\nline C3\nline C4" (kept B1/B2, changed line 3, added line 4)
    const contentC = 'line B1\nline B2\nline C3\nline C4';
    const contentB = 'line B1\nline B2\nline A2';
    const contentA = 'line A1\nline A2';

    mockResolveGitSha.mockImplementation(async (sha) => {
      const map: Record<string, string> = {
        [commitC]: 'tx-cC',
        [commitB]: 'tx-cB',
        [commitA]: 'tx-cA',
        [treeShaC]: 'tx-tC',
        [treeShaB]: 'tx-tB',
        [treeShaA]: 'tx-tA',
        [blobShaC]: 'tx-bC',
        [blobShaB]: 'tx-bB',
        [blobShaA]: 'tx-bA',
      };
      return map[sha] ?? null;
    });

    mockFetchArweaveObject.mockImplementation(async (txId) => {
      const map: Record<string, string> = {
        'tx-cC': 'commit-C',
        'tx-cB': 'commit-B',
        'tx-cA': 'commit-A',
        'tx-tC': 'tree-C',
        'tx-tB': 'tree-B',
        'tx-tA': 'tree-A',
        'tx-bC': contentC,
        'tx-bB': contentB,
        'tx-bA': contentA,
      };
      return map[txId] ? textToBytes(map[txId]!) : null;
    });

    mockParseGitCommit.mockImplementation((data) => {
      const text = new TextDecoder().decode(data);
      if (text === 'commit-C') {
        return {
          treeSha: treeShaC,
          parentShas: [commitB],
          author: 'Carol <carol@example.com> 1700003000 +0000',
          committer: 'Carol <carol@example.com> 1700003000 +0000',
          message: 'Commit C',
        };
      }
      if (text === 'commit-B') {
        return {
          treeSha: treeShaB,
          parentShas: [commitA],
          author: 'Bob <bob@example.com> 1700002000 +0000',
          committer: 'Bob <bob@example.com> 1700002000 +0000',
          message: 'Commit B',
        };
      }
      if (text === 'commit-A') {
        return {
          treeSha: treeShaA,
          parentShas: [],
          author: 'Alice <alice@example.com> 1700001000 +0000',
          committer: 'Alice <alice@example.com> 1700001000 +0000',
          message: 'Commit A',
        };
      }
      return null;
    });

    mockParseGitTree.mockImplementation((data) => {
      const text = new TextDecoder().decode(data);
      if (text === 'tree-C') {
        return [{ mode: '100644', name: 'file.ts', sha: blobShaC }];
      }
      if (text === 'tree-B') {
        return [{ mode: '100644', name: 'file.ts', sha: blobShaB }];
      }
      if (text === 'tree-A') {
        return [{ mode: '100644', name: 'file.ts', sha: blobShaA }];
      }
      return [];
    });

    const result = await computeBlame('file.ts', commitC, 'test-repo');

    expect(result).not.toBeNull();
    expect(result!.lines).toHaveLength(4);
    expect(result!.beyondLimit).toBe(false);

    // line 1 "line B1" — exists in commit B's content but not in commit A's, so attributed to B
    // line 2 "line B2" — same as above, attributed to B
    // line 3 "line C3" — not in commit B's content, attributed to C
    // line 4 "line C4" — not in commit B's content, attributed to C
    expect(result!.lines[0]!.commitSha).toBe(commitB);
    expect(result!.lines[1]!.commitSha).toBe(commitB);
    expect(result!.lines[2]!.commitSha).toBe(commitC);
    expect(result!.lines[3]!.commitSha).toBe(commitC);
  });

  // ---------------------------------------------------------------------------
  // 8.4-UNIT-003: Depth limit — remaining lines attributed to oldest, beyondLimit true
  // ---------------------------------------------------------------------------

  it('[P1] depth limit reached: remaining lines use oldest commit, beyondLimit true (8.4-UNIT-003)', async () => {
    const commitB = makeSha('c2'); // newest
    const commitA = makeSha('c1'); // has parent but we limit depth to 1
    const treeShaB = makeSha('t2');
    const treeShaA = makeSha('t1');
    const blobShaB = makeSha('b2');
    const blobShaA = makeSha('b1');
    const parentOfA = makeSha('c0');

    const contentB = 'new line\nold line';
    const contentA = 'old line';

    mockResolveGitSha.mockImplementation(async (sha) => {
      const map: Record<string, string> = {
        [commitB]: 'tx-cB',
        [commitA]: 'tx-cA',
        [treeShaB]: 'tx-tB',
        [treeShaA]: 'tx-tA',
        [blobShaB]: 'tx-bB',
        [blobShaA]: 'tx-bA',
      };
      return map[sha] ?? null;
    });

    mockFetchArweaveObject.mockImplementation(async (txId) => {
      const map: Record<string, string> = {
        'tx-cB': 'commit-B',
        'tx-cA': 'commit-A',
        'tx-tB': 'tree-B',
        'tx-tA': 'tree-A',
        'tx-bB': contentB,
        'tx-bA': contentA,
      };
      return map[txId] ? textToBytes(map[txId]!) : null;
    });

    mockParseGitCommit.mockImplementation((data) => {
      const text = new TextDecoder().decode(data);
      if (text === 'commit-B') {
        return {
          treeSha: treeShaB,
          parentShas: [commitA],
          author: 'Bob <bob@example.com> 1700002000 +0000',
          committer: 'Bob <bob@example.com> 1700002000 +0000',
          message: 'Commit B',
        };
      }
      if (text === 'commit-A') {
        return {
          treeSha: treeShaA,
          parentShas: [parentOfA], // has a parent but we won't resolve it
          author: 'Alice <alice@example.com> 1700001000 +0000',
          committer: 'Alice <alice@example.com> 1700001000 +0000',
          message: 'Commit A',
        };
      }
      return null;
    });

    mockParseGitTree.mockImplementation((data) => {
      const text = new TextDecoder().decode(data);
      if (text === 'tree-B') {
        return [{ mode: '100644', name: 'file.ts', sha: blobShaB }];
      }
      if (text === 'tree-A') {
        return [{ mode: '100644', name: 'file.ts', sha: blobShaA }];
      }
      return [];
    });

    // maxDepth = 1 means we only walk 1 commit before hitting the limit
    const result = await computeBlame('file.ts', commitB, 'test-repo', 1);

    expect(result).not.toBeNull();
    expect(result!.lines).toHaveLength(2);
    expect(result!.beyondLimit).toBe(true);

    // "new line" not in parent content -> attributed to commitB
    expect(result!.lines[0]!.commitSha).toBe(commitB);
    // "old line" exists in parent but depth limit prevents further walk
    // -> attributed to oldest walked commit (commitB since depth=1 means we only process commitB)
    expect(result!.lines[1]!.commitSha).toBe(commitB);
  });

  // ---------------------------------------------------------------------------
  // Binary file returns BlameError with reason 'binary'
  // ---------------------------------------------------------------------------

  it('[P1] binary file returns BlameError with reason binary', async () => {
    const commitSha = makeSha('c1');
    const treeSha = makeSha('t1');
    const blobSha = makeSha('b1');

    mockResolveGitSha.mockImplementation(async (sha) => {
      if (sha === commitSha) return 'tx-commit';
      if (sha === treeSha) return 'tx-tree';
      if (sha === blobSha) return 'tx-blob';
      return null;
    });

    mockFetchArweaveObject.mockImplementation(async (txId) => {
      if (txId === 'tx-commit') return textToBytes('commit');
      if (txId === 'tx-tree') return textToBytes('tree');
      if (txId === 'tx-blob') return new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
      return null;
    });

    mockParseGitCommit.mockReturnValue({
      treeSha,
      parentShas: [],
      author: 'Test <test@test.com> 1700000000 +0000',
      committer: 'Test <test@test.com> 1700000000 +0000',
      message: 'test',
    });

    mockParseGitTree.mockReturnValue([
      { mode: '100644', name: 'image.png', sha: blobSha },
    ]);

    mockIsBinaryBlob.mockReturnValue(true);

    const result = await computeBlame('image.png', commitSha, 'test-repo');
    expect(isBlameError(result)).toBe(true);
    if (isBlameError(result)) {
      expect(result.reason).toBe('binary');
    }
  });

  // ---------------------------------------------------------------------------
  // File not found in tree returns BlameError with reason 'not-found'
  // ---------------------------------------------------------------------------

  it('[P1] file not found in tree returns BlameError with reason not-found', async () => {
    const commitSha = makeSha('c1');
    const treeSha = makeSha('t1');

    mockResolveGitSha.mockImplementation(async (sha) => {
      if (sha === commitSha) return 'tx-commit';
      if (sha === treeSha) return 'tx-tree';
      return null;
    });

    mockFetchArweaveObject.mockImplementation(async (txId) => {
      if (txId === 'tx-commit') return textToBytes('commit');
      if (txId === 'tx-tree') return textToBytes('tree');
      return null;
    });

    mockParseGitCommit.mockReturnValue({
      treeSha,
      parentShas: [],
      author: 'Test <test@test.com> 1700000000 +0000',
      committer: 'Test <test@test.com> 1700000000 +0000',
      message: 'test',
    });

    mockParseGitTree.mockReturnValue([
      { mode: '100644', name: 'other.ts', sha: makeSha('xx') },
    ]);

    const result = await computeBlame('missing.ts', commitSha, 'test-repo');
    expect(isBlameError(result)).toBe(true);
    if (isBlameError(result)) {
      expect(result.reason).toBe('not-found');
    }
  });

  // ---------------------------------------------------------------------------
  // Root commit (no parent) — all lines attributed to root
  // ---------------------------------------------------------------------------

  it('[P1] root commit: all lines attributed to root commit', async () => {
    const commitSha = makeSha('c1');
    const treeSha = makeSha('t1');
    const blobSha = makeSha('b1');
    const content = 'first\nsecond';

    mockResolveGitSha.mockImplementation(async (sha) => {
      if (sha === commitSha) return 'tx-c';
      if (sha === treeSha) return 'tx-t';
      if (sha === blobSha) return 'tx-b';
      return null;
    });

    mockFetchArweaveObject.mockImplementation(async (txId) => {
      if (txId === 'tx-c') return textToBytes('commit');
      if (txId === 'tx-t') return textToBytes('tree');
      if (txId === 'tx-b') return textToBytes(content);
      return null;
    });

    mockParseGitCommit.mockReturnValue({
      treeSha,
      parentShas: [],
      author: 'Root <root@example.com> 1700000000 +0000',
      committer: 'Root <root@example.com> 1700000000 +0000',
      message: 'root',
    });

    mockParseGitTree.mockReturnValue([
      { mode: '100644', name: 'file.ts', sha: blobSha },
    ]);

    const result = await computeBlame('file.ts', commitSha, 'test-repo');

    expect(result).not.toBeNull();
    expect(result!.lines).toHaveLength(2);
    expect(result!.beyondLimit).toBe(false);
    expect(result!.lines[0]!.commitSha).toBe(commitSha);
    expect(result!.lines[1]!.commitSha).toBe(commitSha);
  });

  // ---------------------------------------------------------------------------
  // Empty file — valid blame with zero lines
  // ---------------------------------------------------------------------------

  it('[P2] empty file returns valid blame with zero lines', async () => {
    const commitSha = makeSha('c1');
    const treeSha = makeSha('t1');
    const blobSha = makeSha('b1');

    mockResolveGitSha.mockImplementation(async (sha) => {
      if (sha === commitSha) return 'tx-commit';
      if (sha === treeSha) return 'tx-tree';
      if (sha === blobSha) return 'tx-blob';
      return null;
    });

    mockFetchArweaveObject.mockImplementation(async (txId) => {
      if (txId === 'tx-commit') return textToBytes('commit-data');
      if (txId === 'tx-tree') return textToBytes('tree-data');
      if (txId === 'tx-blob') return textToBytes('');
      return null;
    });

    mockParseGitCommit.mockReturnValue({
      treeSha,
      parentShas: [],
      author: 'Alice <alice@example.com> 1700000000 +0000',
      committer: 'Alice <alice@example.com> 1700000000 +0000',
      message: 'Add empty file',
    });

    mockParseGitTree.mockReturnValue([
      { mode: '100644', name: 'empty.ts', sha: blobSha },
    ]);

    const result = await computeBlame('empty.ts', commitSha, 'test-repo');

    expect(result).not.toBeNull();
    expect(result!.lines).toHaveLength(0);
    expect(result!.fileContent).toBe('');
    expect(result!.beyondLimit).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // File added in non-root commit — all lines attributed to that commit
  // ---------------------------------------------------------------------------

  it('[P1] file added in non-root commit: all lines attributed to adding commit', async () => {
    const commitB = makeSha('c2'); // newest, file exists here
    const commitA = makeSha('c1'); // root, file does NOT exist
    const treeShaB = makeSha('t2');
    const treeShaA = makeSha('t1');
    const blobShaB = makeSha('b2');

    const contentB = 'new line 1\nnew line 2';

    mockResolveGitSha.mockImplementation(async (sha) => {
      const map: Record<string, string> = {
        [commitB]: 'tx-cB',
        [commitA]: 'tx-cA',
        [treeShaB]: 'tx-tB',
        [treeShaA]: 'tx-tA',
        [blobShaB]: 'tx-bB',
      };
      return map[sha] ?? null;
    });

    mockFetchArweaveObject.mockImplementation(async (txId) => {
      const map: Record<string, string> = {
        'tx-cB': 'commit-B',
        'tx-cA': 'commit-A',
        'tx-tB': 'tree-B',
        'tx-tA': 'tree-A',
        'tx-bB': contentB,
      };
      return map[txId] ? textToBytes(map[txId]!) : null;
    });

    mockParseGitCommit.mockImplementation((data) => {
      const text = new TextDecoder().decode(data);
      if (text === 'commit-B') {
        return {
          treeSha: treeShaB,
          parentShas: [commitA],
          author: 'Bob <bob@example.com> 1700002000 +0000',
          committer: 'Bob <bob@example.com> 1700002000 +0000',
          message: 'Add file',
        };
      }
      if (text === 'commit-A') {
        return {
          treeSha: treeShaA,
          parentShas: [],
          author: 'Alice <alice@example.com> 1700001000 +0000',
          committer: 'Alice <alice@example.com> 1700001000 +0000',
          message: 'Initial',
        };
      }
      return null;
    });

    mockParseGitTree.mockImplementation((data) => {
      const text = new TextDecoder().decode(data);
      if (text === 'tree-B') {
        return [{ mode: '100644', name: 'file.ts', sha: blobShaB }];
      }
      if (text === 'tree-A') {
        // File does NOT exist in parent tree
        return [{ mode: '100644', name: 'other.ts', sha: makeSha('xx') }];
      }
      return [];
    });

    const result = await computeBlame('file.ts', commitB, 'test-repo');

    expect(result).not.toBeNull();
    expect(result!.lines).toHaveLength(2);
    expect(result!.beyondLimit).toBe(false);
    // All lines attributed to commitB (the commit that added the file)
    expect(result!.lines[0]!.commitSha).toBe(commitB);
    expect(result!.lines[1]!.commitSha).toBe(commitB);
    expect(result!.lines[0]!.author).toBe(
      'Bob <bob@example.com> 1700002000 +0000'
    );
  });

  // ---------------------------------------------------------------------------
  // Blob SHA unchanged — commit is skipped
  // ---------------------------------------------------------------------------

  it('[P2] skips commits where the file blob SHA is unchanged', async () => {
    const commitC = makeSha('c3'); // newest
    const commitB = makeSha('c2'); // no change to file
    const commitA = makeSha('c1'); // root
    const treeShaC = makeSha('t3');
    const treeShaB = makeSha('t2');
    const treeShaA = makeSha('t1');
    const blobSha = makeSha('b1'); // same blob SHA in C and B
    const blobShaA = makeSha('ba'); // different in A

    const content = 'line one\nline two';
    const contentA = 'old line';

    mockResolveGitSha.mockImplementation(async (sha) => {
      const map: Record<string, string> = {
        [commitC]: 'tx-cC',
        [commitB]: 'tx-cB',
        [commitA]: 'tx-cA',
        [treeShaC]: 'tx-tC',
        [treeShaB]: 'tx-tB',
        [treeShaA]: 'tx-tA',
        [blobSha]: 'tx-blob',
        [blobShaA]: 'tx-blobA',
      };
      return map[sha] ?? null;
    });

    mockFetchArweaveObject.mockImplementation(async (txId) => {
      const map: Record<string, string> = {
        'tx-cC': 'commit-C',
        'tx-cB': 'commit-B',
        'tx-cA': 'commit-A',
        'tx-tC': 'tree-C',
        'tx-tB': 'tree-B',
        'tx-tA': 'tree-A',
        'tx-blob': content,
        'tx-blobA': contentA,
      };
      return map[txId] ? textToBytes(map[txId]!) : null;
    });

    mockParseGitCommit.mockImplementation((data) => {
      const text = new TextDecoder().decode(data);
      if (text === 'commit-C') {
        return {
          treeSha: treeShaC,
          parentShas: [commitB],
          author: 'Carol <carol@example.com> 1700003000 +0000',
          committer: 'Carol <carol@example.com> 1700003000 +0000',
          message: 'No file change',
        };
      }
      if (text === 'commit-B') {
        return {
          treeSha: treeShaB,
          parentShas: [commitA],
          author: 'Bob <bob@example.com> 1700002000 +0000',
          committer: 'Bob <bob@example.com> 1700002000 +0000',
          message: 'Modified file',
        };
      }
      if (text === 'commit-A') {
        return {
          treeSha: treeShaA,
          parentShas: [],
          author: 'Alice <alice@example.com> 1700001000 +0000',
          committer: 'Alice <alice@example.com> 1700001000 +0000',
          message: 'Initial',
        };
      }
      return null;
    });

    mockParseGitTree.mockImplementation((data) => {
      const text = new TextDecoder().decode(data);
      if (text === 'tree-C') {
        return [{ mode: '100644', name: 'file.ts', sha: blobSha }];
      }
      if (text === 'tree-B') {
        // Same blob SHA as C — file unchanged in commit C
        return [{ mode: '100644', name: 'file.ts', sha: blobSha }];
      }
      if (text === 'tree-A') {
        return [{ mode: '100644', name: 'file.ts', sha: blobShaA }];
      }
      return [];
    });

    const result = await computeBlame('file.ts', commitC, 'test-repo');

    expect(result).not.toBeNull();
    expect(result!.lines).toHaveLength(2);
    // "line one" not in contentA ("old line") -> attributed to B (not C, since C didn't change the file)
    // "line two" not in contentA -> attributed to B
    expect(result!.lines[0]!.commitSha).toBe(commitB);
    expect(result!.lines[1]!.commitSha).toBe(commitB);
  });

  // ---------------------------------------------------------------------------
  // Start commit SHA unresolvable — returns null
  // ---------------------------------------------------------------------------

  it('[P2] returns null when start commit SHA cannot be resolved', async () => {
    mockResolveGitSha.mockResolvedValue(null);

    const result = await computeBlame('file.ts', makeSha('c1'), 'test-repo');
    expect(result).toBeNull();
  });
});
