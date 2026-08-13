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

  // toon-client#550 correction (PR #554 review): both first-party consumers
  // (toon-clientd, rig standalone) pin `config.relayUrl` to `''` and carry
  // the real relay per peer in `knownPeers[].relayUrl` instead.
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
});
