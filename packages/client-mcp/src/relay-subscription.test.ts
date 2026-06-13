import { describe, it, expect, beforeEach } from 'vitest';
import type { NostrEvent } from 'nostr-tools/pure';
import {
  RelaySubscription,
  type MinimalWebSocket,
} from './relay-subscription.js';

/** A controllable in-memory WebSocket double driving the NIP-01 wire protocol. */
class FakeWebSocket implements MinimalWebSocket {
  sent: string[] = [];
  private handlers: Record<string, ((arg?: unknown) => void)[]> = {};
  closed = false;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, cb: any): void {
    (this.handlers[event] ??= []).push(cb);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.emit('close');
  }
  emit(event: string, arg?: unknown): void {
    for (const cb of this.handlers[event] ?? []) cb(arg);
  }
  /** Simulate the relay pushing a frame to the client. */
  push(frame: unknown[]): void {
    this.emit('message', JSON.stringify(frame));
  }
}

function makeEvent(id: string, kind = 1, created_at = 1000): NostrEvent {
  return {
    id,
    pubkey: 'pk',
    created_at,
    kind,
    tags: [],
    content: `c-${id}`,
    sig: 'sig',
  };
}

describe('RelaySubscription', () => {
  let sockets: FakeWebSocket[];
  let sub: RelaySubscription;

  beforeEach(() => {
    sockets = [];
    sub = new RelaySubscription({
      relayUrl: 'ws://relay.test',
      reconnectBaseMs: 5,
      reconnectMaxMs: 20,
      wsFactory: () => {
        const ws = new FakeWebSocket();
        sockets.push(ws);
        return ws;
      },
    });
  });

  function current(): FakeWebSocket {
    return sockets[sockets.length - 1]!;
  }

  it('sends a REQ when subscribing after connect', () => {
    sub.start();
    current().emit('open');
    const id = sub.subscribe({ kinds: [1] });
    const frame = JSON.parse(current().sent.at(-1)!);
    expect(frame[0]).toBe('REQ');
    expect(frame[1]).toBe(id);
    expect(frame[2]).toEqual({ kinds: [1] });
  });

  it('buffers EVENT frames and drains them with a cursor', () => {
    sub.start();
    current().emit('open');
    const id = sub.subscribe({ kinds: [1] });

    current().push(['EVENT', id, makeEvent('a')]);
    current().push(['EVENT', id, makeEvent('b')]);

    const first = sub.getEvents();
    expect(first.events.map((e) => e.id)).toEqual(['a', 'b']);
    expect(first.hasMore).toBe(false);

    // Cursor advances — draining again yields nothing until a new event lands.
    const empty = sub.getEvents({ cursor: first.cursor });
    expect(empty.events).toHaveLength(0);

    current().push(['EVENT', id, makeEvent('c')]);
    const next = sub.getEvents({ cursor: first.cursor });
    expect(next.events.map((e) => e.id)).toEqual(['c']);
  });

  it('decodes TOON-string EVENT payloads via the injected decoder', () => {
    const decoded = new RelaySubscription({
      relayUrl: 'ws://relay.test',
      // Simulate the TOON relay: the EVENT payload is a string, decoded here.
      decodeEvent: (raw) => ({ ...makeEvent('toon-1'), content: raw }),
      wsFactory: () => {
        const ws = new FakeWebSocket();
        sockets.push(ws);
        return ws;
      },
    });
    decoded.start();
    current().emit('open');
    const id = decoded.subscribe({ kinds: [1] });
    // Relay sends a TOON-encoded string as the 3rd element, not a JSON object.
    current().push(['EVENT', id, 'id: toon-1\nkind: 1\ncontent: hi']);
    const events = decoded.getEvents().events;
    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBe('toon-1');
  });

  it('drops a string EVENT payload when no decoder is configured', () => {
    sub.start();
    current().emit('open');
    const id = sub.subscribe({ kinds: [1] });
    current().push(['EVENT', id, 'id: x\nkind: 1']);
    expect(sub.getEvents().events).toHaveLength(0);
  });

  it('de-duplicates events by id', () => {
    sub.start();
    current().emit('open');
    const id = sub.subscribe({ kinds: [1] });
    current().push(['EVENT', id, makeEvent('dup')]);
    current().push(['EVENT', id, makeEvent('dup')]);
    expect(sub.getEvents().events).toHaveLength(1);
  });

  it('honors the limit and reports hasMore', () => {
    sub.start();
    current().emit('open');
    const id = sub.subscribe({ kinds: [1] });
    for (let i = 0; i < 5; i++)
      current().push(['EVENT', id, makeEvent(`e${i}`)]);
    const page = sub.getEvents({ limit: 2 });
    expect(page.events).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    const rest = sub.getEvents({ cursor: page.cursor });
    expect(rest.events.map((e) => e.id)).toEqual(['e2', 'e3', 'e4']);
  });

  it('filters drained events by subId', () => {
    sub.start();
    current().emit('open');
    const a = sub.subscribe({ kinds: [1] }, 'a');
    const b = sub.subscribe({ kinds: [2] }, 'b');
    current().push(['EVENT', a, makeEvent('x', 1)]);
    current().push(['EVENT', b, makeEvent('y', 2)]);
    expect(sub.getEvents({ subId: 'a' }).events.map((e) => e.id)).toEqual([
      'x',
    ]);
    expect(sub.getEvents({ subId: 'b' }).events.map((e) => e.id)).toEqual([
      'y',
    ]);
  });

  it('evicts oldest events when the buffer overflows', () => {
    const small = new RelaySubscription({
      relayUrl: 'ws://relay.test',
      bufferSize: 2,
      wsFactory: () => {
        const ws = new FakeWebSocket();
        sockets.push(ws);
        return ws;
      },
    });
    small.start();
    current().emit('open');
    const id = small.subscribe({ kinds: [1] });
    current().push(['EVENT', id, makeEvent('1')]);
    current().push(['EVENT', id, makeEvent('2')]);
    current().push(['EVENT', id, makeEvent('3')]);
    const all = small.getEvents();
    expect(all.events.map((e) => e.id)).toEqual(['2', '3']);
    // The evicted id is no longer de-dup-blocked: re-arrival re-buffers it.
    current().push(['EVENT', id, makeEvent('1')]);
    expect(small.getEvents().events.map((e) => e.id)).toContain('1');
  });

  it('re-issues active subscriptions on reconnect', async () => {
    sub.start();
    current().emit('open');
    sub.subscribe({ kinds: [1] }, 'persist');
    const firstSocket = current();

    // Drop the connection; a new socket should be created and re-send the REQ.
    firstSocket.emit('close');
    await new Promise((r) => setTimeout(r, 30));

    expect(sockets.length).toBeGreaterThanOrEqual(2);
    const reconnected = current();
    reconnected.emit('open');
    const reqFrames = reconnected.sent.map((s) => JSON.parse(s));
    expect(reqFrames.some((f) => f[0] === 'REQ' && f[1] === 'persist')).toBe(
      true
    );
  });

  it('sends CLOSE on unsubscribe and stops tracking it', () => {
    sub.start();
    current().emit('open');
    const id = sub.subscribe({ kinds: [1] });
    sub.unsubscribe(id);
    const frame = JSON.parse(current().sent.at(-1)!);
    expect(frame).toEqual(['CLOSE', id]);
    expect(sub.activeSubscriptions()).not.toContain(id);
  });

  it('ignores malformed frames without throwing', () => {
    sub.start();
    current().emit('open');
    sub.subscribe({ kinds: [1] });
    expect(() => current().emit('message', 'not json')).not.toThrow();
    expect(() => current().push([])).not.toThrow();
    expect(sub.getEvents().events).toHaveLength(0);
  });

  it('does not reconnect after close()', async () => {
    sub.start();
    current().emit('open');
    const before = sockets.length;
    sub.close();
    await new Promise((r) => setTimeout(r, 30));
    expect(sockets.length).toBe(before);
    expect(sub.isConnected()).toBe(false);
  });
});
