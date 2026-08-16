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

// ── swapVerifyingContracts (toon-client#583) ─────────────────────────────────
//
// The maker's LEG-B RollingSwapChannel per chain. `@toon-protocol/core`'s
// `parseIlpPeerInfo` (still, at core@3.4.0) destructures a fixed field list
// and drops this one, so it can only be read off the raw announce content —
// exactly as `requiredTransport` is.

const MAKER = 'cd'.repeat(32);
const LEG_B = { 'evm:84532': '0xd329aBf86ceae23F904641F992ca90e3721FeF83' };

function makerAnnounce(
  content: Record<string, unknown>,
  createdAt = 1000
): NostrEvent {
  return {
    id: 'maker-' + createdAt,
    pubkey: MAKER,
    created_at: createdAt,
    kind: 10032,
    tags: [],
    content: JSON.stringify({
      ilpAddress: 'g.toon.swap.maker',
      assetCode: 'USD',
      assetScale: 6,
      ...content,
    }),
    sig: 'sig',
  };
}

async function feed(events: NostrEvent[]) {
  const tracker = { processEvent: vi.fn() };
  const sub = await subscribeToDiscovery(['wss://relay.example'], tracker);
  // The LAST call — a test may open more than one subscription.
  const params = subscribeMany.mock.calls.at(-1)?.[2] as {
    onevent: (event: NostrEvent) => void;
  };
  for (const event of events) params.onevent(event);
  return sub;
}

describe('subscribeToDiscovery — swapVerifyingContracts (#583)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    subscribeMany.mockReturnValue({ close: vi.fn() });
  });

  it("exposes the maker's announced leg-B map, which parseIlpPeerInfo drops", async () => {
    const sub = await feed([
      makerAnnounce({
        // Both keys present, as the live maker announces them (swap#134).
        tokenNetworks: {
          'evm:84532': '0xa79C3b1dbcEA00a6d84735a134395D8eF6D6a478',
        },
        swapVerifyingContracts: LEG_B,
      }),
    ]);
    expect(sub.swapVerifyingContractsFor(MAKER)).toEqual(LEG_B);
    // Leg A is NOT what this returns — that substitution is the whole bug.
    expect(sub.swapVerifyingContractsFor(MAKER)!['evm:84532']).not.toBe(
      '0xa79C3b1dbcEA00a6d84735a134395D8eF6D6a478'
    );
  });

  it('is undefined for an announcer that carries no map, and for an unknown pubkey', async () => {
    const sub = await feed([makerAnnounce({})]);
    expect(sub.swapVerifyingContractsFor(MAKER)).toBeUndefined();
    expect(sub.swapVerifyingContractsFor('ff'.repeat(32))).toBeUndefined();
  });

  it('a FRESH announce that drops the map clears it; a STALE replay changes nothing', async () => {
    const sub = await feed([
      makerAnnounce({ swapVerifyingContracts: LEG_B }, 1000),
      // Stale replay with no map — must NOT clear the live one.
      makerAnnounce({}, 900),
    ]);
    expect(sub.swapVerifyingContractsFor(MAKER)).toEqual(LEG_B);

    const sub2 = await feed([
      makerAnnounce({ swapVerifyingContracts: LEG_B }, 1000),
      makerAnnounce({}, 2000),
    ]);
    expect(sub2.swapVerifyingContractsFor(MAKER)).toBeUndefined();
  });

  it('ignores non-string / non-object shapes rather than throwing', async () => {
    const sub = await feed([
      makerAnnounce({ swapVerifyingContracts: ['not', 'a', 'map'] }),
    ]);
    expect(sub.swapVerifyingContractsFor(MAKER)).toBeUndefined();

    const sub2 = await feed([
      makerAnnounce({
        swapVerifyingContracts: { 'evm:84532': 42, 'evm:1': '0xabc' },
      }),
    ]);
    expect(sub2.swapVerifyingContractsFor(MAKER)).toEqual({ 'evm:1': '0xabc' });
  });

  it('requiredTransport and swapVerifyingContracts advance off the SAME announce', async () => {
    const sub = await feed([
      makerAnnounce(
        { requiredTransport: 'btp', swapVerifyingContracts: LEG_B },
        1000
      ),
    ]);
    expect(sub.requiredTransportFor(MAKER)).toBe('btp');
    expect(sub.swapVerifyingContractsFor(MAKER)).toEqual(LEG_B);
  });
});
