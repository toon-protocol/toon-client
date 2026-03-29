/* eslint-disable @typescript-eslint/no-non-null-assertion -- safe array-index accesses after bounds checks throughout */
/**
 * Unified diff algorithm for Rig-UI.
 *
 * Computes a unified diff between two text strings using a
 * longest-common-subsequence (LCS) approach. No external diff libraries.
 */

/**
 * A single line in a diff hunk.
 */
export interface DiffLine {
  /** Line type: context (unchanged), add (new), delete (removed) */
  type: 'context' | 'add' | 'delete';
  /** Line content (without newline) */
  content: string;
}

/**
 * A hunk in a unified diff.
 */
export interface DiffHunk {
  /** Starting line number in the old file (1-based) */
  oldStart: number;
  /** Number of lines from the old file in this hunk */
  oldCount: number;
  /** Starting line number in the new file (1-based) */
  newStart: number;
  /** Number of lines from the new file in this hunk */
  newCount: number;
  /** Lines in this hunk */
  lines: DiffLine[];
}

/** Maximum line count for inline diff (performance guard). */
const MAX_DIFF_LINES = 10000;

/**
 * Maximum product of old lines * new lines for LCS computation.
 * Prevents browser OOM when both files are large (e.g., two 9,999-line files
 * would create a ~100M-entry 2D array consuming ~800MB of memory).
 */
const MAX_LCS_PRODUCT = 25_000_000;

/**
 * Compute a unified diff between two text strings.
 *
 * Uses an LCS-based line diff algorithm. Groups changes into hunks
 * with the specified number of context lines around each change.
 *
 * Performance guard: if either text exceeds 10,000 lines, returns a
 * single placeholder hunk instead of computing the diff.
 *
 * @param oldText - Original text content
 * @param newText - Modified text content
 * @param contextLines - Number of context lines around each change (default 3)
 * @returns Array of DiffHunk describing changes
 */
export function computeUnifiedDiff(
  oldText: string,
  newText: string,
  contextLines = 3
): DiffHunk[] {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');

  // Performance guard: per-file line count
  if (oldLines.length > MAX_DIFF_LINES || newLines.length > MAX_DIFF_LINES) {
    return [
      {
        oldStart: 1,
        oldCount: 0,
        newStart: 1,
        newCount: 0,
        lines: [{ type: 'context', content: 'File too large for inline diff' }],
      },
    ];
  }

  // Performance guard: LCS table size (prevents browser OOM when both files are large)
  if (oldLines.length * newLines.length > MAX_LCS_PRODUCT) {
    return [
      {
        oldStart: 1,
        oldCount: 0,
        newStart: 1,
        newCount: 0,
        lines: [{ type: 'context', content: 'File too large for inline diff' }],
      },
    ];
  }

  // Compute LCS table
  const lcs = computeLCS(oldLines, newLines);

  // Build edit script from LCS
  const editScript = buildEditScript(oldLines, newLines, lcs);

  // If no changes, return empty
  if (editScript.every((e) => e.type === 'context')) {
    return [];
  }

  // Group into hunks with context
  return groupIntoHunks(editScript, contextLines);
}

interface EditEntry {
  type: 'context' | 'add' | 'delete';
  content: string;
  oldLineNo: number; // 1-based, 0 if not applicable
  newLineNo: number; // 1-based, 0 if not applicable
}

/**
 * Compute LCS length table using dynamic programming.
 * Returns a 2D array where lcs[i][j] = length of LCS of
 * oldLines[0..i-1] and newLines[0..j-1].
 */
function computeLCS(oldLines: string[], newLines: string[]): number[][] {
  const m = oldLines.length;
  const n = newLines.length;
  const table: number[][] = [];

  for (let i = 0; i <= m; i++) {
    table[i] = new Array<number>(n + 1).fill(0);
  }

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        table[i]![j] = table[i - 1]![j - 1]! + 1;
      } else {
        table[i]![j] = Math.max(table[i - 1]![j]!, table[i]![j - 1]!);
      }
    }
  }

  return table;
}

/**
 * Build an edit script by backtracking through the LCS table.
 */
function buildEditScript(
  oldLines: string[],
  newLines: string[],
  lcs: number[][]
): EditEntry[] {
  const result: EditEntry[] = [];
  let i = oldLines.length;
  let j = newLines.length;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.push({
        type: 'context',
        content: oldLines[i - 1]!,
        oldLineNo: i,
        newLineNo: j,
      });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || lcs[i]![j - 1]! >= lcs[i - 1]![j]!)) {
      result.push({
        type: 'add',
        content: newLines[j - 1]!,
        oldLineNo: 0,
        newLineNo: j,
      });
      j--;
    } else if (i > 0) {
      result.push({
        type: 'delete',
        content: oldLines[i - 1]!,
        oldLineNo: i,
        newLineNo: 0,
      });
      i--;
    }
  }

  result.reverse();
  return result;
}

/**
 * Group an edit script into unified diff hunks with context lines.
 */
function groupIntoHunks(
  editScript: EditEntry[],
  contextLines: number
): DiffHunk[] {
  // Find indices of all change lines
  const changeIndices: number[] = [];
  for (let i = 0; i < editScript.length; i++) {
    if (editScript[i]!.type !== 'context') {
      changeIndices.push(i);
    }
  }

  if (changeIndices.length === 0) return [];

  // Build ranges: each change expands to include context lines
  const ranges: { start: number; end: number }[] = [];
  for (const idx of changeIndices) {
    const start = Math.max(0, idx - contextLines);
    const end = Math.min(editScript.length - 1, idx + contextLines);

    // Merge with previous range if overlapping
    const prev = ranges[ranges.length - 1];
    if (prev && start <= prev.end + 1) {
      prev.end = Math.max(prev.end, end);
    } else {
      ranges.push({ start, end });
    }
  }

  // Convert ranges to hunks
  const hunks: DiffHunk[] = [];
  for (const range of ranges) {
    const lines: DiffLine[] = [];
    let oldStart = 0;
    let newStart = 0;
    let oldCount = 0;
    let newCount = 0;

    for (let i = range.start; i <= range.end; i++) {
      const entry = editScript[i]!;
      lines.push({ type: entry.type, content: entry.content });

      if (entry.type === 'context') {
        if (oldStart === 0) oldStart = entry.oldLineNo;
        if (newStart === 0) newStart = entry.newLineNo;
        oldCount++;
        newCount++;
      } else if (entry.type === 'delete') {
        if (oldStart === 0) oldStart = entry.oldLineNo;
        oldCount++;
      } else if (entry.type === 'add') {
        if (newStart === 0) newStart = entry.newLineNo;
        newCount++;
      }
    }

    // If starts weren't set (edge case), derive from first entry
    if (oldStart === 0) {
      const firstOld = lines.findIndex(
        (_, idx) => editScript[range.start + idx]!.oldLineNo > 0
      );
      oldStart =
        firstOld >= 0 ? editScript[range.start + firstOld]!.oldLineNo : 1;
    }
    if (newStart === 0) {
      const firstNew = lines.findIndex(
        (_, idx) => editScript[range.start + idx]!.newLineNo > 0
      );
      newStart =
        firstNew >= 0 ? editScript[range.start + firstNew]!.newLineNo : 1;
    }

    hunks.push({ oldStart, oldCount, newStart, newCount, lines });
  }

  return hunks;
}
