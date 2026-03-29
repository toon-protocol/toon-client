// @vitest-environment jsdom
// Test IDs: 8.2-UNIT-001, 8.2-UNIT-002, 8.2-UNIT-003, 8.2-UNIT-004, 8.2-UNIT-005
// AC covered: #4, #5, #6, #7

import { describe, it, expect } from 'vitest';

import {
  parseGitTree,
  parseGitCommit,
  isBinaryBlob,
  parseAuthorIdent,
} from './git-objects.js';
import type { TreeEntry } from './git-objects.js';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Build a git tree object entry as raw bytes.
 * Format: <mode-ascii> <name-utf8>\0<20-byte-sha-binary>
 */
function buildTreeEntry(mode: string, name: string, shaHex: string): number[] {
  const bytes: number[] = [];
  // Mode as ASCII
  for (const ch of mode) {
    bytes.push(ch.charCodeAt(0));
  }
  // Space
  bytes.push(0x20);
  // Name as UTF-8
  const encoder = new TextEncoder();
  const nameBytes = encoder.encode(name);
  for (const b of nameBytes) {
    bytes.push(b);
  }
  // Null byte
  bytes.push(0x00);
  // SHA as 20 raw bytes
  for (let i = 0; i < 40; i += 2) {
    bytes.push(parseInt(shaHex.slice(i, i + 2), 16));
  }
  return bytes;
}

/**
 * Build a complete git tree object from entries.
 */
function buildTreeObject(
  entries: { mode: string; name: string; sha: string }[]
): Uint8Array {
  const allBytes: number[] = [];
  for (const entry of entries) {
    allBytes.push(...buildTreeEntry(entry.mode, entry.name, entry.sha));
  }
  return new Uint8Array(allBytes);
}

/**
 * Build a git commit object as raw bytes.
 */
function buildCommitObject(opts: {
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
    `author ${opts.author ?? 'Test User <test@example.com> 1700000000 +0000'}`
  );
  lines.push(
    `committer ${opts.committer ?? 'Test User <test@example.com> 1700000000 +0000'}`
  );
  lines.push('');
  lines.push(opts.message ?? 'Initial commit');
  const text = lines.join('\n');
  return new TextEncoder().encode(text);
}

// ============================================================================
// Tests
// ============================================================================

describe('Git Object Parsers - parseGitTree', () => {
  // ---------------------------------------------------------------------------
  // 8.2-UNIT-001: Valid tree bytes parsed to correct TreeEntry[]
  // AC: #4
  // ---------------------------------------------------------------------------

  it('[P1] parses valid tree bytes to correct TreeEntry[] with mode, name, sha', () => {
    // Arrange
    const sha1 = 'a'.repeat(40);
    const sha2 = 'b'.repeat(40);
    const data = buildTreeObject([
      { mode: '100644', name: 'README.md', sha: sha1 },
      { mode: '40000', name: 'src', sha: sha2 },
    ]);

    // Act
    const entries = parseGitTree(data);

    // Assert
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      mode: '100644',
      name: 'README.md',
      sha: sha1,
    });
    expect(entries[1]).toEqual({ mode: '40000', name: 'src', sha: sha2 });
  });

  it('[P1] parses executable file mode (100755)', () => {
    const sha = 'cd'.repeat(20);
    const data = buildTreeObject([{ mode: '100755', name: 'run.sh', sha }]);

    const entries = parseGitTree(data);

    expect(entries).toHaveLength(1);
    expect(entries[0]!.mode).toBe('100755');
    expect(entries[0]!.name).toBe('run.sh');
  });

  // ---------------------------------------------------------------------------
  // 8.2-UNIT-002: Edge cases
  // AC: #5
  // ---------------------------------------------------------------------------

  it('[P1] returns empty array for empty tree (0 bytes)', () => {
    const data = new Uint8Array(0);

    const entries = parseGitTree(data);

    expect(entries).toEqual([]);
  });

  it('[P1] handles unicode filenames', () => {
    const sha = 'ef'.repeat(20);
    const data = buildTreeObject([{ mode: '100644', name: 'файл.txt', sha }]);

    const entries = parseGitTree(data);

    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe('файл.txt');
  });

  it('[P1] handles symlink entries (mode 120000)', () => {
    const sha = '12'.repeat(20);
    const data = buildTreeObject([
      { mode: '120000', name: 'link-to-file', sha },
    ]);

    const entries = parseGitTree(data);

    expect(entries).toHaveLength(1);
    expect(entries[0]!.mode).toBe('120000');
    expect(entries[0]!.name).toBe('link-to-file');
  });

  it('[P1] handles submodule entries (mode 160000)', () => {
    const sha = '34'.repeat(20);
    const data = buildTreeObject([{ mode: '160000', name: 'submod', sha }]);

    const entries = parseGitTree(data);

    expect(entries).toHaveLength(1);
    expect(entries[0]!.mode).toBe('160000');
    expect(entries[0]!.name).toBe('submod');
  });

  it('[P2] handles mixed entry types in one tree', () => {
    const data = buildTreeObject([
      { mode: '40000', name: 'dir', sha: 'aa'.repeat(20) },
      { mode: '100644', name: 'file.txt', sha: 'bb'.repeat(20) },
      { mode: '120000', name: 'link', sha: 'cc'.repeat(20) },
      { mode: '160000', name: 'sub', sha: 'dd'.repeat(20) },
    ]);

    const entries = parseGitTree(data);

    expect(entries).toHaveLength(4);
    expect(entries.map((e: TreeEntry) => e.mode)).toEqual([
      '40000',
      '100644',
      '120000',
      '160000',
    ]);
  });
});

