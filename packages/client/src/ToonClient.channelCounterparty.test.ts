/**
 * A channel is opened against the counterparty that TERMINATES the
 * destination — never against whichever peer happened to be negotiated first
 * (issue #565).
 *
 * Live symptom this locks down: with a client bootstrapped only against the
 * relay, `openChannel('g.toon.ario')` opened an on-chain channel whose
 * participant1 was the RELAY's settlement address. The store's connector then
 * refused every upload with `F01 - claim rejected: names a channel this
 * connector has no record of, so there is no counterparty to verify its
 * signature against`, making blob uploads impossible for any client. The cause
 * was `resolvePeerId`'s "fall back to the FIRST peer" branch: the destination
 * played no part in choosing the counterparty.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ToonClient } from './ToonClient.js';
import { FakeTerminatingConnector } from './wire/fake-connector.test-support.js';
import type { PeerNegotiation } from './channel/ChannelManager.js';

const CHAIN = 'evm:84532';
const RELAY_PUBKEY = 'a'.repeat(64);
const STORE_PUBKEY = 'b'.repeat(64);
/** As `BootstrapService` keys its results: `nostr-<pubkey.slice(0,16)>`. */
const RELAY_PEER_ID = `nostr-${RELAY_PUBKEY.slice(0, 16)}`;
const STORE_PEER_ID = `nostr-${STORE_PUBKEY.slice(0, 16)}`;
const RELAY_SETTLEMENT = '0x3F43d923a611bCB2D0Bfb5d6ee2C3AC3EfEaf308';
const STORE_SETTLEMENT = '0x6b6c2dacf7ac1f1273f72bef2e6084f9ee6d3bff';
const TOKEN_NETWORK = '0xa79C3b1dbcEA00a6d84735a134395D8eF6D6a478';
const CHANNEL_ID = '0x' + 'cc'.repeat(32);

function baseConfig() {
  return {
    secretKey: new Uint8Array(32).fill(7),
    connectorUrl: 'http://connector.test',
    destinationAddress: 'g.toon.relay',
    supportedChains: [CHAIN],
    ilpInfo: { pubkey: '0'.repeat(64), ilpAddress: 'g.toon.test' },
    toonEncoder: (_e: unknown) => new Uint8Array([1, 2, 3, 4]),
    toonDecoder: (_t: string) => ({}) as never,
  } as unknown as ConstructorParameters<typeof ToonClient>[0];
}

/** A kind:10032 announce as `DiscoveryTracker.getAllDiscoveredPeers` yields it. */
function announce(opts: {
  pubkey: string;
  peerId: string;
  address: string;
  settlementAddress: string;
}) {
  return {
    pubkey: opts.pubkey,
    peerId: opts.peerId,
    discoveredAt: 0,
    peerInfo: {
      pubkey: opts.pubkey,
      ilpAddress: opts.address,
      ilpAddresses: [opts.address],
      btpEndpoint: 'wss://edge.test/btp',
      httpEndpoint: 'https://edge.test/ilp',
      assetCode: 'USD',
      assetScale: 6,
      supportedChains: [CHAIN],
      settlementAddresses: { [CHAIN]: opts.settlementAddress },
      tokenNetworks: { [CHAIN]: TOKEN_NETWORK },
    },
  };
}

const RELAY_NEGOTIATION: PeerNegotiation = {
  chain: CHAIN,
  chainType: 'evm',
  chainId: 84532,
  settlementAddress: RELAY_SETTLEMENT,
  tokenNetwork: TOKEN_NETWORK,
};

/**
 * A started client that has bootstrapped ONLY the relay (the shipped genesis
 * seed is a single peer) while discovery has landed BOTH announces — the exact
 * state the live run was in.
 */
function startedClient(opts: {
  peers?: ReturnType<typeof announce>[];
  negotiations?: [string, PeerNegotiation][];
}) {
  const client = new ToonClient(baseConfig());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (client as any).state = {
    bootstrapService: {},
    discoveryTracker: { getAllDiscoveredPeers: () => opts.peers ?? [] },
    discoverySubscription: { requiredTransportFor: () => undefined },
    runtimeClient: {},
    peersDiscovered: (opts.peers ?? []).length,
  };

  const ensureChannel = vi.fn(async () => CHANNEL_ID);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (client as any).channelManager = { ensureChannel };

  const negotiations = opts.negotiations ?? [
    [RELAY_PEER_ID, RELAY_NEGOTIATION],
  ];
  for (const [peerId, negotiation] of negotiations) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).peerNegotiations.set(peerId, negotiation);
  }

  return { client, ensureChannel };
}

let connector: FakeTerminatingConnector;
let realFetch: typeof fetch;

