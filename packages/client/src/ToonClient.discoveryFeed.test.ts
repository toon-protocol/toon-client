/**
 * The FULLY-CONSTRUCTED path (toon-client#550): a started client's real
 * `DiscoveryTracker` is fed by the relay subscription `start()` opens.
 *
 * `discovery-subscription.test.ts` covers the feed module in isolation; this
 * covers the wiring, which is where the defect actually lived — the tracker
 * was built and read from but never fed, so `resolveTerminatorEndpoint` saw
 * zero peers and every paid write from a fully-built client threw
 * `TERMINATOR_UNRESOLVED`. Tests that assemble partial state take the
 * no-tracker fallback and cannot see that. Here the tracker is core's real
 * one and only the relay wire is faked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NostrEvent } from 'nostr-tools/pure';
import { ToonClient } from './ToonClient.js';
import type { ToonClientConfig } from './types.js';

const subscribeMany = vi.fn();
const subClose = vi.fn();

vi.mock('nostr-tools/pool', () => ({
  SimplePool: vi.fn().mockImplementation(() => ({
    subscribeMany,
    close: vi.fn(),
  })),
}));

// Only bootstrap's network work is stubbed — `discoveryTracker` is core's
// real tracker, so what this asserts is real ingest, not a spy.
vi.mock('./modes/http.js', () => ({
  initializeHttpMode: vi.fn(async () => {
    const { createDiscoveryTracker } = await import('@toon-protocol/core');
    return {
      bootstrapService: {
        setClaimSigner: vi.fn(),
        bootstrap: vi.fn(async () => []),
      },
      discoveryTracker: createDiscoveryTracker({
        secretKey: new Uint8Array(32).fill(7),
      }),
      runtimeClient: {},
      adminClient: null,
      btpClient: null,
    };
  }),
}));

const RELAY_URL = 'wss://relay.discovery-feed.test';

const ANNOUNCE: NostrEvent = {
  id: 'announce-id',
  pubkey: 'bb'.repeat(32),
  created_at: 1_700_000_000,
  kind: 10032,
  tags: [],
  content: JSON.stringify({
    ilpAddress: 'g.toon.ario',
    httpEndpoint: 'http://store.test',
    assetCode: 'USD',
    assetScale: 6,
  }),
  sig: 'sig',
};

function baseConfig(): ToonClientConfig {
  return {
    mnemonic: 'test test test test test test test test test test test junk',
    connectorUrl: 'http://localhost:8080',
    relayUrl: RELAY_URL,
    destinationAddress: 'g.proxy',
    ilpInfo: {
      pubkey: '00'.repeat(32),
      ilpAddress: 'g.toon.test',
      assetCode: 'USD',
      assetScale: 6,
    },
    toonEncoder: (_e: NostrEvent) => new Uint8Array([1]),
    toonDecoder: (_b: Uint8Array) => ({}) as NostrEvent,
  } as ToonClientConfig;
}

/** The `onevent` handler `start()`'s subscription registered with the relay. */
function relayEventHandler(): (event: NostrEvent) => void {
  const params = subscribeMany.mock.calls[0]?.[2] as {
    onevent: (event: NostrEvent) => void;
  };
  expect(params).toBeDefined();
  return params.onevent;
}

describe('ToonClient.start — discovery tracker feed (toon-client#550)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    subscribeMany.mockReturnValue({ close: subClose });
  });

  it('subscribes to the configured relay for kind:10032', async () => {
    const client = new ToonClient(baseConfig());
    await client.start();

    const [relays, filter] = subscribeMany.mock.calls[0] as [
      string[],
      { kinds?: number[] },
    ];
    expect(relays).toEqual([RELAY_URL]);
    expect(filter.kinds).toEqual([10032]);
  });

  it('an announce arriving on that subscription reaches the started client’s tracker', async () => {
    const client = new ToonClient(baseConfig());
    await client.start();
    expect(client.getDiscoveredPeers()).toHaveLength(0);

    relayEventHandler()(ANNOUNCE);

    const peers = client.getDiscoveredPeers();
    expect(peers).toHaveLength(1);
    expect(peers[0]?.peerInfo.ilpAddress).toBe('g.toon.ario');
  });

  it('stop() closes the subscription', async () => {
    const client = new ToonClient(baseConfig());
    await client.start();
    await client.stop();

    expect(subClose).toHaveBeenCalledTimes(1);
  });
});

/**
 * PR #554 review correction: rig's standalone push pins `config.relayUrl` to
 * `''` and instead carries the relay its announces live on per peer, in
 * `knownPeers[].relayUrl`. The original fix only subscribed to
 * `config.relayUrl`, so on that shape the tracker stayed unfed and `start()`
 * even threw (`SimplePool.subscribeMany([''], …)` rejects synchronously)
 * instead of just failing to fix the bug.
 *
 * `toon-clientd` takes the other shape: `knownPeers: []` with its own resolved
 * relay threaded into `toonClientConfig.relayUrl` (`daemon/config.ts`), which
 * the first describe above covers. The all-empty case below is the remaining
 * shape — no relay from either source — and must still start.
 */
describe('ToonClient.start — discovery feed on rig standalone’s shape (empty relayUrl, real relay via knownPeers)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    subscribeMany.mockReturnValue({ close: subClose });
  });

  function knownPeersConfig(): ToonClientConfig {
    return {
      ...baseConfig(),
      relayUrl: '',
      knownPeers: [{ pubkey: 'cc'.repeat(32), relayUrl: RELAY_URL }],
    };
  }

  it('starts without throwing when config.relayUrl is empty', async () => {
    const client = new ToonClient(knownPeersConfig());
    await expect(client.start()).resolves.toBeDefined();
  });

  it('subscribes on knownPeers[].relayUrl, not the empty config.relayUrl', async () => {
    const client = new ToonClient(knownPeersConfig());
    await client.start();

    const [relays] = subscribeMany.mock.calls[0] as [string[]];
    expect(relays).toEqual([RELAY_URL]);
  });

  it('an announce on the knownPeers relay reaches the started client’s tracker', async () => {
    const client = new ToonClient(knownPeersConfig());
    await client.start();

    relayEventHandler()(ANNOUNCE);

    const peers = client.getDiscoveredPeers();
    expect(peers).toHaveLength(1);
    expect(peers[0]?.peerInfo.ilpAddress).toBe('g.toon.ario');
  });

  it('still starts, with no subscription opened, when relayUrl and knownPeers are both empty', async () => {
    const client = new ToonClient({
      ...baseConfig(),
      relayUrl: '',
      knownPeers: [],
    });

    await expect(client.start()).resolves.toBeDefined();
    expect(subscribeMany).not.toHaveBeenCalled();
  });
});
