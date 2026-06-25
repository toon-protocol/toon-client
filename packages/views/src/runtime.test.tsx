import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { ViewSpecRenderer, QUERY_TOOL } from './runtime.js';
import { STATUS_TOOL } from './tool-names.js';
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
      if (name === STATUS_TOOL)
        return { ok: true, data: { feePerEvent: '1', settlementChain: 'base', asset: 'USDC' } };
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
  it('note-card with bind.query renders all matching events', async () => {
    const { bridge } = mockBridge([
      evt({ kind: 1, id: 'n1', content: 'first note' }),
      evt({ kind: 1, id: 'n2', content: 'second note' }),
      evt({ kind: 1, id: 'n3', content: 'third note' }),
    ]);
    render(
      <ViewSpecRenderer
        bridge={bridge}
        spec={{
          root: { atom: 'note-card', bind: { query: { kinds: [1] } } },
        }}
      />
    );
    expect(await screen.findByText('first note')).toBeTruthy();
    expect(screen.getByText('second note')).toBeTruthy();
    expect(screen.getByText('third note')).toBeTruthy();
  });

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
    const notified: string[] = [];
    const { bridge, calls } = mockBridge([], async () => false);
    const origNotify = bridge.notifyModel.bind(bridge);
    bridge.notifyModel = (t) => { notified.push(t); origNotify(t); };
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
    // Wait for the cancel notification — proves the async chain ran to completion before asserting negative.
    await waitFor(() => expect(notified.some((m) => m.includes('cancelled'))).toBe(true));
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
    await waitFor(() => expect(calls.find((c) => c.name === 'toon_publish_unsigned')).toBeTruthy());
    const call = calls.find((c) => c.name === 'toon_publish_unsigned');
    expect(call?.args['spendy']).toBe(true);
    expect(call?.args['kind']).toBe(3);
  });

  it('MediaUploader — spendy confirm cancelled — shows upload-failed, not success', async () => {
    const { bridge } = mockBridge([], async () => false);
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
    const file = new File(['img-content'], 'photo.png', { type: 'image/png' });
    Object.defineProperty(inputEl, 'files', { value: [file], configurable: true });
    fireEvent.change(inputEl);

    await waitFor(() => expect(screen.getByText(/upload failed/i)).toBeTruthy());
    expect(screen.queryByText(/uploaded successfully/i)).toBeNull();
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

  it('pay-confirm: compose → confirm (fee+chain) → publish → receipt with real eventId', async () => {
    const { bridge, calls } = mockBridge([]);
    render(
      <ViewSpecRenderer
        bridge={bridge}
        spec={{
          root: {
            atom: 'pay-confirm',
            actions: { confirm: { tool: 'toon_publish_unsigned', args: { kind: 1 } } },
          },
        }}
      />
    );

    // idle → type a note
    const textarea = (await screen.findByPlaceholderText(/what's happening/i)) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'gm over TOON' } });
    fireEvent.click(screen.getByText(/pay to post/i));

    // confirming → the live fee + settlement chain are shown (from toon_status, not hardcoded)
    await waitFor(() => expect(screen.getByText(/confirm pay-to-write/i)).toBeTruthy());
    await waitFor(() => {
      expect(calls.some((c) => c.name === STATUS_TOOL)).toBe(true);
      expect(screen.getByText(/1 USDC/i)).toBeTruthy();
      expect(screen.getByText(/\bbase\b/i)).toBeTruthy();
    });
    // No publish yet — only the status read happened.
    expect(calls.find((c) => c.name === 'toon_publish_unsigned')).toBeUndefined();

    // confirm → publish fires with the composed content
    fireEvent.click(screen.getByText(/confirm & pay/i));
    await waitFor(() => {
      const pub = calls.find((c) => c.name === 'toon_publish_unsigned');
      expect(pub).toBeTruthy();
      expect(pub?.args['content']).toBe('gm over TOON');
      expect(pub?.args['kind']).toBe(1);
    });

    // receipt → shows the real eventId surfaced from the outcome + "message is the money"
    await waitFor(() => {
      expect(screen.getByText('new-event')).toBeTruthy();
      expect(screen.getByText(/the message is the money/i)).toBeTruthy();
    });
  });

  it('pay-confirm: shows "unavailable" when toon_status returns no feePerEvent', async () => {
    const bridge: ViewBridge = {
      async callTool(name) {
        if (name === QUERY_TOOL) return { ok: true, events: [] };
        if (name === STATUS_TOOL) return { ok: true, data: { settlementChain: 'evm' } };
        return { ok: true };
      },
      notifyModel() {},
      onSpec() { return () => {}; },
    };
    render(
      <ViewSpecRenderer
        bridge={bridge}
        spec={{
          root: {
            atom: 'pay-confirm',
            actions: { confirm: { tool: 'toon_publish_unsigned', args: { kind: 1 } } },
          },
        }}
      />
    );
    const textarea = (await screen.findByPlaceholderText(/what's happening/i)) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'test' } });
    fireEvent.click(screen.getByText(/pay to post/i));
    await waitFor(() => expect(screen.getByText(/confirm pay-to-write/i)).toBeTruthy());
    // fee shown as 'unavailable', not '0'
    await waitFor(() => expect(screen.getByText(/unavailable/i)).toBeTruthy());
    // Confirm button must still be clickable (atom disables on error via statusError path)
    // — the point is that '0' is NOT shown
    expect(screen.queryByText(/\b0\b/)).toBeNull();
  });

  it('pay-confirm: Back fires no publish and returns to compose', async () => {
    const { bridge, calls } = mockBridge([]);
    render(
      <ViewSpecRenderer
        bridge={bridge}
        spec={{
          root: {
            atom: 'pay-confirm',
            actions: { confirm: { tool: 'toon_publish_unsigned', args: { kind: 1 } } },
          },
        }}
      />
    );

    const textarea = (await screen.findByPlaceholderText(/what's happening/i)) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'never mind' } });
    fireEvent.click(screen.getByText(/pay to post/i));
    await waitFor(() => expect(screen.getByText(/confirm pay-to-write/i)).toBeTruthy());

    fireEvent.click(screen.getByText(/back/i));
    // back to compose; nothing published
    await waitFor(() => expect(screen.getByPlaceholderText(/what's happening/i)).toBeTruthy());
    expect(calls.find((c) => c.name === 'toon_publish_unsigned')).toBeUndefined();
  });
});
