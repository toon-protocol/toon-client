/**
 * `createDiscoveryTracker` (from `@toon-protocol/core`) does not own a
 * subscription — its own doc comment says callers "feed events in via
 * processEvent()". Nothing in this package ever called it (toon-client#550),
 * so every discovery tracker a started client built stayed empty forever and
 * `resolveTerminatorEndpoint` threw `TERMINATOR_UNRESOLVED` on every paid
 * write past the initially-bootstrapped peer.
 *
 * `subscribeToDiscovery` is that feed: a live relay subscription for
 * kind:10032 (`ILP_PEER_INFO_KIND`) announces, each handed to
 * `tracker.processEvent`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NostrEvent } from 'nostr-tools/pure';

const subscribeMany = vi.fn();
const poolClose = vi.fn();

vi.mock('nostr-tools/pool', () => ({
  SimplePool: vi.fn().mockImplementation(() => ({
    subscribeMany,
    close: poolClose,
  })),
}));

import { subscribeToDiscovery } from './discovery-subscription.js';

const ANNOUNCE: NostrEvent = {
  id: 'event-id',
  pubkey: 'aa'.repeat(32),
  created_at: 1000,
  kind: 10032,
  tags: [],
  content: JSON.stringify({
    ilpAddress: 'g.toon.relay',
    assetCode: 'USD',
    assetScale: 6,
  }),
  sig: 'sig',
};

describe('subscribeToDiscovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    subscribeMany.mockReturnValue({ close: vi.fn() });
  });

  it('subscribes on the given relay for kind:10032 only', async () => {
    const tracker = { processEvent: vi.fn() };

    await subscribeToDiscovery(['wss://relay.example'], tracker);

    expect(subscribeMany).toHaveBeenCalledTimes(1);
    const [relays, filter] = subscribeMany.mock.calls[0] as [
      string[],
      { kinds?: number[] },
    ];
    expect(relays).toEqual(['wss://relay.example']);
    expect(filter.kinds).toEqual([10032]);
  });

  it('forwards every event the relay sends to tracker.processEvent', async () => {
    const tracker = { processEvent: vi.fn() };

    await subscribeToDiscovery(['wss://relay.example'], tracker);

    const params = subscribeMany.mock.calls[0]?.[2] as {
      onevent: (event: NostrEvent) => void;
    };
    params.onevent(ANNOUNCE);

    expect(tracker.processEvent).toHaveBeenCalledWith(ANNOUNCE);
  });

  it('close() tears down both the subscription and the pool', async () => {
    const subClose = vi.fn();
    subscribeMany.mockReturnValue({ close: subClose });
    const tracker = { processEvent: vi.fn() };

    const sub = await subscribeToDiscovery(['wss://relay.example'], tracker);
    sub.close();

    expect(subClose).toHaveBeenCalledTimes(1);
    expect(poolClose).toHaveBeenCalledWith(['wss://relay.example']);
  });

  // toon-client#550 correction (PR #554 review): rig standalone pins
  // `config.relayUrl` to `''` and carries the real relay per peer in
  // `knownPeers[].relayUrl` instead, so an empty URL does reach this list.
  it('drops empty relay URLs instead of passing them to SimplePool', async () => {
    const tracker = { processEvent: vi.fn() };

    await subscribeToDiscovery(['', 'wss://relay.example', ''], tracker);

    expect(subscribeMany).toHaveBeenCalledTimes(1);
    const [relays] = subscribeMany.mock.calls[0] as [string[]];
    expect(relays).toEqual(['wss://relay.example']);
  });

  it('dedupes repeated relay URLs into a single subscribeMany call', async () => {
    const tracker = { processEvent: vi.fn() };

    await subscribeToDiscovery(
      ['wss://relay.example', 'wss://relay.example'],
      tracker
    );

    const [relays] = subscribeMany.mock.calls[0] as [string[]];
    expect(relays).toEqual(['wss://relay.example']);
  });

  it('is a no-op — no SimplePool constructed — when every relay URL is empty', async () => {
    const tracker = { processEvent: vi.fn() };

    const sub = await subscribeToDiscovery(['', ''], tracker);
    sub.close();

    expect(subscribeMany).not.toHaveBeenCalled();
    expect(poolClose).not.toHaveBeenCalled();
  });

  // toon-client#558: the installed @toon-protocol/core's parseIlpPeerInfo
  // destructures a fixed field list and drops anything else (the same gap
  // toon-client#544 hit for `notice`), so `requiredTransport` never survives
  // into what `tracker.processEvent` sees. It must be read off the raw event.
  describe('requiredTransportFor (issue #558)', () => {
    function announceWith(
      overrides: Record<string, unknown>,
      pubkey = 'aa'.repeat(32),
      createdAt = ANNOUNCE.created_at
    ): NostrEvent {
      return {
        ...ANNOUNCE,
        pubkey,
        created_at: createdAt,
        content: JSON.stringify({
          ilpAddress: 'g.toon.relay',
          assetCode: 'USD',
          assetScale: 6,
          ...overrides,
        }),
      };
    }

    function fireEvent(event: NostrEvent): void {
      const params = subscribeMany.mock.calls[0]?.[2] as {
        onevent: (event: NostrEvent) => void;
      };
      params.onevent(event);
    }

    it('reports requiredTransport from the raw announce content, keyed by pubkey', async () => {
      const tracker = { processEvent: vi.fn() };
      const sub = await subscribeToDiscovery(['wss://relay.example'], tracker);

      fireEvent(announceWith({ requiredTransport: 'btp' }, 'aa'.repeat(32)));

      expect(sub.requiredTransportFor('aa'.repeat(32))).toBe('btp');
    });

    it('reports undefined for a pubkey that never announced requiredTransport', async () => {
      const tracker = { processEvent: vi.fn() };
      const sub = await subscribeToDiscovery(['wss://relay.example'], tracker);

      fireEvent(announceWith({}, 'bb'.repeat(32)));

      expect(sub.requiredTransportFor('bb'.repeat(32))).toBeUndefined();
      expect(sub.requiredTransportFor('never-seen')).toBeUndefined();
    });

    it('clears a stale requiredTransport once the peer republishes without it', async () => {
      const tracker = { processEvent: vi.fn() };
      const sub = await subscribeToDiscovery(['wss://relay.example'], tracker);

      fireEvent(
        announceWith({ requiredTransport: 'btp' }, 'cc'.repeat(32), 1000)
      );
      expect(sub.requiredTransportFor('cc'.repeat(32))).toBe('btp');

      fireEvent(announceWith({}, 'cc'.repeat(32), 2000));
      expect(sub.requiredTransportFor('cc'.repeat(32))).toBeUndefined();
    });

    // toon-client#558 correction: createDiscoveryTracker.processEvent drops
    // any event with created_at <= the last one applied for that pubkey.
    // The requiredTransports map must apply the same monotonic guard, or a
    // stale replay (older created_at, field absent) racing in on a
    // multi-relay subscription can silently clear a live requiredTransport
    // and permanently misroute paid writes back onto HTTP-ILP.
    it('ignores a replayed older announce that omits requiredTransport', async () => {
      const tracker = { processEvent: vi.fn() };
      const sub = await subscribeToDiscovery(['wss://relay.example'], tracker);

      fireEvent(
        announceWith({ requiredTransport: 'btp' }, 'dd'.repeat(32), 2000)
      );
      expect(sub.requiredTransportFor('dd'.repeat(32))).toBe('btp');

      fireEvent(announceWith({}, 'dd'.repeat(32), 1000));
      expect(sub.requiredTransportFor('dd'.repeat(32))).toBe('btp');
    });

    it('the no-op (all-empty relay URLs) subscription still answers requiredTransportFor', async () => {
      const tracker = { processEvent: vi.fn() };
      const sub = await subscribeToDiscovery(['', ''], tracker);

      expect(sub.requiredTransportFor('anything')).toBeUndefined();
    });
  });
});
