// @vitest-environment jsdom
// Test IDs: 8.3-UNIT (date-utils)
// AC covered: #5

import { describe, it, expect, vi, afterEach } from 'vitest';

import { formatRelativeDate } from './date-utils.js';

describe('Date Utils - formatRelativeDate', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('[P2] returns "just now" for timestamp 30 seconds ago', () => {
    vi.useFakeTimers();
    const now = 1700000000;
    vi.setSystemTime(now * 1000);

    expect(formatRelativeDate(now - 30)).toBe('just now');
  });

  it('[P2] returns "1 minute ago" for timestamp 60 seconds ago', () => {
    vi.useFakeTimers();
    const now = 1700000000;
    vi.setSystemTime(now * 1000);

    expect(formatRelativeDate(now - 60)).toBe('1 minute ago');
  });

  it('[P2] returns "5 minutes ago" for timestamp 300 seconds ago', () => {
    vi.useFakeTimers();
    const now = 1700000000;
    vi.setSystemTime(now * 1000);

    expect(formatRelativeDate(now - 300)).toBe('5 minutes ago');
  });

  it('[P2] returns "2 hours ago" for timestamp 7200 seconds ago', () => {
    vi.useFakeTimers();
    const now = 1700000000;
    vi.setSystemTime(now * 1000);

    expect(formatRelativeDate(now - 7200)).toBe('2 hours ago');
  });

  it('[P2] returns "3 days ago" for timestamp 3 days ago', () => {
    vi.useFakeTimers();
    const now = 1700000000;
    vi.setSystemTime(now * 1000);

    expect(formatRelativeDate(now - 3 * 86400)).toBe('3 days ago');
  });

  it('[P2] returns "2 months ago" for timestamp ~60 days ago', () => {
    vi.useFakeTimers();
    const now = 1700000000;
    vi.setSystemTime(now * 1000);

    expect(formatRelativeDate(now - 60 * 86400)).toBe('2 months ago');
  });

  it('[P2] returns "1 year ago" for timestamp ~365 days ago', () => {
    vi.useFakeTimers();
    const now = 1700000000;
    vi.setSystemTime(now * 1000);

    expect(formatRelativeDate(now - 365 * 86400)).toBe('1 year ago');
  });

  it('[P2] returns "2 years ago" for timestamp ~730 days ago', () => {
    vi.useFakeTimers();
    const now = 1700000000;
    vi.setSystemTime(now * 1000);

    expect(formatRelativeDate(now - 730 * 86400)).toBe('2 years ago');
  });

  it('[P2] returns "1 hour ago" for timestamp 3600 seconds ago', () => {
    vi.useFakeTimers();
    const now = 1700000000;
    vi.setSystemTime(now * 1000);

    expect(formatRelativeDate(now - 3600)).toBe('1 hour ago');
  });

  it('[P2] returns "1 day ago" for timestamp 86400 seconds ago', () => {
    vi.useFakeTimers();
    const now = 1700000000;
    vi.setSystemTime(now * 1000);

    expect(formatRelativeDate(now - 86400)).toBe('1 day ago');
  });

  it('[P2] returns "1 month ago" for timestamp ~30 days ago', () => {
    vi.useFakeTimers();
    const now = 1700000000;
    vi.setSystemTime(now * 1000);

    expect(formatRelativeDate(now - 30 * 86400)).toBe('1 month ago');
  });

  it('[P2] boundary: 59 seconds returns "just now" (under 1 minute)', () => {
    vi.useFakeTimers();
    const now = 1700000000;
    vi.setSystemTime(now * 1000);

    expect(formatRelativeDate(now - 59)).toBe('just now');
  });

  it('[P2] future timestamp (clock skew) returns "just now"', () => {
    vi.useFakeTimers();
    const now = 1700000000;
    vi.setSystemTime(now * 1000);

    // Timestamp 100 seconds in the future
    expect(formatRelativeDate(now + 100)).toBe('just now');
  });
});
