// @vitest-environment jsdom
// Test IDs: 8.3-UNIT-007
// AC covered: #12

import { describe, it, expect } from 'vitest';

import { computeUnifiedDiff } from './unified-diff.js';

describe('Unified Diff - computeUnifiedDiff', () => {
  // ---------------------------------------------------------------------------
  // 8.3-UNIT-007
  // ---------------------------------------------------------------------------

  it('[P1] identical texts produce zero hunks', () => {
    const text = 'line one\nline two\nline three';

    const result = computeUnifiedDiff(text, text);

    expect(result).toHaveLength(0);
  });

  it('[P1] single line added produces one hunk with correct line numbers', () => {
    const oldText = 'line one\nline two';
    const newText = 'line one\nline inserted\nline two';

    const result = computeUnifiedDiff(oldText, newText);

    expect(result.length).toBeGreaterThanOrEqual(1);

    // Find the hunk containing the addition
    const addLines = result.flatMap((h) =>
      h.lines.filter((l) => l.type === 'add')
    );
    expect(addLines.length).toBeGreaterThanOrEqual(1);
    expect(addLines.some((l) => l.content === 'line inserted')).toBe(true);
  });

  it('[P1] single line deleted produces correct hunk', () => {
    const oldText = 'line one\nline to remove\nline two';
    const newText = 'line one\nline two';

    const result = computeUnifiedDiff(oldText, newText);

    expect(result.length).toBeGreaterThanOrEqual(1);

    const deleteLines = result.flatMap((h) =>
      h.lines.filter((l) => l.type === 'delete')
    );
    expect(deleteLines.length).toBeGreaterThanOrEqual(1);
    expect(deleteLines.some((l) => l.content === 'line to remove')).toBe(true);
  });

  it('[P1] modification in the middle produces context lines around change', () => {
    const oldText = 'a\nb\nc\nd\ne\nf\ng';
    const newText = 'a\nb\nc\nX\ne\nf\ng';

    const result = computeUnifiedDiff(oldText, newText, 2);

    expect(result.length).toBeGreaterThanOrEqual(1);

    // Should have context lines around the change
    const allLines = result.flatMap((h) => h.lines);
    const contextLines = allLines.filter((l) => l.type === 'context');
    expect(contextLines.length).toBeGreaterThanOrEqual(2);

    // Should have the delete and add
    const delLines = allLines.filter((l) => l.type === 'delete');
    const addLines = allLines.filter((l) => l.type === 'add');
    expect(delLines.some((l) => l.content === 'd')).toBe(true);
    expect(addLines.some((l) => l.content === 'X')).toBe(true);
  });

  it('[P1] large file (>10000 lines) returns placeholder hunk', () => {
    const bigText = Array.from({ length: 10001 }, (_, i) => `line ${i}`).join(
      '\n'
    );
    const smallText = 'hello';

    const result = computeUnifiedDiff(bigText, smallText);

    expect(result).toHaveLength(1);
    expect(result[0]!.lines).toHaveLength(1);
    expect(result[0]!.lines[0]!.content).toContain('too large');
  });

  it('[P1] two large files whose product exceeds LCS limit returns placeholder hunk', () => {
    // Two 5001-line files: 5001 * 5001 = 25,010,001 > 25,000,000 limit
    const bigOld = Array.from({ length: 5001 }, (_, i) => `old ${i}`).join(
      '\n'
    );
    const bigNew = Array.from({ length: 5001 }, (_, i) => `new ${i}`).join(
      '\n'
    );

    const result = computeUnifiedDiff(bigOld, bigNew);

    expect(result).toHaveLength(1);
    expect(result[0]!.lines).toHaveLength(1);
    expect(result[0]!.lines[0]!.content).toContain('too large');
  });

  it('[P2] empty old text (all additions) produces hunks', () => {
    const result = computeUnifiedDiff('', 'new line one\nnew line two');

    expect(result.length).toBeGreaterThanOrEqual(1);
    const addLines = result.flatMap((h) =>
      h.lines.filter((l) => l.type === 'add')
    );
    expect(addLines.length).toBeGreaterThanOrEqual(1);
  });

  it('[P2] empty new text (all deletions) produces hunks', () => {
    const result = computeUnifiedDiff('old line one\nold line two', '');

    expect(result.length).toBeGreaterThanOrEqual(1);
    const delLines = result.flatMap((h) =>
      h.lines.filter((l) => l.type === 'delete')
    );
    expect(delLines.length).toBeGreaterThanOrEqual(1);
  });

  it('[P2] hunks have correct oldStart/newStart/oldCount/newCount', () => {
    const oldText = 'a\nb\nc';
    const newText = 'a\nX\nc';

    const result = computeUnifiedDiff(oldText, newText, 1);

    expect(result.length).toBeGreaterThanOrEqual(1);
    const hunk = result[0]!;
    expect(hunk.oldStart).toBeGreaterThanOrEqual(1);
    expect(hunk.newStart).toBeGreaterThanOrEqual(1);
    expect(hunk.oldCount).toBeGreaterThanOrEqual(1);
    expect(hunk.newCount).toBeGreaterThanOrEqual(1);
  });

  it('[P2] completely different texts produce hunks with all deletes and all adds', () => {
    const oldText = 'alpha\nbeta\ngamma';
    const newText = 'one\ntwo\nthree';

    const result = computeUnifiedDiff(oldText, newText);

    expect(result.length).toBeGreaterThanOrEqual(1);

    const allLines = result.flatMap((h) => h.lines);
    const delLines = allLines.filter((l) => l.type === 'delete');
    const addLines = allLines.filter((l) => l.type === 'add');
    expect(delLines).toHaveLength(3);
    expect(addLines).toHaveLength(3);
    expect(delLines.map((l) => l.content)).toEqual(['alpha', 'beta', 'gamma']);
    expect(addLines.map((l) => l.content)).toEqual(['one', 'two', 'three']);
  });

  it('[P2] both empty texts produce zero hunks', () => {
    const result = computeUnifiedDiff('', '');

    expect(result).toHaveLength(0);
  });

  it('[P2] multiple changes produce separate hunks when far apart', () => {
    // Build texts with a change at the beginning and end, separated by >6 context lines
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    const oldText = lines.join('\n');
    const newLines = [...lines];
    newLines[0] = 'CHANGED-FIRST';
    newLines[19] = 'CHANGED-LAST';
    const newText = newLines.join('\n');

    const result = computeUnifiedDiff(oldText, newText, 3);

    // Should produce 2 separate hunks since changes are far apart
    expect(result.length).toBe(2);
  });
});
