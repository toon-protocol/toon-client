import { describe, it, expect } from 'vitest';
import { getActionName, getStageName, truncateBrainHash } from './pet-utils.js';

describe('[P1] getActionName', () => {
  it('returns Feed for actionType 0', () => {
    expect(getActionName(0)).toBe('Feed');
  });

  it('returns Play for actionType 1', () => {
    expect(getActionName(1)).toBe('Play');
  });

  it('returns Clean for actionType 2', () => {
    expect(getActionName(2)).toBe('Clean');
  });

  it('returns Rest for actionType 3', () => {
    expect(getActionName(3)).toBe('Rest');
  });

  it('returns Warm for actionType 4', () => {
    expect(getActionName(4)).toBe('Warm');
  });

  it('returns Check for actionType 5', () => {
    expect(getActionName(5)).toBe('Check');
  });

  it('returns Sing for actionType 6', () => {
    expect(getActionName(6)).toBe('Sing');
  });

  it('returns Talk for actionType 7', () => {
    expect(getActionName(7)).toBe('Talk');
  });

  it('returns Medicine for actionType 8', () => {
    expect(getActionName(8)).toBe('Medicine');
  });

  it('returns Cruzar for actionType 9', () => {
    expect(getActionName(9)).toBe('Cruzar');
  });

  it('returns PlayMusic for actionType 10', () => {
    expect(getActionName(10)).toBe('PlayMusic');
  });

  it('returns Unknown for out-of-range value 99', () => {
    expect(getActionName(99)).toBe('Unknown');
  });

  it('returns Unknown for negative actionType', () => {
    expect(getActionName(-1)).toBe('Unknown');
  });
});

describe('[P1] getStageName', () => {
  it('returns Egg for stage 0', () => {
    expect(getStageName(0)).toBe('Egg');
  });

  it('returns Baby for stage 1', () => {
    expect(getStageName(1)).toBe('Baby');
  });

  it('returns Adult for stage 2', () => {
    expect(getStageName(2)).toBe('Adult');
  });

  it('returns Unknown for out-of-range stage 5', () => {
    expect(getStageName(5)).toBe('Unknown');
  });

  it('returns Unknown for negative stage', () => {
    expect(getStageName(-1)).toBe('Unknown');
  });
});

describe('[P1] truncateBrainHash', () => {
  it('truncates a 64-char hash to first8...last4', () => {
    const hash = 'abcd1234' + '0'.repeat(52) + 'ef01';
    expect(truncateBrainHash(hash)).toBe('abcd1234...ef01');
  });

  it('truncates a 12-char hash (minimum boundary)', () => {
    expect(truncateBrainHash('abcdefgh1234')).toBe('abcdefgh...1234');
  });

  it('returns ... for hash shorter than 12 chars', () => {
    expect(truncateBrainHash('short')).toBe('...');
  });

  it('returns ... for empty string', () => {
    expect(truncateBrainHash('')).toBe('...');
  });

  it('handles exactly 11 chars (below threshold)', () => {
    expect(truncateBrainHash('abcdefghijk')).toBe('...');
  });
});
