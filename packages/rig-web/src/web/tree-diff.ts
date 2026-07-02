/**
 * Tree-to-tree diff computation for Rig-UI.
 *
 * Compares two git tree entry arrays and produces a flat diff
 * (one level only, no recursive subdirectory expansion).
 */

import type { TreeEntry } from './git-objects.js';

/**
 * A single entry in a tree diff result.
 */
export interface TreeDiffEntry {
  /** Change status */
  status: 'added' | 'deleted' | 'modified';
  /** File or directory name */
  name: string;
  /** SHA from the old (parent) tree, if applicable */
  oldSha?: string;
  /** SHA from the new (current) tree, if applicable */
  newSha?: string;
  /** File mode from the new tree (or old tree for deletions) */
  mode: string;
}

/**
 * Compute a flat tree-to-tree diff.
 *
 * Comparison is by name + SHA: same name with different SHA = modified,
 * name only in new = added, name only in old = deleted, same name +
 * same SHA = unchanged (omitted).
 *
 * Result is sorted: deleted first, then modified, then added.
 * Within each group, entries are sorted alphabetically by name.
 *
 * Does NOT recursively expand subdirectories — directory entries with
 * different SHAs are reported as 'modified'.
 *
 * @param oldEntries - Tree entries from the parent commit (empty array for root commits)
 * @param newEntries - Tree entries from the current commit
 * @returns Array of TreeDiffEntry describing changes
 */
export function diffTrees(
  oldEntries: TreeEntry[],
  newEntries: TreeEntry[]
): TreeDiffEntry[] {
  const oldMap = new Map<string, TreeEntry>();
  for (const entry of oldEntries) {
    oldMap.set(entry.name, entry);
  }

  const newMap = new Map<string, TreeEntry>();
  for (const entry of newEntries) {
    newMap.set(entry.name, entry);
  }

  const result: TreeDiffEntry[] = [];

  // Find deleted and modified entries
  for (const [name, oldEntry] of oldMap) {
    const newEntry = newMap.get(name);
    if (!newEntry) {
      result.push({
        status: 'deleted',
        name,
        oldSha: oldEntry.sha,
        mode: oldEntry.mode,
      });
    } else if (oldEntry.sha !== newEntry.sha) {
      result.push({
        status: 'modified',
        name,
        oldSha: oldEntry.sha,
        newSha: newEntry.sha,
        mode: newEntry.mode,
      });
    }
    // same SHA = unchanged, omitted
  }

  // Find added entries
  for (const [name, newEntry] of newMap) {
    if (!oldMap.has(name)) {
      result.push({
        status: 'added',
        name,
        newSha: newEntry.sha,
        mode: newEntry.mode,
      });
    }
  }

  // Sort: deleted first, then modified, then added; alphabetical within group
  const statusOrder: Record<string, number> = {
    deleted: 0,
    modified: 1,
    added: 2,
  };

  result.sort((a, b) => {
    const orderA = statusOrder[a.status] ?? 0;
    const orderB = statusOrder[b.status] ?? 0;
    if (orderA !== orderB) return orderA - orderB;
    return a.name.localeCompare(b.name);
  });

  return result;
}
