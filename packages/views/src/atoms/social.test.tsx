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

  it('lazily resolves an author kind:0 via resolveProfile when none is in the bind', async () => {
    const profileEvent = evt({
      kind: 0,
      pubkey: 'author-pk',
      content: JSON.stringify({ display_name: 'Nakamoto', picture: 'https://x/p.png' }),
    });
    const resolveProfile = vi.fn().mockResolvedValue(profileEvent);
    const note = evt({ kind: 1, id: 'n1', pubkey: 'author-pk', content: 'gm' });
    // Feed bind carries only the kind:1 note — no kind:0 to join from `events`.
    render(<NoteCard {...defaultProps} resolveProfile={resolveProfile} events={[note]} />);
    expect(resolveProfile).toHaveBeenCalledWith('author-pk');
    // The lazily-fetched profile replaces the placeholder once it resolves.
    expect(await screen.findByText('Nakamoto')).toBeTruthy();
  });

  it('degrades to the placeholder when resolveProfile finds no kind:0', async () => {
    const resolveProfile = vi.fn().mockResolvedValue(null);
    render(
      <NoteCard
        {...defaultProps}
        resolveProfile={resolveProfile}
        events={[evt({ kind: 1, content: 'hi', pubkey: 'npub1abcdef' })]}
      />
    );
    // No kind:0 → initials fallback derived from the pubkey, as before.
    expect(await screen.findByText('AB')).toBeTruthy();
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

  it('wires Reply + Like (heart) to the existing action names with the targeted ids', () => {
    const reply = vi.fn();
    const react = vi.fn();
    render(
      <NoteCard
        {...defaultProps}
        actions={{ reply, react }}
        events={[evt({ kind: 1, id: 'note-9', content: 'react to me' })]}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /reply/i }));
    fireEvent.click(screen.getByRole('button', { name: /like this note/i }));
    expect(reply).toHaveBeenCalledWith({ parentId: 'note-9' });
    // "React" is surfaced to the user as "Like" but still fires the `react` action.
    expect(react).toHaveBeenCalledWith({ content: '+' });
  });

  it('caps the inline row at two actions (Reply + Like); Follow stays in the popover', () => {
    // Even with reply + react + follow ALL wired, the always-visible row shows
    // only two actions — MCP-app cards cap at two, so Follow lives behind the
    // author popover rather than as a third inline button.
    render(
      <NoteCard
        {...defaultProps}
        actions={{ reply: vi.fn(), react: vi.fn(), follow: vi.fn() }}
        events={[evt({ kind: 1, id: 'note-cap', pubkey: 'pk', content: 'gm' })]}
      />
    );
    expect(screen.getByRole('button', { name: /reply/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /like this note/i })).toBeTruthy();
    // Follow is not a third inline action — it only appears after opening the popover.
    expect(screen.queryByRole('button', { name: /^follow$/i })).toBeNull();
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

  it('reveals the author profile with a Follow button that publishes a kind:3 follow', () => {
    const follow = vi.fn();
    render(
      <NoteCard
        {...defaultProps}
        actions={{ follow }}
        events={[evt({ kind: 1, id: 'note-7', pubkey: 'author-pk', content: 'gm' })]}
      />
    );
    // Follow now lives in the click-to-reveal author profile, not the row header.
    fireEvent.click(screen.getByRole('button', { name: /view author's profile/i }));
    const followBtn = screen.getByRole('button', { name: /^follow$/i });
    fireEvent.click(followBtn);
    // The component supplies the author's pubkey as a `p` tag; the runtime merges
    // it over the spec's static kind:3 publish args (NIP-02 follow list).
    expect(follow).toHaveBeenCalledWith({ tags: [['p', 'author-pk']] });
    // Optimistic toggle flips the label to "Following".
    expect(screen.getByRole('button', { name: /^following$/i })).toBeTruthy();
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