// ============================================================================
// Story 8.6: 8.6-UNIT-006 — Binary tree format validation
// AC: #6 (seed script uses `git cat-file tree` binary format)
// ============================================================================

describe('Git Object Parsers - 8.6-UNIT-006: Binary tree format', () => {
  it('[P1] parseGitTree expects binary format: <mode> <name>\\0<20-byte-sha>', () => {
    // AC #6: `git cat-file tree <sha>` produces binary format that parseGitTree expects.
    // This test validates the exact binary wire format: ASCII mode, space, UTF-8 name,
    // null byte, then 20 raw SHA-1 bytes (NOT hex-encoded).
    const sha = 'ab'.repeat(20);
    const data = buildTreeObject([{ mode: '100644', name: 'README.md', sha }]);

    // Verify the binary structure:
    // - Mode bytes are ASCII digits
    expect(data[0]).toBe(0x31); // '1'
    // - Space separator
    expect(data[6]).toBe(0x20); // ' '
    // - Null terminator after name
    const nullIndex = data.indexOf(0x00);
    expect(nullIndex).toBeGreaterThan(7);
    // - 20 raw bytes follow the null (not 40 hex chars)
    expect(data.length).toBe(nullIndex + 1 + 20);

    // parseGitTree successfully parses this binary format
    const entries = parseGitTree(data);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.mode).toBe('100644');
    expect(entries[0]!.name).toBe('README.md');
    expect(entries[0]!.sha).toBe(sha);
  });

  it('[P1] parseGitTree rejects human-readable format (git cat-file -p)', () => {
    // The human-readable format from `git cat-file -p` looks like:
    // "100644 blob <40-hex-sha>\tREADME.md\n"
    // parseGitTree should NOT parse this correctly — it expects binary.
    const humanReadable = new TextEncoder().encode(
      '100644 blob ' + 'ab'.repeat(20) + '\tREADME.md\n'
    );

    const entries = parseGitTree(humanReadable);

    // Human-readable format will either produce 0 entries or malformed entries
    // (mode won't be "100644" because "100644 blob ..." is parsed differently).
    // The key assertion: it does NOT produce a valid entry with name "README.md".
    const validEntries = entries.filter(
      (e) => e.name === 'README.md' && e.mode === '100644'
    );
    expect(validEntries).toHaveLength(0);
  });
});

describe('Git Object Parsers - parseGitCommit', () => {
  // ---------------------------------------------------------------------------
  // 8.2-UNIT-003: Valid commit bytes parsed to GitCommit
  // AC: #6
  // ---------------------------------------------------------------------------

  it('[P1] parses valid commit bytes to GitCommit with all fields', () => {
    const treeSha = 'ab'.repeat(20);
    const data = buildCommitObject({
      treeSha,
      author: 'Alice <alice@example.com> 1700000000 +0000',
      committer: 'Bob <bob@example.com> 1700000001 +0000',
      message: 'Add feature X',
    });

    const commit = parseGitCommit(data);

    expect(commit).not.toBeNull();
    expect(commit!.treeSha).toBe(treeSha);
    expect(commit!.parentShas).toEqual([]);
    expect(commit!.author).toBe('Alice <alice@example.com> 1700000000 +0000');
    expect(commit!.committer).toBe('Bob <bob@example.com> 1700000001 +0000');
    expect(commit!.message).toBe('Add feature X');
  });

  it('[P1] parses merge commit with multiple parent SHAs', () => {
    const treeSha = 'cd'.repeat(20);
    const parent1 = 'ef'.repeat(20);
    const parent2 = '12'.repeat(20);
    const data = buildCommitObject({
      treeSha,
      parentShas: [parent1, parent2],
      message: 'Merge branch develop',
    });

    const commit = parseGitCommit(data);

    expect(commit).not.toBeNull();
    expect(commit!.parentShas).toEqual([parent1, parent2]);
  });

  it('[P2] returns null for malformed commit (no blank line separator)', () => {
    const data = new TextEncoder().encode('tree abc\nauthor test');

    const commit = parseGitCommit(data);

    expect(commit).toBeNull();
  });

  it('[P2] returns null for commit missing tree header', () => {
    const data = new TextEncoder().encode('parent abc\nauthor test\n\nmessage');

    const commit = parseGitCommit(data);

    expect(commit).toBeNull();
  });

  it('[P2] parses commit with multi-line message containing blank lines', () => {
    const treeSha = 'ab'.repeat(20);
    const message = 'First line\n\nSecond paragraph\n\nThird paragraph';
    const data = buildCommitObject({
      treeSha,
      message,
    });

    const commit = parseGitCommit(data);

    expect(commit).not.toBeNull();
    expect(commit!.treeSha).toBe(treeSha);
    // Only the first \n\n should separate headers from message;
    // subsequent blank lines are part of the message body.
    expect(commit!.message).toBe(message);
  });
});

