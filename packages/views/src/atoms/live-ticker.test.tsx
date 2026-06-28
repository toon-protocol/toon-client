import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { liveTickerAtoms } from './live-ticker.js';
import { type AtomRenderProps } from './types.js';
import { type DisplayModeControl } from '../surface.js';
import { type NostrEvent } from '../types.js';

afterEach(cleanup);

const LiveTicker = liveTickerAtoms.find((a) => a.id === 'live-ticker')!.Component;

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

describe('live-ticker', () => {
  it('exposes the item list as a polite aria-live region', () => {
    render(<LiveTicker {...baseProps({ events: [note('n1', 300)] })} />);
    const region = screen.getByRole('list', { name: /new posts and mentions/i });
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(screen.getByText('note n1')).toBeTruthy();
  });

  it('offers a "Go live" PiP affordance when the host supports PiP', () => {
    const request = vi.fn(async () => {});
    render(
      <LiveTicker
        {...baseProps({
          events: [note('n1', 300)],
          surface: surface({ available: ['inline', 'pip'], canPip: true, request }),
        })}
      />
    );
    // PiP host: offers Go live, not Refresh.
    expect(screen.queryByRole('button', { name: /refresh/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /go live/i }));
    expect(request).toHaveBeenCalledWith('pip');
  });

  it('degrades to an inline Refresh on a host without PiP, re-querying the base filter', async () => {
    const loadMore = vi.fn((_filter: Record<string, unknown>) => Promise.resolve([note('n2', 400)]));
    render(
      <LiveTicker
        {...baseProps({
          events: [note('n1', 300)],
          bind: { query: { kinds: [1] } },
          loadMore,
          surface: surface({}),
        })}
      />
    );
    // Inline-only host: no Go live, a Refresh instead.
    expect(screen.queryByRole('button', { name: /go live/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));
    await waitFor(() => expect(screen.getByText('note n2')).toBeTruthy());
    // Re-queried the BASE filter (newest items), not an older `until` page.
    expect(loadMore).toHaveBeenCalledWith(expect.objectContaining({ kinds: [1] }));
    expect(loadMore.mock.calls[0]?.[0]).not.toHaveProperty('until');
  });
});
