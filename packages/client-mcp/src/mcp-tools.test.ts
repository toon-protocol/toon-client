import { describe, it, expect, vi } from 'vitest';
import { dispatchTool, summarizeEvents, TOOL_DEFINITIONS } from './mcp-tools.js';
import type { NostrEvent } from 'nostr-tools/pure';
import { WRITE_TOOLS } from '@toon-protocol/views';
import { ControlApiError, DaemonUnreachableError } from './control-client.js';
import type { ControlClient } from './control-client.js';

/** Build a ControlClient stub with the given method implementations. */
function stubClient(
  impl: Partial<Record<keyof ControlClient, unknown>>
): ControlClient {
  return impl as unknown as ControlClient;
}

describe('TOOL_DEFINITIONS', () => {
  it('exposes the documented tool surface', () => {
    expect(TOOL_DEFINITIONS.map((t) => t.name).sort()).toEqual(
      [
        'toon_atoms',
        'toon_balances',
        'toon_channel_close',
        'toon_channel_deposit',
        'toon_channel_settle',
        'toon_channels',
        'toon_identity',
        'toon_open_channel',
        'toon_publish',
        'toon_publish_unsigned',
        'toon_query',
        'toon_render',
        'toon_upload',
        'toon_read',
        'toon_status',
        'toon_swap',
        'toon_http_fetch_paid',
        'toon_subscribe',
        'toon_fund_wallet',
        'toon_fund_status',
        'toon_targets',
        'toon_add_relay',
        'toon_remove_relay',
        'toon_add_apex',
        'toon_remove_apex',
      ].sort()
    );
  });

  it('every tool has an object input schema', () => {
    for (const t of TOOL_DEFINITIONS) {
      expect(t.inputSchema['type']).toBe('object');
      expect(typeof t.description).toBe('string');
    }
  });

  it('carries the render-first policy in descriptions for non-skill hosts', () => {
    const byName = (n: string) =>
      TOOL_DEFINITIONS.find((t) => t.name === n)!.description;

    // toon_render claims the display surface and beats generic widgets.
    expect(byName('toon_render')).toMatch(/PRIMARY display surface/);
    expect(byName('toon_render')).toMatch(/HTML\/SVG\/chart/);
    expect(byName('toon_render')).toMatch(/toon_atoms first/);

    // toon_atoms is an imperative precursor.
    expect(byName('toon_atoms')).toMatch(/REQUIRED first call before any toon_render/);

    // Read/status tools nudge display routing through toon_render.
    for (const n of [
      'toon_status',
      'toon_query',
      'toon_channels',
      'toon_targets',
      'toon_read',
    ]) {
      expect(byName(n)).toMatch(/toon_render/);
    }
  });

  it('annotates every tool so hosts can gate writes and auto-run reads', () => {
    const ann = (n: string) =>
      TOOL_DEFINITIONS.find((t) => t.name === n)!.annotations;

    // Every tool is classified (the module also asserts this at load).
    for (const t of TOOL_DEFINITIONS) {
      expect(t.annotations, `${t.name} missing annotations`).toBeDefined();
    }

    // Free reads are read-only; paid/irreversible writes are destructive writes.
    for (const n of ['toon_status', 'toon_query', 'toon_read', 'toon_balances', 'toon_render']) {
      expect(ann(n)?.readOnlyHint, n).toBe(true);
    }
    for (const n of ['toon_publish', 'toon_publish_unsigned', 'toon_upload', 'toon_swap']) {
      expect(ann(n)?.readOnlyHint, n).toBe(false);
      expect(ann(n)?.destructiveHint, n).toBe(true);
    }
    // Closing a channel is irreversible; opening one is idempotent.
    expect(ann('toon_channel_close')?.destructiveHint).toBe(true);
    expect(ann('toon_open_channel')?.idempotentHint).toBe(true);

    // Every UI-fireable write must be non-read-only so hosts gate it.
    for (const name of WRITE_TOOLS) {
      expect(ann(name)?.readOnlyHint, name).toBe(false);
    }
  });
});

