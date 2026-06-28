import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { mediaAtoms } from './media.js';
import { type AtomRenderProps } from './types.js';

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
});
