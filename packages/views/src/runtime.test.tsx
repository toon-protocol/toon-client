import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { ViewSpecRenderer, QUERY_TOOL } from './runtime.js';
import { type ViewBridge } from './app-bridge/types.js';
import { type NostrEvent } from './types.js';

afterEach(cleanup);

function evt(partial: Partial<NostrEvent> & { kind: number; id: string }): NostrEvent {
  return {
    pubkey: 'pk',
    created_at: 1,
    tags: [],
    content: '',
    sig: 'sig',
    ...partial,
  };
}

function mockBridge(
  events: NostrEvent[],
  confirmFn?: (msg: string) => Promise<boolean>
): { bridge: ViewBridge; calls: { name: string; args: Record<string, unknown> }[] } {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const bridge: ViewBridge = {
    async callTool(name, args) {
      calls.push({ name, args });
      if (name === QUERY_TOOL) return { ok: true, events };
      return { ok: true, data: { eventId: 'new-event' } };
    },
    notifyModel() {},
    onSpec() {
      return () => {};
    },
    ...(confirmFn ? { confirm: confirmFn } : {}),
  };
  return { bridge, calls };
}

describe('ViewSpecRenderer', () => {
  it('renders a kindAuto feed via the kind default atom', async () => {
    const { bridge } = mockBridge([evt({ kind: 1, id: 'n1', content: 'hello world' })]);
    render(
      <ViewSpecRenderer
        bridge={bridge}
        spec={{
          root: { atom: 'stack', children: [{ atom: 'note-card', bind: { query: { kinds: [1] }, kindAuto: true } }] },
        }}
      />
    );
    expect(await screen.findByText('hello world')).toBeTruthy();
  });

  it('fires a write action through the bridge with the right tool', async () => {
    const { bridge, calls } = mockBridge([
      evt({ kind: 1621, id: 'i1', tags: [['subject', 'Broken thing']], content: 'details' }),
    ]);
    render(
      <ViewSpecRenderer
        bridge={bridge}
        spec={{
          root: {
            atom: 'issue-card',
            bind: { eventId: 'i1' },
            actions: { comment: { tool: 'toon_publish_unsigned', args: { kind: 1622 } } },
          },
        }}
      />
    );
    const btn = await screen.findByText('Comment');
    fireEvent.click(btn);
    await Promise.resolve();
    const write = calls.find((c) => c.name === 'toon_publish_unsigned');
    expect(write).toBeTruthy();
    expect(write?.args['kind']).toBe(1622);
    expect(write?.args['parentId']).toBe('i1');
  });

  it('degrades an unknown atom to an invalid-spec notice', () => {
    const { bridge } = mockBridge([]);
    render(<ViewSpecRenderer bridge={bridge} spec={{ root: { atom: 'definitely-not-real' } }} />);
    expect(screen.getByText(/could not be rendered/i)).toBeTruthy();
  });

  it('renders unknown kinds through the generic fallback atom', async () => {
    const { bridge } = mockBridge([evt({ kind: 31337, id: 'x', content: 'raw payload' })]);
    render(
      <ViewSpecRenderer
        bridge={bridge}
        spec={{ root: { atom: 'generic-event', bind: { query: { kinds: [31337] } } } }}
      />
    );
    expect(await screen.findByText('raw payload')).toBeTruthy();
  });

  it('spendy confirm declined — tool is NOT called', async () => {
    const { bridge, calls } = mockBridge([], async () => false);
    render(
      <ViewSpecRenderer
        bridge={bridge}
        spec={{
          root: {
            atom: 'follow-button',
            actions: { follow: { tool: 'toon_publish_unsigned', args: { kind: 3 }, spendy: true } },
          },
        }}
      />
    );
    const btn = await screen.findByRole('button');
    fireEvent.click(btn);
    // Let the async confirm + potential callTool settle
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(calls.find((c) => c.name === 'toon_publish_unsigned')).toBeUndefined();
  });

  it('spendy confirm accepted — tool is called with spendy flag', async () => {
    const { bridge, calls } = mockBridge([], async () => true);
    render(
      <ViewSpecRenderer
        bridge={bridge}
        spec={{
          root: {
            atom: 'follow-button',
            actions: { follow: { tool: 'toon_publish_unsigned', args: { kind: 3 }, spendy: true } },
          },
        }}
      />
    );
    const btn = await screen.findByRole('button');
    fireEvent.click(btn);
    await new Promise<void>((r) => setTimeout(r, 0));
    const call = calls.find((c) => c.name === 'toon_publish_unsigned');
    expect(call).toBeTruthy();
    expect(call?.args['spendy']).toBe(true);
    expect(call?.args['kind']).toBe(3);
  });

  it('MediaUploader picks a file, base64-encodes it, and fires toon_upload_media', async () => {
    const { bridge, calls } = mockBridge([], async () => true);
    const { container } = render(
      <ViewSpecRenderer
        bridge={bridge}
        spec={{
          root: {
            atom: 'media-uploader',
            actions: {
              upload: { tool: 'toon_upload_media', args: { kind: 20 }, spendy: true },
            },
          },
        }}
      />
    );

    const inputEl = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(inputEl).toBeTruthy();

    const file = new File(['img-content'], 'photo.png', { type: 'image/png' });
    Object.defineProperty(inputEl, 'files', { value: [file], configurable: true });
    fireEvent.change(inputEl);

    await waitFor(() => {
      expect(calls.find((c) => c.name === 'toon_upload_media')).toBeTruthy();
    });

    const call = calls.find((c) => c.name === 'toon_upload_media');
    expect(typeof call?.args['dataBase64']).toBe('string');
    expect(call?.args['mime']).toBe('image/png');
    // base64 of 'img-content'
    expect(call?.args['dataBase64']).toBe(btoa('img-content'));
  });
});
