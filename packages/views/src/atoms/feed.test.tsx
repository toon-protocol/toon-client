import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { feedAtoms } from './feed.js';
import { type AtomRenderProps } from './types.js';
import { type NostrEvent } from '../types.js';

afterEach(cleanup);

const FeedList = feedAtoms.find((a) => a.id === 'feed-list')!.Component;

const note = (id: string, created_at: number, content = `note ${id}`): NostrEvent =>
  ({ id, created_at, kind: 1, pubkey: 'a'.repeat(64), tags: [], content, sig: 's' }) as NostrEvent;

const baseProps = (over: Partial<AtomRenderProps>): AtomRenderProps => ({
  events: [],
  props: {},
  actions: {},
  children: null,
  renderEvent: () => null,
  ...over,
});

/** 12 notes, newest-first by created_at (n0 newest … n11 oldest). */
const twelve = (): NostrEvent[] => Array.from({ length: 12 }, (_, i) => note(`n${i}`, 1200 - i * 100));

describe('feed-list (paginated)', () => {
  it('renders an empty state with no events', () => {
    render(<FeedList {...baseProps({ events: [] })} />);
    expect(screen.getByText(/no posts yet/i)).toBeTruthy();
  });

  it('shows one bounded page (5) of the bound notes', () => {
    render(<FeedList {...baseProps({ events: twelve() })} />);
    expect(screen.getAllByText(/^note n\d+$/)).toHaveLength(5);
    expect(screen.getByText('note n0')).toBeTruthy();
    expect(screen.queryByText('note n5')).toBeNull(); // on the next page
  });

  it('"Older" REPLACES the page (no growth → no internal scroll)', () => {
    render(<FeedList {...baseProps({ events: twelve() })} />);
    fireEvent.click(screen.getByRole('button', { name: /older/i }));
    // Still only one page rendered; the first page's notes are gone, not appended.
    expect(screen.getAllByText(/^note n\d+$/)).toHaveLength(5);
    expect(screen.queryByText('note n0')).toBeNull();
    expect(screen.getByText('note n5')).toBeTruthy();
    expect(screen.getByText('6–10')).toBeTruthy(); // page indicator
  });

  it('"Newer" pages back', () => {
    render(<FeedList {...baseProps({ events: twelve() })} />);
    fireEvent.click(screen.getByRole('button', { name: /older/i }));
    fireEvent.click(screen.getByRole('button', { name: /newer/i }));
    expect(screen.getByText('note n0')).toBeTruthy();
    expect(screen.getByText('1–5')).toBeTruthy();
    expect(screen.getByRole('button', { name: /newer/i })).toHaveProperty('disabled', true);
  });

  it('fetches an older page via `until` when the loaded notes run out', async () => {
    const events = Array.from({ length: 5 }, (_, i) => note(`n${i}`, 500 - i * 100));
    const loadMore = vi.fn(async () => [note('old1', 50), note('old2', 40)]);
    render(<FeedList {...baseProps({ events, bind: { query: { kinds: [1] } }, loadMore })} />);
    fireEvent.click(screen.getByRole('button', { name: /older/i }));
    await waitFor(() => expect(screen.getByText('note old1')).toBeTruthy());
    // Queried for notes older than the oldest loaded (created_at 100 → until 99).
    expect(loadMore).toHaveBeenCalledWith(expect.objectContaining({ until: 99, limit: 5 }));
    expect(screen.queryByText('note n0')).toBeNull(); // replaced, not appended
  });

  it('disables "Older" once an older fetch returns nothing new', async () => {
    const events = Array.from({ length: 5 }, (_, i) => note(`n${i}`, 500 - i * 100));
    const loadMore = vi.fn(async () => []);
    render(<FeedList {...baseProps({ events, loadMore })} />);
    fireEvent.click(screen.getByRole('button', { name: /older/i }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /older/i })).toHaveProperty('disabled', true)
    );
  });
});
