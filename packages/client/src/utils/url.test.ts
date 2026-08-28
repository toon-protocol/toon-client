/**
 * The trailing-slash trim, including the shape that made its regex predecessor
 * quadratic (`js/polynomial-redos`, CodeQL, PR #619).
 */
import { describe, it, expect } from 'vitest';
import { trimTrailingSlashes } from './url.js';

describe('trimTrailingSlashes', () => {
  it.each([
    ['https://node.example', 'https://node.example'],
    ['https://node.example/', 'https://node.example'],
    ['https://node.example///', 'https://node.example'],
    ['/ilp/', '/ilp'],
    ['/', ''],
    ['///', ''],
    ['', ''],
    ['https://node.example/a//b', 'https://node.example/a//b'],
  ])('%j -> %j', (input, expected) => {
    expect(trimTrailingSlashes(input)).toBe(expected);
  });

  it('stays linear on a long run of slashes that does not end in one', () => {
    // The adversarial shape: the old `/\/+$/` retried the run from every
    // position, so this input cost O(n²). A budget rather than an exact timing,
    // because the point is the difference between linear and quadratic.
    const hostile = `${'/'.repeat(200_000)}x`;
    const started = Date.now();
    expect(trimTrailingSlashes(hostile)).toBe(hostile);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