describe('Git Object Parsers - isBinaryBlob', () => {
  // ---------------------------------------------------------------------------
  // 8.2-UNIT-004: UTF-8 text blob detected as non-binary
  // AC: #7
  // ---------------------------------------------------------------------------

  it('[P1] detects UTF-8 text blob as non-binary', () => {
    const data = new TextEncoder().encode(
      'Hello, world!\nThis is a text file.\n'
    );

    expect(isBinaryBlob(data)).toBe(false);
  });

  it('[P1] detects source code as non-binary', () => {
    const data = new TextEncoder().encode(
      'function hello() {\n  console.log("hi");\n}\n'
    );

    expect(isBinaryBlob(data)).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // 8.2-UNIT-005: Bytes containing null character detected as binary
  // AC: #7
  // ---------------------------------------------------------------------------

  it('[P1] detects bytes with null character as binary', () => {
    const data = new Uint8Array([0x48, 0x65, 0x6c, 0x00, 0x6c, 0x6f]);

    expect(isBinaryBlob(data)).toBe(true);
  });

  it('[P1] detects high non-printable ratio as binary', () => {
    // 50% non-printable bytes (well above 30% threshold)
    const data = new Uint8Array(100);
    for (let i = 0; i < 100; i++) {
      data[i] = i % 2 === 0 ? 0x80 : 0x41; // alternating non-printable and 'A'
    }

    expect(isBinaryBlob(data)).toBe(true);
  });

  it('[P2] detects empty data as non-binary', () => {
    const data = new Uint8Array(0);

    expect(isBinaryBlob(data)).toBe(false);
  });

  it('[P2] handles data with tabs and newlines as non-binary', () => {
    const data = new Uint8Array([0x09, 0x0a, 0x0d, 0x20, 0x41, 0x42]);

    expect(isBinaryBlob(data)).toBe(false);
  });

  it('[P2] exactly 30% non-printable is not binary (threshold is >30%)', () => {
    // 100 bytes, exactly 30 non-printable (0x80) and 70 printable ('A')
    const data = new Uint8Array(100);
    for (let i = 0; i < 30; i++) {
      data[i] = 0x80; // non-printable
    }
    for (let i = 30; i < 100; i++) {
      data[i] = 0x41; // 'A' — printable
    }

    // 30/100 = 0.3, which is NOT > 0.3, so should be false
    expect(isBinaryBlob(data)).toBe(false);
  });

  it('[P2] just above 30% non-printable is binary', () => {
    // 100 bytes, 31 non-printable and 69 printable
    const data = new Uint8Array(100);
    for (let i = 0; i < 31; i++) {
      data[i] = 0x80;
    }
    for (let i = 31; i < 100; i++) {
      data[i] = 0x41;
    }

    // 31/100 = 0.31 > 0.3, so should be true
    expect(isBinaryBlob(data)).toBe(true);
  });
});

// ============================================================================
// Story 8.3 Tests - parseAuthorIdent
// AC covered: #5
// ============================================================================

describe('Git Object Parsers - parseAuthorIdent', () => {
  it('[P1] parses valid author string to AuthorIdent', () => {
    const result = parseAuthorIdent(
      'Alice <alice@example.com> 1711234567 +0000'
    );

    expect(result).not.toBeNull();
    expect(result!.name).toBe('Alice');
    expect(result!.email).toBe('alice@example.com');
    expect(result!.timestamp).toBe(1711234567);
    expect(result!.timezone).toBe('+0000');
  });

  it('[P1] parses author with multi-word name', () => {
    const result = parseAuthorIdent(
      'Alice Bob <alice@example.com> 1700000000 -0500'
    );

    expect(result).not.toBeNull();
    expect(result!.name).toBe('Alice Bob');
    expect(result!.timezone).toBe('-0500');
  });

  it('[P2] returns null for malformed author string', () => {
    expect(parseAuthorIdent('malformed string')).toBeNull();
    expect(parseAuthorIdent('')).toBeNull();
    expect(parseAuthorIdent('Name <email>')).toBeNull();
    expect(parseAuthorIdent('Name <email> notanumber +0000')).toBeNull();
  });

  it('[P2] parses author with special characters in name', () => {
    const result = parseAuthorIdent(
      "O'Brien <obrien@example.com> 1700000000 +0100"
    );

    expect(result).not.toBeNull();
    expect(result!.name).toBe("O'Brien");
  });
});
