import { describe, it, expect, vi } from 'vitest';
import { dispatchTool, TOOL_DEFINITIONS } from './mcp-tools.js';
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
        'toon_channels',
        'toon_identity',
        'toon_open_channel',
        'toon_publish',
        'toon_publish_unsigned',
        'toon_query',
        'toon_render',
        'toon_upload_media',
        'toon_read',
        'toon_status',
        'toon_swap',
        'toon_http_fetch_paid',
        'toon_subscribe',
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
});

describe('dispatchTool', () => {
  it('toon_status returns the daemon status as JSON text', async () => {
    const client = stubClient({
      status: vi.fn().mockResolvedValue({ ready: true, bootstrapping: false }),
    });
    const res = await dispatchTool(client, 'toon_status', {});
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content[0]!.text)).toMatchObject({ ready: true });
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
      destination: 'g.toon.mill',
      amount: 100,
      millPubkey: 'cd'.repeat(32),
      pair,
      chainRecipient: 'SoLrecipient',
      packetCount: 2,
    });
    expect(swap).toHaveBeenCalledWith({
      destination: 'g.toon.mill',
      amount: '100',
      millPubkey: 'cd'.repeat(32),
      pair,
      chainRecipient: 'SoLrecipient',
      packetCount: 2,
    });
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
          new ControlApiError('bootstrapping', 503, true, 'anon coming up')
        ),
    });
    const res = await dispatchTool(client, 'toon_publish', {
      event: { id: 'e' },
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/still bootstrapping/);
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
      childPeers: ['dvm', 'mill'],
    });
    expect(addApex).toHaveBeenCalledWith({
      ilpAddress: 'g.x.town',
      relayUrl: 'ws://r',
      childPeers: ['dvm', 'mill'],
    });
  });

  it('toon_remove_apex forwards the btpUrl', async () => {
    const removeApex = vi.fn().mockResolvedValue({ relays: [], apexes: [] });
    await dispatchTool(stubClient({ removeApex }), 'toon_remove_apex', {
      btpUrl: 'ws://a/btp',
    });
    expect(removeApex).toHaveBeenCalledWith({ btpUrl: 'ws://a/btp' });
  });

  it('toon_atoms returns the atom catalog as structuredContent', async () => {
    const res = await dispatchTool(stubClient({}), 'toon_atoms', {});
    expect(res.isError).toBeFalsy();
    const atoms = res.structuredContent?.['atoms'] as { id: string }[];
    expect(atoms.some((a) => a.id === 'note-card')).toBe(true);
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
});
