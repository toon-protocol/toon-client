import { describe, it, expect } from 'vitest';
import { nextPageFilter, mergePage } from './paging.js';
import { type NostrEvent } from './types.js';

const evt = (id: string, created_at: number): NostrEvent =>
  ({ id, created_at, kind: 1, pubkey: 'p', tags: [], content: '', sig: 's' }) as NostrEvent;

describe('nextPageFilter', () => {
  it('returns the base filter unchanged for the first page (no events)', () => {
    expect(nextPageFilter([], { kinds: [1] })).toEqual({ kinds: [1] });
  });

  it('pins `until` just before the oldest event held', () => {
    const events = [evt('a', 300), evt('b', 100), evt('c', 200)];
    expect(nextPageFilter(events, { kinds: [1] })).toEqual({ kinds: [1], until: 99 });
  });

  it('preserves the rest of the base filter', () => {
    const events = [evt('a', 500)];
    expect(nextPageFilter(events, { kinds: [1], authors: ['x'], limit: 5 })).toEqual({
      kinds: [1],
      authors: ['x'],
      limit: 5,
      until: 499,
    });
  });
});

describe('mergePage', () => {
  it('appends older events newest-first', () => {
    const existing = [evt('a', 300), evt('b', 200)];
    const page = [evt('c', 150), evt('d', 100)];
    expect(mergePage(existing, page).map((e) => e.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('de-dupes by id (an overlapping page never duplicates)', () => {
    const existing = [evt('a', 300), evt('b', 200)];
    const page = [evt('b', 200), evt('c', 100)];
    expect(mergePage(existing, page).map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });
});
