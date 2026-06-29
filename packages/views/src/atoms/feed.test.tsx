import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { feedAtoms } from './feed.js';
import { type AtomRenderProps } from './types.js';
import { type DisplayModeControl } from '../surface.js';
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

const surface = (over: Partial<DisplayModeControl>): DisplayModeControl => ({
  mode: 'inline',
  available: [],
  canFullscreen: false,
  canPip: false,
  request: vi.fn(async () => {}),
  ...over,
});

describe('feed-list', () => {
  it('renders an empty state with no events', () => {
    render(<FeedList {...baseProps({ events: [] })} />);
    expect(screen.getByText(/no posts yet/i)).toBeTruthy();
  });

  it('caps the inline render and reveals the rest on "Load more" (no fetch)', async () => {
    // 9 bound notes, inline cap is 6 → only 6 render until "Load more".
    const events = Array.from({ length: 9 }, (_, i) => note(`n${i}`, 900 - i * 100));
    const loadMore = vi.fn(async () => []);
    render(<FeedList {...baseProps({ events, loadMore })} />);
    expect(screen.getAllByText(/^note n\d$/)).toHaveLength(6);
    fireEvent.click(screen.getByRole('button', { name: /load more/i }));
    // Revealed from already-loaded notes — no network fetch needed.
    await waitFor(() => expect(screen.getAllByText(/^note n\d$/)).toHaveLength(9));
    expect(loadMore).not.toHaveBeenCalled();
  });

  it('pages backward via `until` and appends, de-duping overlaps', async () => {
    // The next page overlaps on n1 (already shown) and adds n3.
    const loadMore = vi.fn(async () => [note('n1', 300), note('n3', 100)]);
    render(
      <FeedList
        {...baseProps({
          events: [note('n1', 300), note('n2', 200)],
          bind: { query: { kinds: [1] } },
          loadMore,
        })}
      />
    );
    expect(screen.getByText('note n2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /load more/i }));
    await waitFor(() => expect(screen.getByText('note n3')).toBeTruthy());
    // Queried for everything older than the oldest shown (200) → until 199.
    expect(loadMore).toHaveBeenCalledWith(expect.objectContaining({ until: 199, limit: 5 }));
    // The overlapping n1 is not duplicated.
    expect(screen.getAllByText('note n1')).toHaveLength(1);
  });

  it('stops offering "Load more" once a page returns nothing new', async () => {
    const loadMore = vi.fn(async () => []);
    render(<FeedList {...baseProps({ events: [note('n1', 300)], loadMore })} />);
    fireEvent.click(screen.getByRole('button', { name: /load more/i }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /load more/i })).toBeNull()
    );
  });

  it('offers "Open timeline" only when fullscreen is available, and requests it', () => {
    const request = vi.fn(async () => {});
    render(
      <FeedList
        {...baseProps({
          events: [note('n1', 300)],
          surface: surface({ available: ['inline', 'fullscreen'], canFullscreen: true, request }),
        })}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /open timeline/i }));
    expect(request).toHaveBeenCalledWith('fullscreen');
  });

  it('hides "Open timeline" on an inline-only host', () => {
    render(<FeedList {...baseProps({ events: [note('n1', 300)], surface: surface({}) })} />);
    expect(screen.queryByRole('button', { name: /open timeline/i })).toBeNull();
  });
});