describe('dispatchTool', () => {
  it('toon_status returns the daemon status as JSON text and structuredContent with fee', async () => {
    const client = stubClient({
      status: vi.fn().mockResolvedValue({
        ready: true,
        bootstrapping: false,
        settlementChain: 'evm',
        feePerEvent: '1000',
      }),
    });
    const res = await dispatchTool(client, 'toon_status', {});
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content[0]!.text)).toMatchObject({ ready: true });
    expect(res.structuredContent).toMatchObject({
      feePerEvent: '1000',
      settlementChain: 'evm',
      ready: true,
      bootstrapping: false,
    });
  });

  it('toon_status forwards optional asset in structuredContent', async () => {
    const client = stubClient({
      status: vi.fn().mockResolvedValue({
        ready: true,
        bootstrapping: false,
        settlementChain: 'evm',
        feePerEvent: '500',
        asset: 'USDC',
      }),
    });
    const res = await dispatchTool(client, 'toon_status', {});
    expect(res.structuredContent).toMatchObject({ feePerEvent: '500', asset: 'USDC' });
  });

  it('toon_identity projects the identity subset from status', async () => {
    const client = stubClient({
      status: vi.fn().mockResolvedValue({
        ready: true,
        bootstrapping: false,
        identity: { nostrPubkey: 'pk', evmAddress: '0x1' },
      }),
    });
    const res = await dispatchTool(client, 'toon_identity', {});
    const parsed = JSON.parse(res.content[0]!.text);
    expect(parsed.identity).toEqual({ nostrPubkey: 'pk', evmAddress: '0x1' });
    expect(parsed.ready).toBe(true);
  });

  it('toon_publish forwards the event and fee', async () => {
    const publish = vi
      .fn()
      .mockResolvedValue({ eventId: 'e1', channelId: 'c1', nonce: 4 });
    const client = stubClient({ publish });
    const res = await dispatchTool(client, 'toon_publish', {
      event: { id: 'e1' },
      fee: '3',
    });
    expect(publish).toHaveBeenCalledWith({ event: { id: 'e1' }, fee: '3' });
    expect(JSON.parse(res.content[0]!.text).nonce).toBe(4);
  });

  it('toon_subscribe passes filters and optional subId', async () => {
    const subscribe = vi.fn().mockResolvedValue({ subId: 's1' });
    const client = stubClient({ subscribe });
    await dispatchTool(client, 'toon_subscribe', {
      filters: { kinds: [1] },
      subId: 's1',
    });
    expect(subscribe).toHaveBeenCalledWith({
      filters: { kinds: [1] },
      subId: 's1',
    });
  });

  it('toon_read forwards only the provided query fields', async () => {
    const events = vi
      .fn()
      .mockResolvedValue({ events: [], cursor: 0, hasMore: false });
    const client = stubClient({ events });
    await dispatchTool(client, 'toon_read', { cursor: 5, limit: 10 });
    expect(events).toHaveBeenCalledWith({ cursor: 5, limit: 10 });
  });

  it('toon_swap forwards the swap params (coercing destination/amount)', async () => {
    const swap = vi.fn().mockResolvedValue({ accepted: true, claims: [] });
    const client = stubClient({ swap });
    const pair = {
      from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:base:84532' },
      to: { assetCode: 'USDC', assetScale: 6, chain: 'solana:devnet' },
      rate: '1.0',
    };
    await dispatchTool(client, 'toon_swap', {
      destination: 'g.toon.swap',
      amount: 100,
      swapPubkey: 'cd'.repeat(32),
      pair,
      chainRecipient: 'SoLrecipient',
      packetCount: 2,
    });
    expect(swap).toHaveBeenCalledWith({
      destination: 'g.toon.swap',
      amount: '100',
      swapPubkey: 'cd'.repeat(32),
      pair,
      chainRecipient: 'SoLrecipient',
      packetCount: 2,
    });
  });

  it('toon_balances returns the wallet balances as structuredContent (iframe seam)', async () => {
    const payload = {
      balances: [{ chain: 'evm', address: '0x1', amount: '5000000', asset: 'USDC', assetScale: 6 }],
    };
    const balances = vi.fn().mockResolvedValue(payload);
    const client = stubClient({ balances });
    const res = await dispatchTool(client, 'toon_balances', {});
    expect(balances).toHaveBeenCalled();
    expect(JSON.parse(res.content[0]!.text)).toEqual(payload);
    // The MCP-app bridge only surfaces `structuredContent` as ToolOutcome.data;
    // without it the wallet-overview card shows no balance/USDC (#186).
    expect(res.structuredContent).toEqual(payload);
  });

  it('toon_channels returns the channels as structuredContent (iframe seam)', async () => {
    const payload = { channels: [{ channelId: 'c1', nonce: 3, cumulativeAmount: '3000' }] };
    const channels = vi.fn().mockResolvedValue(payload);
    const client = stubClient({ channels });
    const res = await dispatchTool(client, 'toon_channels', {});
    expect(channels).toHaveBeenCalled();
    expect(res.structuredContent).toEqual(payload);
  });

  it('toon_balances always emits structuredContent.balances as a populated array for a non-empty read (#200)', async () => {
    const row = { chain: 'evm', address: '0x1', amount: '5000000', asset: 'USDC', assetScale: 6 };
    const balances = vi.fn().mockResolvedValue({ balances: [row] });
    const res = await dispatchTool(stubClient({ balances }), 'toon_balances', {});
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toBeDefined();
    const got = res.structuredContent?.['balances'];
    expect(Array.isArray(got)).toBe(true);
    expect((got as unknown[]).length).toBe(1);
    expect((got as unknown[])[0]).toEqual(row);
  });

  it('toon_balances wraps a bare-array regression so structuredContent is never dropped (#200)', async () => {
    // If client.balances() ever regresses to returning a BARE ARRAY, the
    // tool boundary must still wrap it as { balances: [...] } so ok() does not
    // silently drop structuredContent (its Array.isArray guard).
    const row = { chain: 'solana', address: 'So1', amount: '1000', asset: 'USDC', assetScale: 6 };
    const balances = vi.fn().mockResolvedValue([row]);
    const res = await dispatchTool(stubClient({ balances }), 'toon_balances', {});
    expect(res.structuredContent).toEqual({ balances: [row] });
    expect(Array.isArray(res.structuredContent?.['balances'])).toBe(true);
  });

  it('toon_channels wraps a bare-array regression so structuredContent is never dropped (#200)', async () => {
    const row = { channelId: 'c1', nonce: 3, cumulativeAmount: '3000' };
    const channels = vi.fn().mockResolvedValue([row]);
    const res = await dispatchTool(stubClient({ channels }), 'toon_channels', {});
    expect(res.structuredContent).toEqual({ channels: [row] });
    expect(Array.isArray(res.structuredContent?.['channels'])).toBe(true);
  });

  it('toon_balances 504 names the control plane / balances handler, not relay/apex (#199)', async () => {
    const balances = vi
      .fn()
      .mockRejectedValue(
        new ControlApiError(
          'balances_unavailable',
          504,
          true,
          'the balances control handler\'s chain RPC/provider read did not return'
        )
      );
    const res = await dispatchTool(stubClient({ balances }), 'toon_balances', {});
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/balances control plane|balances handler|GET \/balances/);
    expect(res.content[0]!.text).not.toMatch(/retry once the relay is reachable and the apex is online/);
  });

  it('toon_channel_deposit forwards channelId + amount', async () => {
    const depositToChannel = vi
      .fn()
      .mockResolvedValue({ channelId: 'c1', txHash: '0xdep', depositTotal: '1500000' });
    const client = stubClient({ depositToChannel });
    const res = await dispatchTool(client, 'toon_channel_deposit', { channelId: 'c1', amount: '500000' });
    expect(depositToChannel).toHaveBeenCalledWith({ channelId: 'c1', amount: '500000' });
    expect(JSON.parse(res.content[0]!.text)).toEqual({ channelId: 'c1', txHash: '0xdep', depositTotal: '1500000' });
  });

  it('toon_channel_close forwards the channelId', async () => {
    const closeChannel = vi
      .fn()
      .mockResolvedValue({ channelId: 'c1', txHash: '0xc', closedAt: '1000', settleableAt: '2000' });
    const client = stubClient({ closeChannel });
    const res = await dispatchTool(client, 'toon_channel_close', { channelId: 'c1' });
    expect(closeChannel).toHaveBeenCalledWith({ channelId: 'c1' });
    expect(JSON.parse(res.content[0]!.text)).toMatchObject({ channelId: 'c1', settleableAt: '2000' });
  });

  it('toon_channel_settle forwards the channelId', async () => {
    const settleChannel = vi.fn().mockResolvedValue({ channelId: 'c1', txHash: '0xs' });
    const client = stubClient({ settleChannel });
    const res = await dispatchTool(client, 'toon_channel_settle', { channelId: 'c1' });
    expect(settleChannel).toHaveBeenCalledWith({ channelId: 'c1' });
    expect(JSON.parse(res.content[0]!.text)).toMatchObject({ channelId: 'c1', txHash: '0xs' });
  });

  it('toon_http_fetch_paid forwards inputs and returns { status, headers, body }', async () => {
    const httpFetchPaid = vi.fn().mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'text/plain' },
      body: 'hello',
    });
    const client = stubClient({ httpFetchPaid });
    const res = await dispatchTool(client, 'toon_http_fetch_paid', {
      url: 'https://paid.example/resource',
      method: 'POST',
      headers: { 'x-test': '1' },
      body: 'payload',
      timeout: 5000,
    });
    expect(httpFetchPaid).toHaveBeenCalledWith({
      url: 'https://paid.example/resource',
      method: 'POST',
      headers: { 'x-test': '1' },
      body: 'payload',
      timeout: 5000,
    });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content[0]!.text)).toEqual({
      status: 200,
      headers: { 'content-type': 'text/plain' },
      body: 'hello',
    });
  });

  it('toon_http_fetch_paid coerces url and omits absent optional fields', async () => {
    const httpFetchPaid = vi
      .fn()
      .mockResolvedValue({ status: 200, headers: {}, body: '' });
    const client = stubClient({ httpFetchPaid });
    await dispatchTool(client, 'toon_http_fetch_paid', {
      url: 'https://paid.example/get',
    });
    expect(httpFetchPaid).toHaveBeenCalledWith({
      url: 'https://paid.example/get',
    });
  });

  it('reports a retry message when the daemon is bootstrapping', async () => {
    const client = stubClient({
      publish: vi
        .fn()
        .mockRejectedValue(
          new ControlApiError('bootstrapping', 503, true, 'BTP coming up')
        ),
    });
    const res = await dispatchTool(client, 'toon_publish', {
      event: { id: 'e' },
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/still bootstrapping/);
  });

  it('surfaces the actionable gas remedy on a 402, not the bootstrapping hint (#65)', async () => {
    // A 402 is flagged retryable-after-funding, so it MUST be handled before the
    // generic retryable "still bootstrapping" branch or the remedy is masked.
    const detail =
      'Settlement wallet 0x1 has no gas on evm to open a payment channel. ' +
      'Run toon_fund_wallet (or fund the wallet) and retry.';
    const client = stubClient({
      publish: vi
        .fn()
        .mockRejectedValue(new ControlApiError('insufficient_gas', 402, true, detail)),
    });
    const res = await dispatchTool(client, 'toon_publish', {
      event: { id: 'e' },
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toBe(detail);
    expect(res.content[0]!.text).not.toMatch(/still bootstrapping/);
  });

  it('reports an unreachable daemon clearly', async () => {
    const client = stubClient({
      status: vi
        .fn()
        .mockRejectedValue(new DaemonUnreachableError('http://127.0.0.1:8787')),
    });
    const res = await dispatchTool(client, 'toon_status', {});
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/not reachable/);
  });

  it('surfaces a non-retryable API error with its detail', async () => {
    const client = stubClient({
      publish: vi
        .fn()
        .mockRejectedValue(
          new ControlApiError('rejected', 502, false, 'F06 no parent')
        ),
    });
    const res = await dispatchTool(client, 'toon_publish', {
      event: { id: 'e' },
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toBe('rejected: F06 no parent');
  });

  it('returns an error for an unknown tool', async () => {
    const res = await dispatchTool(stubClient({}), 'toon_bogus', {});
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/Unknown tool/);
  });

  it('surfaces a 504 discovery timeout with a discovery-specific retry hint', async () => {
    const client = stubClient({
      addApex: vi
        .fn()
        .mockRejectedValue(
          new ControlApiError(
            'discovery_timeout',
            504,
            true,
            'Timed out after 15000ms'
          )
        ),
    });
    const res = await dispatchTool(client, 'toon_add_apex', {
      ilpAddress: 'g.x.town',
      relayUrl: 'ws://r',
    });
    expect(res.isError).toBe(true);
    // Discovery-specific hint, NOT the daemon-bootstrapping message.
    expect(res.content[0]!.text).toMatch(/Timed out after 15000ms/);
    expect(res.content[0]!.text).toMatch(/retry once the relay is reachable/);
    expect(res.content[0]!.text).not.toMatch(/bootstrapping/);
  });

  it('toon_targets lists registered relays + apexes', async () => {
    const targets = vi
      .fn()
      .mockResolvedValue({ relays: [{ relayUrl: 'ws://r' }], apexes: [] });
    const res = await dispatchTool(stubClient({ targets }), 'toon_targets', {});
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content[0]!.text).relays).toHaveLength(1);
  });

  it('toon_fund_wallet forwards an empty body when no args (fund self)', async () => {
    const fundWallet = vi.fn().mockResolvedValue({
      chain: 'evm',
      address: '0xabc',
      faucetUrl: 'u',
      status: 'pending',
      startedAt: 1,
    });
    const res = await dispatchTool(stubClient({ fundWallet }), 'toon_fund_wallet', {});
    expect(res.isError).toBeFalsy();
    expect(fundWallet).toHaveBeenCalledWith({});
    // Async submit: the text is a human message; the snapshot rides on
    // structuredContent (the iframe seam), not the JSON text body.
    expect(res.content[0]!.text).toMatch(/Drip submitted for evm to 0xabc/);
    expect(res.structuredContent).toMatchObject({ chain: 'evm', status: 'pending' });
  });

  it('toon_fund_wallet forwards chain + address when provided', async () => {
    const fundWallet = vi.fn().mockResolvedValue({
      chain: 'solana',
      address: 'So1',
      faucetUrl: 'u',
      status: 'pending',
      startedAt: 1,
    });
    await dispatchTool(stubClient({ fundWallet }), 'toon_fund_wallet', {
      chain: 'solana',
      address: 'So1',
    });
    expect(fundWallet).toHaveBeenCalledWith({ chain: 'solana', address: 'So1' });
  });

  it('toon_fund_status returns the tracked drip jobs', async () => {
    const fundStatus = vi.fn().mockResolvedValue({
      jobs: [
        { chain: 'mina', address: 'B62', faucetUrl: 'u', status: 'success', startedAt: 1, finishedAt: 2 },
      ],
    });
    const res = await dispatchTool(stubClient({ fundStatus }), 'toon_fund_status', {
      chain: 'mina',
    });
    expect(res.isError).toBeFalsy();
    expect(fundStatus).toHaveBeenCalledWith('mina');
    expect(JSON.parse(res.content[0]!.text).jobs).toHaveLength(1);
    expect(res.structuredContent).toMatchObject({ jobs: expect.any(Array) });
  });

  it('toon_fund_status forwards no chain when omitted (all jobs)', async () => {
    const fundStatus = vi.fn().mockResolvedValue({ jobs: [] });
    await dispatchTool(stubClient({ fundStatus }), 'toon_fund_status', {});
    expect(fundStatus).toHaveBeenCalledWith(undefined);
  });

  it('toon_add_relay forwards the relayUrl', async () => {
    const addRelay = vi.fn().mockResolvedValue({ relays: [], apexes: [] });
    await dispatchTool(stubClient({ addRelay }), 'toon_add_relay', {
      relayUrl: 'ws://r2',
    });
    expect(addRelay).toHaveBeenCalledWith({ relayUrl: 'ws://r2' });
  });

  it('toon_remove_relay forwards the relayUrl', async () => {
    const removeRelay = vi.fn().mockResolvedValue({ relays: [], apexes: [] });
    await dispatchTool(stubClient({ removeRelay }), 'toon_remove_relay', {
      relayUrl: 'ws://r2',
    });
    expect(removeRelay).toHaveBeenCalledWith({ relayUrl: 'ws://r2' });
  });

  it('toon_add_apex forwards discovery params (only those provided)', async () => {
    const addApex = vi.fn().mockResolvedValue({
      btpUrl: 'ws://a/btp',
      destination: 'g.x',
      chain: 'evm',
      ready: false,
    });
    await dispatchTool(stubClient({ addApex }), 'toon_add_apex', {
      ilpAddress: 'g.x.town',
      relayUrl: 'ws://r',
      childPeers: ['store', 'swap'],
    });
    expect(addApex).toHaveBeenCalledWith({
      ilpAddress: 'g.x.town',
      relayUrl: 'ws://r',
      childPeers: ['store', 'swap'],
    });
  });

  it('toon_remove_apex forwards the btpUrl', async () => {
    const removeApex = vi.fn().mockResolvedValue({ relays: [], apexes: [] });
    await dispatchTool(stubClient({ removeApex }), 'toon_remove_apex', {
      btpUrl: 'ws://a/btp',
    });
    expect(removeApex).toHaveBeenCalledWith({ btpUrl: 'ws://a/btp' });
  });

  it('toon_atoms returns the atom catalog as structuredContent and JSON text', async () => {
    const res = await dispatchTool(stubClient({}), 'toon_atoms', {});
    expect(res.isError).toBeFalsy();
    const atoms = res.structuredContent?.['atoms'] as { id: string }[];
    expect(atoms.some((a) => a.id === 'note-card')).toBe(true);
    const parsed = JSON.parse(res.content[0]!.text) as { atoms: { id: string }[] };
    expect(parsed.atoms.some((a) => a.id === 'note-card')).toBe(true);
  });

  it('toon_render validates and echoes a ViewSpec', async () => {
    const spec = { title: 'Feed', root: { atom: 'stack', children: [{ atom: 'note-card' }] } };
    const ok = await dispatchTool(stubClient({}), 'toon_render', { spec });
    expect(ok.isError).toBeFalsy();
    expect(ok.structuredContent?.['viewSpec']).toEqual(spec);

    const bad = await dispatchTool(stubClient({}), 'toon_render', {
      spec: { root: { atom: 'definitely-not-real' } },
    });
    expect(bad.isError).toBe(true);
  });

  it('toon_query forwards the filter and returns events', async () => {
    const query = vi.fn().mockResolvedValue({ events: [{ id: 'e1', kind: 1 }] });
    const res = await dispatchTool(stubClient({ query }), 'toon_query', {
      filter: { kinds: [1] },
      timeoutMs: 50,
    });
    expect(query).toHaveBeenCalledWith({ filters: { kinds: [1] }, timeoutMs: 50 });
    expect((res.structuredContent?.['events'] as unknown[]).length).toBe(1);
  });

  it('toon_query text carries a decision-sufficient note summary for text-only hosts', async () => {
    const note: NostrEvent = {
      id: 'n1',
      pubkey: 'ab'.repeat(32),
      created_at: 1_700_000_000,
      kind: 1,
      tags: [],
      content: 'gm from the timeline',
      sig: 's',
    };
    const query = vi.fn().mockResolvedValue({ events: [note] });
    const res = await dispatchTool(stubClient({ query }), 'toon_query', {
      filter: { kinds: [1] },
    });
    const text = res.content[0]!.text;
    // Author (abbreviated), an ISO timestamp, and the content excerpt — enough to
    // reason about the feed without rendering the card.
    expect(text).toMatch(/1 event\(s\) — 1 note/);
    expect(text).toMatch(/abababab…abab/);
    expect(text).toMatch(/2023-11-/);
    expect(text).toMatch(/gm from the timeline/);
  });

  it('toon_read text summarizes events and surfaces the drain cursor', async () => {
    const events = vi.fn().mockResolvedValue({
      events: [
        { id: 'n1', pubkey: 'cd'.repeat(32), created_at: 1_700_000_000, kind: 1, tags: [], content: 'hello', sig: 's' },
      ],
      cursor: 42,
      hasMore: true,
    });
    const res = await dispatchTool(stubClient({ events }), 'toon_read', { limit: 1 });
    expect(res.content[0]!.text).toMatch(/cursor 42/);
    expect(res.structuredContent).toMatchObject({ cursor: 42, hasMore: true });
  });

  it('toon_render text names the composed atoms for a text-only host', async () => {
    const spec = { title: 'Feed', root: { atom: 'stack', children: [{ atom: 'note-card' }] } };
    const res = await dispatchTool(stubClient({}), 'toon_render', { spec });
    expect(res.content[0]!.text).toMatch(/atoms: stack, note-card/);
    expect(res.content[0]!.text).toMatch(/toon_query \/ toon_read/);
  });
});

describe('summarizeEvents', () => {
  it('tallies reaction likes against the note they target', () => {
    const note: NostrEvent = {
      id: 'note1', pubkey: 'aa'.repeat(32), created_at: 1_700_000_000, kind: 1, tags: [], content: 'hi', sig: 's',
    };
    const like = (id: string): NostrEvent => ({
      id, pubkey: 'bb'.repeat(32), created_at: 1_700_000_001, kind: 7, tags: [['e', 'note1']], content: '+', sig: 's',
    });
    const text = summarizeEvents([note, like('r1'), like('r2')]);
    expect(text).toMatch(/2 reactions/);
    expect(text).toMatch(/2 likes/); // tallied onto the note line
  });

  it('is robust to empty input and to partial wire events', () => {
    expect(summarizeEvents([])).toBe('No matching events.');
    // A bare event missing pubkey/created_at/content must not throw.
    expect(() => summarizeEvents([{ id: 'e', kind: 1 } as unknown as NostrEvent])).not.toThrow();
  });
});
