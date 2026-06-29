import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import {
  ViewSpecRenderer,
  QUERY_TOOL,
  buildReadBalances,
  parseBalancesPayload,
} from './runtime.js';
import { STATUS_TOOL, BALANCES_TOOL } from './tool-names.js';
import { type ToolOutcome, type ViewBridge } from './app-bridge/types.js';
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

  it('sorts a feed newest-first regardless of relay return order', async () => {
    // Relay returns these out of order; render must be reverse-chronological.
    const { bridge } = mockBridge([
      evt({ kind: 1, id: 'b', created_at: 100, content: 'older note' }),
      evt({ kind: 1, id: 'a', created_at: 300, content: 'newest note' }),
      evt({ kind: 1, id: 'c', created_at: 200, content: 'middle note' }),
    ]);
    const { container } = render(
      <ViewSpecRenderer
        bridge={bridge}
        spec={{ root: { atom: 'note-card', bind: { query: { kinds: [1] } } } }}
      />
    );
    await screen.findByText('newest note');
    const text = container.textContent ?? '';
    expect(text.indexOf('newest note')).toBeLessThan(text.indexOf('middle note'));
    expect(text.indexOf('middle note')).toBeLessThan(text.indexOf('older note'));
  });

  it('sort:"asc" renders a bind oldest-first, ties stable on id', async () => {
    const { bridge } = mockBridge([
      evt({ kind: 1, id: 'z', created_at: 100, content: 'second by id tie' }),
      evt({ kind: 1, id: 'a', created_at: 100, content: 'first by id tie' }),
      evt({ kind: 1, id: 'y', created_at: 50, content: 'oldest note' }),
    ]);
    const { container } = render(
      <ViewSpecRenderer
        bridge={bridge}
        spec={{ root: { atom: 'note-card', bind: { query: { kinds: [1] }, sort: 'asc' } } }}
      />
    );
    await screen.findByText('oldest note');
    const text = container.textContent ?? '';
    expect(text.indexOf('oldest note')).toBeLessThan(text.indexOf('first by id tie'));
    expect(text.indexOf('first by id tie')).toBeLessThan(text.indexOf('second by id tie'));
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

  it('rendered spendy consent is specific — shows fee, chain, and irreversibility', async () => {
    // No injected confirm → the in-iframe ConsentProvider modal renders, which
    // reads toon_status (mockBridge returns fee 1 / base / USDC).
    const { bridge, calls } = mockBridge([]);
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
    fireEvent.click(await screen.findByRole('button'));
    // The prompt names the concrete spend, not just a label.
    expect(await screen.findByText(/non-refundable/i)).toBeTruthy();
    expect(await screen.findByText('1 USDC')).toBeTruthy(); // pay-to-write fee surfaced
    expect(screen.getByText('base')).toBeTruthy(); // settlement chain
    // Approving pays.
    fireEvent.click(screen.getByRole('button', { name: /Confirm & pay/i }));
    await waitFor(() =>
      expect(calls.find((c) => c.name === 'toon_publish_unsigned')).toBeTruthy()
    );
  });

  it('MediaUploader — spendy consent declined — shows a benign cancel note, NOT upload-failed', async () => {
    // A declined consent prompt is user-initiated and benign: no bytes were
    // uploaded, so it must not be rendered as an "Upload failed" error (#170).
    const { bridge, calls } = mockBridge([], async () => false);
    const { container } = render(
      <ViewSpecRenderer
        bridge={bridge}
        spec={{
          root: {
            atom: 'media-uploader',
            actions: {
              upload: { tool: 'toon_upload', args: { kind: 20 }, spendy: true },
            },
          },
        }}
      />
    );

    const inputEl = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['img-content'], 'photo.png', { type: 'image/png' });
    Object.defineProperty(inputEl, 'files', { value: [file], configurable: true });
    fireEvent.change(inputEl);
    fireEvent.click(await screen.findByRole('button', { name: /Publish/i }));

    await waitFor(() => expect(screen.getByText(/upload cancelled/i)).toBeTruthy());
    expect(screen.queryByText(/upload failed/i)).toBeNull();
    expect(screen.queryByText(/uploaded successfully/i)).toBeNull();
    // Declined upstream of the daemon: the upload tool never ran.
    expect(calls.find((c) => c.name === 'toon_upload')).toBeUndefined();
  });

  it('spendy action with no bridge.confirm — renders an in-iframe consent prompt (not window.confirm)', async () => {
    // The real ext-apps bridge provides no `confirm`, and the host iframe blocks
    // `window.confirm`. The runtime must render its own consent prompt and only
    // fire the spendy tool after the user confirms it (#170).
    const { bridge, calls } = mockBridge([]); // no confirmFn injected
    const { container } = render(
      <ViewSpecRenderer
        bridge={bridge}
        spec={{
          root: {
            atom: 'media-uploader',
            actions: {
              upload: { tool: 'toon_upload', args: { kind: 20 }, spendy: true },
            },
          },
        }}
      />
    );

    const inputEl = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['img-content'], 'photo.png', { type: 'image/png' });
    Object.defineProperty(inputEl, 'files', { value: [file], configurable: true });
    fireEvent.change(inputEl);
    fireEvent.click(await screen.findByRole('button', { name: /Publish/i }));

    // A rendered consent dialog appears — the tool has NOT fired yet.
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toBeTruthy();
    expect(calls.find((c) => c.name === 'toon_upload')).toBeUndefined();

    // Confirming the prompt fires the spendy tool with the spendy flag set.
    fireEvent.click(screen.getByText(/confirm & pay/i));
    await waitFor(() => expect(calls.find((c) => c.name === 'toon_upload')).toBeTruthy());
    expect(calls.find((c) => c.name === 'toon_upload')?.args['spendy']).toBe(true);
  });

  it('in-iframe consent prompt — Cancel declines the spend (benign), tool never fires', async () => {
    const { bridge, calls } = mockBridge([]); // no confirmFn injected
    const { container } = render(
      <ViewSpecRenderer
        bridge={bridge}
        spec={{
          root: {
            atom: 'media-uploader',
            actions: {
              upload: { tool: 'toon_upload', args: { kind: 20 }, spendy: true },
            },
          },
        }}
      />
    );

    const inputEl = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['img-content'], 'photo.png', { type: 'image/png' });
    Object.defineProperty(inputEl, 'files', { value: [file], configurable: true });
    fireEvent.change(inputEl);
    fireEvent.click(await screen.findByRole('button', { name: /Publish/i }));

    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

    await waitFor(() => expect(screen.getByText(/upload cancelled/i)).toBeTruthy());
    expect(screen.queryByText(/upload failed/i)).toBeNull();
    expect(calls.find((c) => c.name === 'toon_upload')).toBeUndefined();
  });

  it('MediaUploader surfaces the underlying leg error, not just a generic message', async () => {
    // The daemon labels which leg failed (Arweave upload vs. post-upload
    // publish); the uploader must propagate that string so it's diagnosable.
    const legError =
      'Arweave upload leg failed (store g.proxy.store): Event rejected: F02 - no route';
    const bridge: ViewBridge = {
      async callTool(name) {
        if (name === 'toon_upload') return { ok: false, error: legError };
        return { ok: true };
      },
      notifyModel() {},
      onSpec() {
        return () => {};
      },
    };
    const { container } = render(
      <ViewSpecRenderer
        bridge={bridge}
        spec={{
          root: {
            atom: 'media-uploader',
            actions: { upload: { tool: 'toon_upload', args: { kind: 20 } } },
          },
        }}
      />
    );

    const inputEl = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['img-content'], 'photo.png', { type: 'image/png' });
    Object.defineProperty(inputEl, 'files', { value: [file], configurable: true });
    fireEvent.change(inputEl);
    fireEvent.click(await screen.findByRole('button', { name: /Publish/i }));

    await waitFor(() => expect(screen.getByText(/Arweave upload leg failed/i)).toBeTruthy());
    expect(screen.getByText(/F02 - no route/i)).toBeTruthy();
    expect(screen.queryByText(/uploaded successfully/i)).toBeNull();
  });

  it('MediaUploader picks a file, base64-encodes it, and fires toon_upload', async () => {
    const { bridge, calls } = mockBridge([], async () => true);
    const { container } = render(
      <ViewSpecRenderer
        bridge={bridge}
        spec={{
          root: {
            atom: 'media-uploader',
            actions: {
              upload: { tool: 'toon_upload', args: { kind: 20 }, spendy: true },
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
    fireEvent.click(await screen.findByRole('button', { name: /Publish/i }));

    await waitFor(() => {
      expect(calls.find((c) => c.name === 'toon_upload')).toBeTruthy();
    });

    const call = calls.find((c) => c.name === 'toon_upload');
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

  // ── post-action auto-refresh (refreshNonce) ────────────────────────────────

  /** A bridge whose status carries an identity (so the wallet renders Fund). */
  function walletBridge(fundOk: boolean): {
    bridge: ViewBridge;
    count: (name: string) => number;
  } {
    const calls: string[] = [];
    const bridge: ViewBridge = {
      async callTool(name) {
        calls.push(name);
        if (name === STATUS_TOOL)
          return {
            ok: true,
            data: { feePerEvent: '1', settlementChain: 'base', identity: { evmAddress: '0xabc' } },
          };
        if (name === BALANCES_TOOL)
          return {
            ok: true,
            data: { balances: [{ chain: 'evm', address: '0xabc', amount: '1000000', asset: 'USDC', assetScale: 6 }] },
          };
        // The fund action result (success or failure under test).
        return fundOk ? { ok: true, data: { status: 'pending' } } : { ok: false, error: 'faucet down' };
      },
      notifyModel() {},
      onSpec() {
        return () => {};
      },
    };
    return { bridge, count: (name) => calls.filter((c) => c === name).length };
  }

  it('a SUCCESSFUL action bumps the refresh signal — the read seam re-fetches', async () => {
    const { bridge, count } = walletBridge(true);
    render(
      <ViewSpecRenderer
        bridge={bridge}
        spec={{
          root: { atom: 'wallet-overview', actions: { fund: { tool: 'toon_fund_wallet' } } },
        }}
      />
    );
    // Initial mount read of balances.
    await screen.findByText('EVM');
    await waitFor(() => expect(count(BALANCES_TOOL)).toBe(1));
    // Fund succeeds → onMutated → refreshNonce bump → balances re-read in place.
    fireEvent.click(screen.getAllByRole('button', { name: 'Fund' })[0]!);
    await waitFor(() => expect(count(BALANCES_TOOL)).toBeGreaterThanOrEqual(2));
  });

  it('a FAILED action does NOT bump the refresh signal — no re-fetch', async () => {
    const { bridge, count } = walletBridge(false);
    render(
      <ViewSpecRenderer
        bridge={bridge}
        spec={{
          root: { atom: 'wallet-overview', actions: { fund: { tool: 'toon_fund_wallet' } } },
        }}
      />
    );
    await screen.findByText('EVM');
    await waitFor(() => expect(count(BALANCES_TOOL)).toBe(1));
    fireEvent.click(screen.getAllByRole('button', { name: 'Fund' })[0]!);
    // The failed fund surfaces a Retry-fund label; balances must NOT have re-read.
    await screen.findByRole('button', { name: /Retry fund/i });
    expect(count(BALANCES_TOOL)).toBe(1);
  });

  it('a successful action re-queries a bound feed (post/react/follow refresh)', async () => {
    let queries = 0;
    const bridge: ViewBridge = {
      async callTool(name, args) {
        if (name === QUERY_TOOL) {
          // Count only the feed bind read (kinds:[1]), not profile (kinds:[0]) lookups.
          const filter = (args as { filter?: { kinds?: number[] } }).filter;
          if (filter?.kinds?.includes(1)) queries++;
          return { ok: true, events: [evt({ kind: 1, id: 'n1', content: 'gm' })] };
        }
        return { ok: true, data: { eventId: 'new-event' } };
      },
      notifyModel() {},
      onSpec() {
        return () => {};
      },
    };
    render(
      <ViewSpecRenderer
        bridge={bridge}
        spec={{
          root: {
            atom: 'note-card',
            bind: { query: { kinds: [1] } },
            actions: { react: { tool: 'toon_publish_unsigned', args: { kind: 7 } } },
          },
        }}
      />
    );
    await screen.findByText('gm');
    await waitFor(() => expect(queries).toBe(1));
    // Fire the wired react/like action → onMutated → useBind re-queries the feed.
    fireEvent.click(screen.getByRole('button', { name: /like this note/i }));
    await waitFor(() => expect(queries).toBeGreaterThanOrEqual(2));
  });
});

// ── toon_balances contract guard (#200) ─────────────────────────────────────

describe('parseBalancesPayload', () => {
  it('accepts the `{ balances: [...] }` contract', () => {
    const balances = [{ chain: 'evm', address: '0x1', amount: '5' }];
    expect(parseBalancesPayload({ balances })).toEqual(balances);
  });

  it('accepts a legitimately empty wallet `{ balances: [] }`', () => {
    expect(parseBalancesPayload({ balances: [] })).toEqual([]);
  });

  it('THROWS on missing structuredContent (undefined)', () => {
    expect(() => parseBalancesPayload(undefined)).toThrow();
  });

  it('THROWS on a bare array (not the object contract)', () => {
    expect(() => parseBalancesPayload([{ chain: 'evm', address: '0x1', amount: '5' }])).toThrow();
  });

  it('THROWS on a non-object primitive (e.g. text-only result)', () => {
    expect(() => parseBalancesPayload('balances: none')).toThrow();
  });

  it('THROWS when the `balances` key is missing / not an array (version skew)', () => {
    expect(() => parseBalancesPayload({})).toThrow();
    expect(() => parseBalancesPayload({ balances: { evm: '5' } })).toThrow();
  });
});

describe('buildReadBalances', () => {
  function bridgeReturning(...responses: ToolOutcome[]): {
    bridge: ViewBridge;
    calls: number;
  } {
    let calls = 0;
    const bridge: ViewBridge = {
      async callTool(name) {
        if (name !== BALANCES_TOOL) return { ok: true };
        const res = responses[Math.min(calls, responses.length - 1)]!;
        calls++;
        return res;
      },
      notifyModel() {},
      onSpec() {
        return () => {};
      },
    };
    return {
      bridge,
      get calls() {
        return calls;
      },
    };
  }

  it('returns the balances on a valid `{ balances: [...] }` success', async () => {
    const balances = [{ chain: 'evm', address: '0x1', amount: '5' }];
    const h = bridgeReturning({ ok: true, data: { balances } });
    await expect(buildReadBalances(h.bridge)()).resolves.toEqual(balances);
    expect(h.calls).toBe(1);
  });

  it('returns [] for a valid empty wallet `{ balances: [] }`', async () => {
    const h = bridgeReturning({ ok: true, data: { balances: [] } });
    await expect(buildReadBalances(h.bridge)()).resolves.toEqual([]);
  });

  it('THROWS (no silent []) on a successful call with NO structuredContent', async () => {
    const h = bridgeReturning({ ok: true });
    await expect(buildReadBalances(h.bridge)()).rejects.toThrow();
    // Contract violation fails fast — no inter-attempt retry storm.
    expect(h.calls).toBe(1);
  });

  it('THROWS (no silent []) on a bare-array payload (contract violation)', async () => {
    const h = bridgeReturning({ ok: true, data: [{ chain: 'evm', address: '0x1', amount: '5' }] });
    await expect(buildReadBalances(h.bridge)()).rejects.toThrow();
    expect(h.calls).toBe(1);
  });

  it('retries a transient `{ ok:false }` refuse, then succeeds (#186)', async () => {
    const balances = [{ chain: 'evm', address: '0x1', amount: '5' }];
    const h = bridgeReturning(
      { ok: false, error: 'ECONNREFUSED' },
      { ok: true, data: { balances } }
    );
    await expect(buildReadBalances(h.bridge)()).resolves.toEqual(balances);
    expect(h.calls).toBe(2);
  });

  it('THROWS the last error after persistent `{ ok:false }` (e.g. a timeout, #199)', async () => {
    const h = bridgeReturning({ ok: false, error: 'aborted: timeout' });
    await expect(buildReadBalances(h.bridge)()).rejects.toThrow(/timeout/);
    expect(h.calls).toBe(3);
  });
});
