import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { threadAtoms } from './thread-view.js';
import { type AtomRenderProps } from './types.js';
import { type DisplayModeControl } from '../surface.js';
import { type NostrEvent } from '../types.js';

afterEach(cleanup);

const ThreadView = threadAtoms.find((a) => a.id === 'thread-view')!.Component;

/** A kind:1 note, optionally a reply marked with NIP-10 root/reply `e` tags. */
const note = (
  id: string,
  content: string,
  refs?: { root?: string; reply?: string }
): NostrEvent => {
  const tags: string[][] = [];
  if (refs?.root) tags.push(['e', refs.root, '', 'root']);
  if (refs?.reply) tags.push(['e', refs.reply, '', 'reply']);
  return { id, created_at: 1000, kind: 1, pubkey: 'a'.repeat(64), tags, content, sig: 's' } as NostrEvent;
};

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

describe('thread-view (inline)', () => {
  it('shows the root, caps direct replies at 3, and hides the overflow inline', () => {
    const events = [
      note('root', 'the root note'),
      note('r1', 'reply one', { root: 'root', reply: 'root' }),
      note('r2', 'reply two', { root: 'root', reply: 'root' }),
      note('r3', 'reply three', { root: 'root', reply: 'root' }),
      note('r4', 'reply four', { root: 'root', reply: 'root' }),
    ];
    render(<ThreadView {...baseProps({ events })} />);
    expect(screen.getByText('the root note')).toBeTruthy();
    expect(screen.getByText('reply one')).toBeTruthy();
    expect(screen.getByText('reply three')).toBeTruthy();
    // The 4th direct reply spills past the inline cap.
    expect(screen.queryByText('reply four')).toBeNull();
  });

  it('offers "View full thread" only when fullscreen is available and requests it', () => {
    const events = [
      note('root', 'the root note'),
      note('r1', 'reply one', { root: 'root', reply: 'root' }),
    ];
    // Inline-only host: no escalation offered.
    const { unmount } = render(<ThreadView {...baseProps({ events, surface: surface({}) })} />);
    expect(screen.queryByRole('button', { name: /view full thread/i })).toBeNull();
    unmount();

    const request = vi.fn(async () => {});
    render(
      <ThreadView
        {...baseProps({
          events,
          surface: surface({ available: ['inline', 'fullscreen'], canFullscreen: true, request }),
        })}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /view full thread/i }));
    expect(request).toHaveBeenCalledWith('fullscreen');
  });

  it('renders the direct parent above a focused reply', () => {
    const events = [
      note('root', 'the root note'),
      note('r1', 'a focused reply', { root: 'root', reply: 'root' }),
    ];
    render(<ThreadView {...baseProps({ events, props: { focusId: 'r1' } })} />);
    // Parent (root) shown for context alongside the focused reply.
    expect(screen.getByText('the root note')).toBeTruthy();
    expect(screen.getByText('a focused reply')).toBeTruthy();
  });
});

describe('thread-view (fullscreen reply tree)', () => {
  it('caps indentation depth and collapses deeper replies to "continue thread"', () => {
    // A linear chain root → c1 → c2 → c3 → c4 → c5 (depths 0..5).
    const events = [
      note('root', 'depth 0'),
      note('c1', 'depth 1', { root: 'root', reply: 'root' }),
      note('c2', 'depth 2', { root: 'root', reply: 'c1' }),
      note('c3', 'depth 3', { root: 'root', reply: 'c2' }),
      note('c4', 'depth 4', { root: 'root', reply: 'c3' }),
      note('c5', 'depth 5', { root: 'root', reply: 'c4' }),
    ];
    render(
      <ThreadView
        {...baseProps({
          events,
          surface: surface({ mode: 'fullscreen', available: ['inline', 'fullscreen'], canFullscreen: true }),
        })}
      />
    );
    // The chain renders down to the cap, then collapses (c4/c5 hidden).
    expect(screen.getByText('depth 3')).toBeTruthy();
    expect(screen.queryByText('depth 4')).toBeNull();
    expect(screen.queryByText('depth 5')).toBeNull();
    const cont = screen.getByRole('button', { name: /continue thread \(2\)/i });
    expect(cont).toBeTruthy();
    // Continuing re-roots the sub-conversation at the margin.
    fireEvent.click(cont);
    expect(screen.getByText('depth 4')).toBeTruthy();
    expect(screen.getByText('depth 5')).toBeTruthy();
  });
});
