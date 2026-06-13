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
        'toon_channels',
        'toon_identity',
        'toon_open_channel',
        'toon_publish',
        'toon_read',
        'toon_status',
        'toon_swap',
        'toon_subscribe',
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

  it('toon_swap coerces destination/amount to strings', async () => {
    const swap = vi.fn().mockResolvedValue({ accepted: true });
    const client = stubClient({ swap });
    await dispatchTool(client, 'toon_swap', {
      destination: 'g.toon.mill',
      amount: 100,
    });
    expect(swap).toHaveBeenCalledWith({
      destination: 'g.toon.mill',
      amount: '100',
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
});
