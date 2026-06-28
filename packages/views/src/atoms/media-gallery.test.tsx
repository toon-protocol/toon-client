import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { mediaGalleryAtoms } from './media-gallery.js';
import { type AtomRenderProps } from './types.js';
import { type NostrEvent } from '../types.js';

afterEach(cleanup);

const Gallery = mediaGalleryAtoms.find((a) => a.id === 'media-gallery')!.Component;

/** A kind:1 note carrying a single NIP-92 `imeta` image variant. */
const imageEvent = (id: string, url: string, alt?: string): NostrEvent => {
  const fields = [`url ${url}`, 'm image/png'];
  if (alt) fields.push(`alt ${alt}`);
  return {
    id,
    created_at: 1000,
    kind: 1,
    pubkey: 'a'.repeat(64),
    tags: [['imeta', ...fields]],
    content: '',
    sig: 's',
  } as NostrEvent;
};

const baseProps = (over: Partial<AtomRenderProps>): AtomRenderProps => ({
  events: [],
  props: {},
  actions: {},
  children: null,
  renderEvent: () => null,
  ...over,
});

describe('media-gallery', () => {
  it('renders a grid tile per media event, each image with alt text', () => {
    const events = [
      imageEvent('m1', 'https://arweave.net/a.png', 'a sunset'),
      imageEvent('m2', 'https://arweave.net/b.png'), // no alt → positional fallback
    ];
    const { container } = render(<Gallery {...baseProps({ events })} />);
    expect(screen.getByAltText('a sunset')).toBeTruthy();
    expect(screen.getByAltText('Media item 2')).toBeTruthy();
    // Every image in the grid carries non-empty alt text.
    for (const img of container.querySelectorAll('img')) {
      expect(img.getAttribute('alt')?.length).toBeGreaterThan(0);
    }
  });

  it('opens a lightbox when a tile is tapped and closes it again', () => {
    const events = [
      imageEvent('m1', 'https://arweave.net/a.png', 'a sunset'),
      imageEvent('m2', 'https://arweave.net/b.png', 'a moon'),
    ];
    render(<Gallery {...baseProps({ events })} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /open a sunset/i }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeTruthy();
    expect(within(dialog).getByText(/1 \/ 2/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /close lightbox/i }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('pages between media with next/prev in the lightbox', () => {
    const events = [
      imageEvent('m1', 'https://arweave.net/a.png', 'a sunset'),
      imageEvent('m2', 'https://arweave.net/b.png', 'a moon'),
    ];
    render(<Gallery {...baseProps({ events })} />);
    fireEvent.click(screen.getByRole('button', { name: /open a sunset/i }));
    expect(within(screen.getByRole('dialog')).getByText(/1 \/ 2/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /next media/i }));
    expect(within(screen.getByRole('dialog')).getByText(/2 \/ 2/)).toBeTruthy();
  });

  it('renders an empty state when no event carries media', () => {
    const bare = { id: 'x', created_at: 1, kind: 1, pubkey: 'a'.repeat(64), tags: [], content: 'hi', sig: 's' } as NostrEvent;
    render(<Gallery {...baseProps({ events: [bare] })} />);
    expect(screen.getByText(/no media to show/i)).toBeTruthy();
  });
});
