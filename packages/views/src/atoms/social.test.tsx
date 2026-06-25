import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { type NostrEvent } from '../types.js';
import { socialAtoms } from './social.js';
import { avatarColorsFor, byteLength, initialsFor, relativeTime } from './social-ui.js';

afterEach(cleanup);

function evt(partial: Partial<NostrEvent> & { kind: number }): NostrEvent {
  return {
    id: partial.id ?? 'id',
    pubkey: partial.pubkey ?? 'pk',
    created_at: partial.created_at ?? 1,
    kind: partial.kind,
    tags: partial.tags ?? [],
    content: partial.content ?? '',
    sig: partial.sig ?? 'sig',
  };
}

const NoteCard = socialAtoms.find((a) => a.id === 'note-card')!.Component;

const defaultProps = {
  props: {},
  actions: {},
  children: null,
  renderEvent: () => null,
};

describe('NoteCard — NIP-92 inline media rendering', () => {
  it('renders note text without media when no imeta tags are present', () => {
    const { container } = render(
      <NoteCard {...defaultProps} events={[evt({ kind: 1, content: 'hello world' })]} />
    );
    expect(screen.getByText('hello world')).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('video')).toBeNull();
  });

  it('renders a single imeta image inline beneath the note text', () => {
    const { container } = render(
      <NoteCard
        {...defaultProps}
        events={[
          evt({
            kind: 1,
            content: 'see pic',
            tags: [['imeta', 'url https://ar/img.png', 'm image/png', 'alt sunset']],
          }),
        ]}
      />
    );
    expect(screen.getByText('see pic')).toBeTruthy();
    const img = container.querySelector('img');
    expect(img).toBeTruthy();
    expect(img?.getAttribute('src')).toBe('https://ar/img.png');
    expect(img?.getAttribute('alt')).toBe('sunset');
  });

  it('renders multiple imeta attachments in order', () => {
    const { container } = render(
      <NoteCard
        {...defaultProps}
        events={[
          evt({
            kind: 1,
            content: 'two pics',
            tags: [
              ['imeta', 'url https://ar/a.png', 'm image/png'],
              ['imeta', 'url https://ar/b.png', 'm image/png'],
            ],
          }),
        ]}
      />
    );
    const imgs = container.querySelectorAll('img');
    expect(imgs).toHaveLength(2);
    expect(imgs[0]?.getAttribute('src')).toBe('https://ar/a.png');
    expect(imgs[1]?.getAttribute('src')).toBe('https://ar/b.png');
  });

  it('renders a video attachment with controls', () => {
    const { container } = render(
      <NoteCard
        {...defaultProps}
        events={[
          evt({
            kind: 1,
            content: 'watch this',
            tags: [['imeta', 'url https://ar/clip.mp4', 'm video/mp4']],
          }),
        ]}
      />
    );
    const video = container.querySelector('video');
    expect(video).toBeTruthy();
    expect(video?.getAttribute('src')).toBe('https://ar/clip.mp4');
    expect(video?.hasAttribute('controls')).toBe(true);
  });

  it('renders nothing for a non-kind-1 event', () => {
    const { container } = render(
      <NoteCard {...defaultProps} events={[evt({ kind: 0, content: '{}' })]} />
    );
    expect(container.firstChild).toBeNull();
  });
});

