import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { type FC } from 'react';
import { gatewayMediaSrc, mediaAtoms, usePublishConfirmation, type ConfirmState } from './media.js';
import { type AtomRenderProps, type AtomAction } from './types.js';
import { type NostrEvent } from '../types.js';

afterEach(cleanup);

// jsdom doesn't implement object-URL APIs the uploader uses for previews.
beforeAll(() => {
  if (typeof URL.createObjectURL !== 'function') {
    URL.createObjectURL = vi.fn(() => 'blob:preview');
    URL.revokeObjectURL = vi.fn();
  }
});

type UploadArgs = Record<string, unknown>;
const uploadFn = (impl: () => Promise<{ ok: boolean; data?: unknown }>) =>
  vi.fn((_args?: UploadArgs) => impl());

const Uploader = mediaAtoms.find((a) => a.id === 'media-uploader')!.Component;

const base: AtomRenderProps = {
  events: [],
  props: {},
  actions: {},
  children: null,
  renderEvent: () => null,
};

/** jsdom's File lacks `arrayBuffer()` in some versions — polyfill for the test. */
function makeFile(name: string, type: string, content = 'bytes'): File {
  const file = new File([content], name, { type });
  if (typeof file.arrayBuffer !== 'function') {
    Object.defineProperty(file, 'arrayBuffer', {
      value: async () => new TextEncoder().encode(content).buffer,
    });
  }
  return file;
}

function pick(container: HTMLElement, file: File): void {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file] } });
}

describe('media-uploader — captioned media post', () => {
  it('stages a picked file, then publishes a kind:20 post with the caption', async () => {
    const upload = uploadFn(() =>
      Promise.resolve({ ok: true, data: { url: 'https://arweave.net/abc' } })
    );
    const { container } = render(<Uploader {...base} props={{}} actions={{ upload }} />);
    pick(container, makeFile('cat.png', 'image/png'));

    // Compose UI appears (caption field + Publish), upload NOT yet fired.
    const caption = await screen.findByPlaceholderText(/caption/i);
    expect(upload).not.toHaveBeenCalled();
    fireEvent.change(caption, { target: { value: 'my cat' } });
    fireEvent.click(screen.getByRole('button', { name: /Publish/i }));

    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    expect(upload).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 20, mime: 'image/png', caption: 'my cat' })
    );
  });

  it('omits caption for an image-only post and uses kind:21 for video', async () => {
    const upload = uploadFn(() => Promise.resolve({ ok: true, data: {} }));
    const { container } = render(<Uploader {...base} props={{}} actions={{ upload }} />);
    pick(container, makeFile('clip.mp4', 'video/mp4'));
    await screen.findByRole('button', { name: /Publish/i });
    fireEvent.click(screen.getByRole('button', { name: /Publish/i }));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    const arg = (upload.mock.calls[0]?.[0] ?? {}) as Record<string, unknown>;
    expect(arg['kind']).toBe(21);
    expect('caption' in arg).toBe(false);
  });

  it('optimistically confirms the published media event once a relay serves it back', async () => {
    const upload = vi.fn(
      () => Promise.resolve({ ok: true, eventId: 'media-1', data: { url: 'https://arweave.net/abc' } }),
    ) as unknown as AtomAction;
    // The free read seam (toon_query) returns the event → optimistic confirm.
    const loadMore = vi.fn(async () => [{ id: 'media-1' } as NostrEvent]);
    const { container } = render(
      <Uploader {...base} props={{}} actions={{ upload }} loadMore={loadMore} />,
    );
    pick(container, makeFile('cat.png', 'image/png'));
    fireEvent.click(await screen.findByRole('button', { name: /Publish/i }));
    expect(await screen.findByText(/Confirmed on a relay/i)).toBeTruthy();
    expect(loadMore).toHaveBeenCalledWith({ ids: ['media-1'], limit: 1 });
  });
});

describe('gatewayMediaSrc', () => {
  it('re-points an Arweave-addressable URL onto the preferred (CSP-allowed) gateway', () => {
    const txId = 'a'.repeat(43);
    expect(gatewayMediaSrc(`https://arweave.net/${txId}`)).toBe(`https://ar-io.dev/${txId}`);
    expect(gatewayMediaSrc(`ar://${txId}`)).toBe(`https://ar-io.dev/${txId}`);
  });

  it('passes a non-Arweave origin through unchanged (CSP blocks it → caller fallback)', () => {
    expect(gatewayMediaSrc('https://evil.example/pic.png')).toBe('https://evil.example/pic.png');
  });
});

describe('usePublishConfirmation', () => {
  const Harness: FC<{ eventId: string | null; loadMore: AtomRenderProps['loadMore'] }> = ({
    eventId,
    loadMore,
  }) => {
    const state: ConfirmState = usePublishConfirmation(eventId, loadMore, 40, 8);
    return <div data-testid="state">{state}</div>;
  };

  it('transitions pending → confirmed when the read seam observes the event', async () => {
    const loadMore = vi.fn(async () => [{ id: 'e1' } as NostrEvent]);
    render(<Harness eventId="e1" loadMore={loadMore} />);
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('confirmed'));
  });

  it('stays pending then settles on "unconfirmed" (never failed) when the event is never seen', async () => {
    // Absence is NOT failure (the devnet relay double-encodes EVENT payloads); a
    // confirm-window timeout settles on `unconfirmed`, still a pending state.
    const loadMore = vi.fn(async () => [] as NostrEvent[]);
    render(<Harness eventId="e1" loadMore={loadMore} />);
    expect(screen.getByTestId('state').textContent).toBe('pending');
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('unconfirmed'));
  });

  it('stays optimistically pending when no read seam is wired', () => {
    render(<Harness eventId="e1" loadMore={undefined} />);
    expect(screen.getByTestId('state').textContent).toBe('pending');
  });
});