beforeEach(() => {
  connector = new FakeTerminatingConnector();
  realFetch = globalThis.fetch;
  globalThis.fetch = connector.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const RELAY_ANNOUNCE = () =>
  announce({
    pubkey: RELAY_PUBKEY,
    peerId: RELAY_PEER_ID,
    address: 'g.toon.relay',
    settlementAddress: RELAY_SETTLEMENT,
  });

const STORE_ANNOUNCE = () =>
  announce({
    pubkey: STORE_PUBKEY,
    peerId: STORE_PEER_ID,
    address: 'g.toon.ario',
    settlementAddress: STORE_SETTLEMENT,
  });

describe('openChannel picks the counterparty from the destination (issue #565)', () => {
  it("opens against the STORE's announced settlement address, not the only negotiated peer's", async () => {
    const { client, ensureChannel } = startedClient({
      peers: [RELAY_ANNOUNCE(), STORE_ANNOUNCE()],
    });

    await client.openChannel('g.toon.ario');

    expect(ensureChannel).toHaveBeenCalledTimes(1);
    const [peerId, negotiation] = ensureChannel.mock.calls[0] as unknown as [
      string,
      PeerNegotiation,
    ];
    expect(peerId).toBe(STORE_PEER_ID);
    expect(negotiation.settlementAddress).toBe(STORE_SETTLEMENT);
    // Emphatically NOT the relay's — that is the bug this replaces.
    expect(negotiation.settlementAddress).not.toBe(RELAY_SETTLEMENT);
  });

  it('still uses the already-negotiated peer for the destination it terminates', async () => {
    const { client, ensureChannel } = startedClient({
      peers: [RELAY_ANNOUNCE(), STORE_ANNOUNCE()],
    });

    await client.openChannel('g.toon.relay');

    const [peerId, negotiation] = ensureChannel.mock.calls[0] as unknown as [
      string,
      PeerNegotiation,
    ];
    expect(peerId).toBe(RELAY_PEER_ID);
    expect(negotiation.settlementAddress).toBe(RELAY_SETTLEMENT);
  });

  it('remembers the announce-derived negotiation so a second open reuses it', async () => {
    const { client, ensureChannel } = startedClient({
      peers: [RELAY_ANNOUNCE(), STORE_ANNOUNCE()],
    });

    await client.openChannel('g.toon.ario');
    await client.openChannel('g.toon.ario');

    expect(ensureChannel).toHaveBeenCalledTimes(2);
    for (const call of ensureChannel.mock.calls) {
      expect((call as unknown as [string])[0]).toBe(STORE_PEER_ID);
    }
  });

  it('keys off the destination rather than an arbitrary peer when SEVERAL are negotiated and none is announced', async () => {
    // No announce claims `g.toon.ario`, and two peers are negotiated — "the
    // first one" would be pure map-insertion order. The destination itself
    // becomes the key so the greeting bootstrap (connector #617) can settle
    // it, and neither negotiated peer's settlement address is borrowed.
    const { client, ensureChannel } = startedClient({
      peers: [],
      negotiations: [
        [RELAY_PEER_ID, RELAY_NEGOTIATION],
        [STORE_PEER_ID, { ...RELAY_NEGOTIATION, settlementAddress: 'x' }],
      ],
    });

    // The fake connector's greeting carries no settlement terms, so the
    // bootstrap declines rather than opening against a guessed counterparty.
    await expect(client.openChannel('g.toon.ario')).rejects.toMatchObject({
      code: 'PEER_NOT_NEGOTIATED',
    });
    expect(ensureChannel).not.toHaveBeenCalled();
  });

  it('keeps the single-uplink fallback: one negotiated peer, no announce, still resolves', async () => {
    const { client, ensureChannel } = startedClient({ peers: [] });

    await client.openChannel('g.proxy.relay');

    const [peerId] = ensureChannel.mock.calls[0] as unknown as [string];
    expect(peerId).toBe(RELAY_PEER_ID);
  });
});

describe('publishEvent claims are drawn on the destination’s counterparty', () => {
  it('resolves the claim against the terminating peer, not the first negotiation', async () => {
    const { client, ensureChannel } = startedClient({
      peers: [RELAY_ANNOUNCE(), STORE_ANNOUNCE()],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).channelManager.signBalanceProof = vi.fn(async () => {
      throw new Error('stop-after-ensureChannel');
    });

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).resolveClaimForDestination('g.toon.ario', 1n)
    ).rejects.toThrow('stop-after-ensureChannel');

    const [peerId, negotiation] = ensureChannel.mock.calls[0] as unknown as [
      string,
      PeerNegotiation,
    ];
    expect(peerId).toBe(STORE_PEER_ID);
    expect(negotiation.settlementAddress).toBe(STORE_SETTLEMENT);
  });
});