describe('NoteCard — feed presentation', () => {
  it('shows an avatar fallback with npub initials when no profile is present', () => {
    render(
      <NoteCard
        {...defaultProps}
        events={[evt({ kind: 1, content: 'hi', pubkey: 'npub1abcdef' })]}
      />
    );
    // initials derived from the pubkey (strips npub1 prefix → "AB")
    expect(screen.getByText('AB')).toBeTruthy();
  });

  it('joins a kind:0 profile to show the display name instead of the npub', () => {
    const profile = evt({
      kind: 0,
      pubkey: 'author-pk',
      content: JSON.stringify({ display_name: 'Satoshi', picture: 'https://x/p.png' }),
    });
    const note = evt({ kind: 1, id: 'n1', pubkey: 'author-pk', content: 'gm' });
    render(<NoteCard {...defaultProps} events={[profile, note]} />);
    // Real display name replaces the mono npub in the header.
    expect(screen.getByText('Satoshi')).toBeTruthy();
    // The kind:0 event is not rendered as a note body, only joined for identity.
    expect(screen.queryByText('{')).toBeNull();
  });

  it('renders a relative timestamp for the note', () => {
    const now = 1_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
    render(
      <NoteCard
        {...defaultProps}
        events={[evt({ kind: 1, content: 'old', created_at: now - 3 * 3600 })]}
      />
    );
    expect(screen.getByText('3h')).toBeTruthy();
    vi.restoreAllMocks();
  });

  it('fires the Like (heart) action with the reaction content', () => {
    const react = vi.fn();
    render(
      <NoteCard
        {...defaultProps}
        actions={{ react }}
        events={[evt({ kind: 1, id: 'note-9', content: 'react to me' })]}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /like this note/i }));
    // "React" is surfaced to the user as "Like" but still fires the `react` action;
    // the targeted note's NIP-25 e/p tags come from the runtime's base args.
    expect(react).toHaveBeenCalledWith({ content: '+' });
  });

  it('Reply opens an inline composer and publishes the typed reply body', () => {
    const reply = vi.fn();
    render(
      <NoteCard
        {...defaultProps}
        actions={{ reply }}
        events={[evt({ kind: 1, id: 'note-9', pubkey: 'author-pk', content: 'reply to me' })]}
      />
    );
    // The Reply button toggles the composer rather than publishing an empty note.
    expect(screen.queryByLabelText('Reply text')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /reply to this note/i }));
    const box = screen.getByLabelText('Reply text');
    fireEvent.change(box, { target: { value: 'nice post' } });
    fireEvent.click(screen.getByRole('button', { name: /^reply$/i }));
    // Body goes as a runtime arg; the kind:1 e/p reply tags come from base args.
    expect(reply).toHaveBeenCalledWith({ content: 'nice post', parentId: 'note-9' });
  });

  it('shows the like (reaction) count from kind:7 events targeting the note', () => {
    const note = evt({ kind: 1, id: 'note-x', content: 'popular' });
    const r1 = evt({ kind: 7, id: 'r1', content: '+', tags: [['e', 'note-x']] });
    const r2 = evt({ kind: 7, id: 'r2', content: '🔥', tags: [['e', 'note-x']] });
    render(<NoteCard {...defaultProps} actions={{ react: vi.fn() }} events={[note, r1, r2]} />);
    const likeBtn = screen.getByRole('button', { name: /like this note/i });
    expect(likeBtn.textContent).toContain('2');
  });

  it('toggles the heart optimistically and bumps the count on like', () => {
    const note = evt({ kind: 1, id: 'note-x', content: 'popular' });
    const r1 = evt({ kind: 7, id: 'r1', content: '+', tags: [['e', 'note-x']] });
    render(<NoteCard {...defaultProps} actions={{ react: vi.fn() }} events={[note, r1]} />);
    const likeBtn = screen.getByRole('button', { name: /like this note/i });
    expect(likeBtn.getAttribute('aria-pressed')).toBe('false');
    expect(likeBtn.textContent).toContain('1');
    fireEvent.click(likeBtn);
    const liked = screen.getByRole('button', { name: /liked this note/i });
    expect(liked.getAttribute('aria-pressed')).toBe('true');
    expect(liked.textContent).toContain('2');
  });

  it('renders a Follow button that publishes a kind:3 follow of the author', () => {
    const follow = vi.fn();
    render(
      <NoteCard
        {...defaultProps}
        actions={{ follow }}
        events={[evt({ kind: 1, id: 'note-7', pubkey: 'author-pk', content: 'gm' })]}
      />
    );
    const followBtn = screen.getByRole('button', { name: /follow this author/i });
    fireEvent.click(followBtn);
    // The component supplies the author's pubkey as a `p` tag; the runtime merges
    // it over the spec's static kind:3 publish args (NIP-02 follow list).
    expect(follow).toHaveBeenCalledWith({ tags: [['p', 'author-pk']] });
    // Optimistic toggle flips the label to "Following".
    expect(screen.getByRole('button', { name: /following this author/i })).toBeTruthy();
  });

  it('omits the engagement footer when no actions are wired', () => {
    render(<NoteCard {...defaultProps} events={[evt({ kind: 1, content: 'static' })]} />);
    expect(screen.queryByRole('button', { name: /reply/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /like this note/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /follow this author/i })).toBeNull();
  });
});

describe('social-ui helpers', () => {
  it('initialsFor strips the npub prefix and uppercases two chars', () => {
    expect(initialsFor('npub1qwerty')).toBe('QW');
    expect(initialsFor('rawpubkey')).toBe('RA');
  });

  it('avatarColorsFor is deterministic per pubkey and varies across pubkeys', () => {
    expect(avatarColorsFor('pk-a')).toEqual(avatarColorsFor('pk-a'));
    expect(avatarColorsFor('pk-a').from).not.toBe(avatarColorsFor('pk-b').from);
  });

  it('relativeTime renders compact buckets', () => {
    const now = 2_000_000_000;
    const nowMs = now * 1000;
    expect(relativeTime(now - 10, nowMs)).toBe('now');
    expect(relativeTime(now - 5 * 60, nowMs)).toBe('5m');
    expect(relativeTime(now - 2 * 3600, nowMs)).toBe('2h');
    expect(relativeTime(now - 4 * 86400, nowMs)).toBe('4d');
  });

  it('byteLength counts UTF-8 bytes, not characters', () => {
    expect(byteLength('abc')).toBe(3);
    expect(byteLength('é')).toBe(2);
    expect(byteLength('🚀')).toBe(4);
  });
});
