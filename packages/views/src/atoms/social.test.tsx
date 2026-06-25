import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { type NostrEvent } from '../types.js';
import { socialAtoms } from './social.js';

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
