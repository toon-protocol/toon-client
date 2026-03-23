// @vitest-environment jsdom
// Test IDs: 8.3-UNIT-004, 8.3-UNIT-005, 8.3-UNIT-006
// AC covered: #7, #8, #9

import { describe, it, expect } from 'vitest';

import { diffTrees } from './tree-diff.js';
import type { TreeEntry } from './git-objects.js';

// ============================================================================
// Helpers
// ============================================================================

function entry(name: string, sha: string, mode = '100644'): TreeEntry {
  return { mode, name, sha };
}

// ============================================================================
// Tests
// ============================================================================

describe('Tree Diff - diffTrees', () => {
  // ---------------------------------------------------------------------------
  // 8.3-UNIT-005: Added file detected
  // ---------------------------------------------------------------------------

  it('[P1] detects added file (name in new, not in old) (8.3-UNIT-005)', () => {
    const oldEntries: TreeEntry[] = [];
    const newEntries: TreeEntry[] = [entry('new-file.ts', 'a'.repeat(40))];

    const result = diffTrees(oldEntries, newEntries);

    expect(result).toHaveLength(1);
    expect(result[0]!.status).toBe('added');
    expect(result[0]!.name).toBe('new-file.ts');
    expect(result[0]!.newSha).toBe('a'.repeat(40));
    expect(result[0]!.oldSha).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // 8.3-UNIT-005: Deleted file detected
  // ---------------------------------------------------------------------------

  it('[P1] detects deleted file (name in old, not in new) (8.3-UNIT-005)', () => {
    const oldEntries: TreeEntry[] = [entry('old-file.ts', 'b'.repeat(40))];
    const newEntries: TreeEntry[] = [];

    const result = diffTrees(oldEntries, newEntries);

    expect(result).toHaveLength(1);
    expect(result[0]!.status).toBe('deleted');
    expect(result[0]!.name).toBe('old-file.ts');
    expect(result[0]!.oldSha).toBe('b'.repeat(40));
    expect(result[0]!.newSha).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // 8.3-UNIT-004: Modified file detected
  // ---------------------------------------------------------------------------

  it('[P1] detects modified file (same name, different SHA) (8.3-UNIT-004)', () => {
    const oldEntries: TreeEntry[] = [entry('file.ts', 'a'.repeat(40))];
    const newEntries: TreeEntry[] = [entry('file.ts', 'b'.repeat(40))];

    const result = diffTrees(oldEntries, newEntries);

    expect(result).toHaveLength(1);
    expect(result[0]!.status).toBe('modified');
    expect(result[0]!.name).toBe('file.ts');
    expect(result[0]!.oldSha).toBe('a'.repeat(40));
    expect(result[0]!.newSha).toBe('b'.repeat(40));
  });

  it('[P1] unchanged file omitted from result (same name, same SHA)', () => {
    const sha = 'c'.repeat(40);
    const oldEntries: TreeEntry[] = [entry('unchanged.ts', sha)];
    const newEntries: TreeEntry[] = [entry('unchanged.ts', sha)];

    const result = diffTrees(oldEntries, newEntries);

    expect(result).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // 8.3-UNIT-006: Directory entry with different SHA
  // ---------------------------------------------------------------------------

  it('[P1] directory entry with different SHA reported as modified (8.3-UNIT-006)', () => {
    const oldEntries: TreeEntry[] = [entry('src', 'a'.repeat(40), '40000')];
    const newEntries: TreeEntry[] = [entry('src', 'b'.repeat(40), '40000')];

    const result = diffTrees(oldEntries, newEntries);

    expect(result).toHaveLength(1);
    expect(result[0]!.status).toBe('modified');
    expect(result[0]!.mode).toBe('40000');
  });

  it('[P2] result sorted: deleted, modified, added, alphabetical within group', () => {
    const oldEntries: TreeEntry[] = [
      entry('deleted-b.ts', 'a'.repeat(40)),
      entry('deleted-a.ts', 'b'.repeat(40)),
      entry('modified-b.ts', 'c'.repeat(40)),
      entry('modified-a.ts', 'd'.repeat(40)),
    ];
    const newEntries: TreeEntry[] = [
      entry('modified-b.ts', 'e'.repeat(40)),
      entry('modified-a.ts', 'f'.repeat(40)),
      entry('added-b.ts', 'a1'.repeat(20)),
      entry('added-a.ts', 'b1'.repeat(20)),
    ];

    const result = diffTrees(oldEntries, newEntries);

    expect(result).toHaveLength(6);
    // Deleted first, alphabetical
    expect(result[0]!.status).toBe('deleted');
    expect(result[0]!.name).toBe('deleted-a.ts');
    expect(result[1]!.status).toBe('deleted');
    expect(result[1]!.name).toBe('deleted-b.ts');
    // Modified next, alphabetical
    expect(result[2]!.status).toBe('modified');
    expect(result[2]!.name).toBe('modified-a.ts');
    expect(result[3]!.status).toBe('modified');
    expect(result[3]!.name).toBe('modified-b.ts');
    // Added last, alphabetical
    expect(result[4]!.status).toBe('added');
    expect(result[4]!.name).toBe('added-a.ts');
    expect(result[5]!.status).toBe('added');
    expect(result[5]!.name).toBe('added-b.ts');
  });

  it('[P2] empty old and new trees produce empty result', () => {
    const result = diffTrees([], []);
    expect(result).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // AC #9: Renamed file appears as one deleted + one added (no rename detection)
  // ---------------------------------------------------------------------------

  it('[P2] renamed file appears as deleted + added (no rename detection) (AC #9)', () => {
    const sha = 'a'.repeat(40);
    const oldEntries: TreeEntry[] = [entry('old-name.ts', sha)];
    const newEntries: TreeEntry[] = [entry('new-name.ts', sha)];

    const result = diffTrees(oldEntries, newEntries);

    expect(result).toHaveLength(2);
    const deleted = result.find((e) => e.status === 'deleted');
    const added = result.find((e) => e.status === 'added');
    expect(deleted).toBeDefined();
    expect(deleted!.name).toBe('old-name.ts');
    expect(added).toBeDefined();
    expect(added!.name).toBe('new-name.ts');
    // No 'modified' or 'renamed' status
    expect(result.every((e) => e.status !== 'modified')).toBe(true);
  });
});
