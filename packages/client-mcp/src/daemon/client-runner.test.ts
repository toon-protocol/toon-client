import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the SDK swap boundary so swap() can be unit-tested without a real mill
// (a faithful fake would have to unwrap the gift wrap + encrypt a FULFILL to the
// ephemeral key generated inside swap()).
vi.mock('@toon-protocol/sdk/swap', () => ({ streamSwap: vi.fn() }));
import { streamSwap } from '@toon-protocol/sdk/swap';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NostrEvent } from 'nostr-tools/pure';
import {
  ClientRunner,
  NotReadyError,
  PublishRejectedError,
  type ToonClientLike,
} from './client-runner.js';
import type { ResolvedDaemonConfig } from './config.js';
import { RelaySubscription } from '../relay-subscription.js';

let tmpDir: string;

function makeConfig(
  overrides: Partial<ResolvedDaemonConfig> = {}
): ResolvedDaemonConfig {
  return {
    httpPort: 8787,
    relayUrl: 'ws://relay.test',
    destination: 'g.townhouse.town',
    feePerEvent: 1n,
    chain: 'evm',
    apexChannelStorePath: join(tmpDir, 'apex-channels.json'),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    toonClientConfig: { btpUrl: 'ws://apex.test/btp' } as any,
    ...overrides,
  };
}

/** A controllable fake ToonClient with a mutable peerNegotiations map. */
class FakeClient implements ToonClientLike {
  peerNegotiations = new Map<string, unknown>();
  started = false;
  stopped = false;
  channels: Record<string, { nonce: number; cumulative: bigint }> = {};
  startImpl: () => Promise<void> = async () => {};
  publishImpl: (e: NostrEvent) => Promise<{
    success: boolean;
    eventId?: string;
    data?: string;
    error?: string;
  }> = async (e) => ({ success: true, eventId: e.id });

  async start(): Promise<{ peersDiscovered: number; mode: string }> {
    await this.startImpl();
    this.started = true;
    return { peersDiscovered: 0, mode: 'http' };
  }
  async stop(): Promise<void> {
    this.stopped = true;
  }
  getPublicKey(): string {
    return 'npub-hex';
  }
  getEvmAddress(): string | undefined {
    return '0xabc';
  }
  getSolanaAddress(): string | undefined {
    return undefined;
  }
  getMinaAddress(): string | undefined {
    return undefined;
  }
  getNetworkStatus():
    | { evm: string; solana: string; mina: string }
    | undefined {
    return { evm: 'configured', solana: 'unconfigured', mina: 'unconfigured' };
  }
  async publishEvent(event: NostrEvent): Promise<{
    success: boolean;
    eventId?: string;
    data?: string;
    error?: string;
  }> {
    return this.publishImpl(event);
  }
  async signBalanceProof(channelId: string, amount: bigint): Promise<unknown> {
    const ch = (this.channels[channelId] ??= { nonce: 0, cumulative: 0n });
    ch.nonce += 1;
    ch.cumulative += amount;
    return { channelId, signature: '0xsig' };
  }
  async openChannel(): Promise<string> {
    const id = 'chan-1';
    this.channels[id] ??= { nonce: 0, cumulative: 0n };
    return id;
  }
  getTrackedChannels(): string[] {
    return Object.keys(this.channels);
  }
  getChannelNonce(channelId: string): number {
    return this.channels[channelId]?.nonce ?? 0;
  }
  getChannelCumulativeAmount(channelId: string): bigint {
    return this.channels[channelId]?.cumulative ?? 0n;
  }
  async sendSwapPacket(): Promise<{ accepted: boolean; data?: string }> {
    return { accepted: true, data: 'c3dhcA==' };
  }
}

/** A relay that never opens a real socket (no wsFactory call until start). */
function fakeRelay(): RelaySubscription {
  return new RelaySubscription({
    relayUrl: 'ws://relay.test',
    wsFactory: () => ({
      send: () => {},
      close: () => {},
      on: () => {},
    }),
  });
}

describe('ClientRunner', () => {
  let client: FakeClient;
  let runner: ClientRunner;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'toon-runner-'));
    client = new FakeClient();
    runner = new ClientRunner({
      config: makeConfig({
        apex: {
          destination: 'g.townhouse.town',
          peerId: 'town',
          chain: 'evm',
          chainKey: 'evm:base:84532',
          chainId: 84532,
          settlementAddress: '0xapex',
          tokenAddress: '0xusdc',
          tokenNetwork: '0xtn',
        },
      }),
      createClient: () => client,
      createRelay: fakeRelay,
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports bootstrapping before ready, then ready after bootstrap', async () => {
    runner.start();
    expect(runner.isBootstrapping()).toBe(true);
    expect(runner.getStatus().bootstrapping).toBe(true);
    await runner.bootstrap();
    expect(runner.isReady()).toBe(true);
    expect(runner.getStatus().ready).toBe(true);
  });

  it('injects the apex negotiation into the ToonClient', async () => {
    await runner.bootstrap();
    expect(client.peerNegotiations.get('town')).toMatchObject({
      chainType: 'evm',
      settlementAddress: '0xapex',
      tokenNetwork: '0xtn',
    });
  });

  it('routes apex child peers through the same apex channel (one on-chain open)', async () => {
    // A client whose channelManager exposes the peerChannels map, like the real
    // ToonClient. Child peers must reuse the open apex channel, not open a 2nd.
    const childClient = new FakeClient();
    const peerChannels = new Map<string, string>();
    (childClient as unknown as { channelManager: unknown }).channelManager = {
      peerChannels,
    };
    const openSpy = vi.spyOn(childClient, 'openChannel');
    const r = new ClientRunner({
      config: makeConfig({
        apex: {
          destination: 'g.townhouse.town',
          peerId: 'town',
          chain: 'evm',
          chainKey: 'evm:base:84532',
          chainId: 84532,
          settlementAddress: '0xapex',
          tokenAddress: '0xusdc',
          tokenNetwork: '0xtn',
        },
        apexChildPeers: ['dvm', 'mill'],
      }),
      createClient: () => childClient,
      createRelay: fakeRelay,
    });
    await r.bootstrap();

    // Each child gets the apex negotiation injected...
    for (const peer of ['dvm', 'mill']) {
      expect(childClient.peerNegotiations.get(peer)).toMatchObject({
        chainType: 'evm',
        settlementAddress: '0xapex',
        tokenNetwork: '0xtn',
      });
      // ...and is pre-mapped to the already-open apex channel.
      expect(peerChannels.get(peer)).toBe('chan-1');
    }
    // The apex channel opened exactly once; children reuse it (no re-deposit).
    expect(openSpy).toHaveBeenCalledTimes(1);
  });

  it('skips child-peer routing when none are configured (back-compat)', async () => {
    await runner.bootstrap();
    expect(client.peerNegotiations.has('dvm')).toBe(false);
    expect(client.peerNegotiations.has('mill')).toBe(false);
  });

  it('persists the apex channelId after first open', async () => {
    await runner.bootstrap();
    const saved = JSON.parse(
      readFileSync(join(tmpDir, 'apex-channels.json'), 'utf8')
    );
    expect(saved['g.townhouse.town|evm'].channelId).toBe('chan-1');
    expect(saved['g.townhouse.town|evm'].context).toMatchObject({
      chainType: 'evm',
      chainId: 84532,
      recipient: '0xapex',
    });
  });

  it('resumes (tracks) the saved channel on restart instead of re-opening', async () => {
    // Seed a saved apex channel + a client whose channelManager records tracking.
    writeFileSync(
      join(tmpDir, 'apex-channels.json'),
      JSON.stringify({
        'g.townhouse.town|evm': {
          channelId: 'existing-chan',
          context: {
            chainType: 'evm',
            chainId: 84532,
            tokenNetworkAddress: '0xtn',
            recipient: '0xapex',
          },
        },
      })
    );
    const tracked: { id: string }[] = [];
    const trackingClient = new FakeClient();
    const openSpy = vi.spyOn(trackingClient, 'openChannel');
    // Give the fake a channelManager.trackChannel like the real ToonClient.
    (trackingClient as unknown as { channelManager: unknown }).channelManager =
      {
        trackChannel: (id: string) => {
          tracked.push({ id });
          trackingClient.channels[id] = { nonce: 7, cumulative: 7n };
        },
      };
    const r = new ClientRunner({
      config: makeConfig({
        apex: {
          destination: 'g.townhouse.town',
          peerId: 'town',
          chain: 'evm',
          chainKey: 'evm:base:84532',
          chainId: 84532,
          settlementAddress: '0xapex',
          tokenNetwork: '0xtn',
        },
      }),
      createClient: () => trackingClient,
      createRelay: fakeRelay,
    });
    await r.bootstrap();
    expect(r.isReady()).toBe(true);
    expect(tracked).toEqual([{ id: 'existing-chan' }]);
    expect(openSpy).not.toHaveBeenCalled(); // no re-open / re-deposit
    // Publishes continue from the resumed channel.
    const res = await r.publish({ event: { id: 'e' } as NostrEvent });
    expect(res.channelId).toBe('existing-chan');
  });

  it('records lastError when bootstrap fails and stays not-ready', async () => {
    client.startImpl = async () => {
      throw new Error('anon never bound');
    };
    await runner.bootstrap();
    expect(runner.isReady()).toBe(false);
    expect(runner.getStatus().lastError).toContain('anon never bound');
  });

  it('publish throws NotReadyError while bootstrapping', async () => {
    await expect(
      runner.publish({ event: { id: 'x' } as any })
    ).rejects.toBeInstanceOf(NotReadyError);
  });

  it('publish signs a claim, advances the nonce, and returns it', async () => {
    await runner.bootstrap();
    const event = { id: 'evt1' } as NostrEvent;
    const res = await runner.publish({ event });
    expect(res.eventId).toBe('evt1');
    expect(res.channelId).toBe('chan-1');
    expect(res.nonce).toBe(1);
    const res2 = await runner.publish({ event: { id: 'evt2' } as NostrEvent });
    expect(res2.nonce).toBe(2);
  });

  it('publish surfaces a relay rejection as PublishRejectedError', async () => {
    await runner.bootstrap();
    client.publishImpl = async () => ({
      success: false,
      error: 'F06 no parent',
    });
    await expect(
      runner.publish({ event: { id: 'e' } as NostrEvent })
    ).rejects.toBeInstanceOf(PublishRejectedError);
  });

  it('lists channels with nonce watermark and cumulative amount', async () => {
    await runner.bootstrap();
    await runner.publish({ event: { id: 'e1' } as NostrEvent, fee: '5' });
    const { channels } = runner.getChannels();
    expect(channels).toEqual([
      { channelId: 'chan-1', nonce: 1, cumulativeAmount: '5' },
    ]);
  });

  it('maps getNetworkStatus into per-chain ChainStatus[]', async () => {
    await runner.bootstrap();
    const net = runner.getStatus().network;
    expect(net).toEqual([
      { chain: 'evm', ready: true, detail: 'configured' },
      { chain: 'solana', ready: false, detail: 'unconfigured' },
      { chain: 'mina', ready: false, detail: 'unconfigured' },
    ]);
  });

  it('swap streams via streamSwap and maps the accumulated claims', async () => {
    await runner.bootstrap();
    const pair = {
      from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:base:84532' },
      to: { assetCode: 'USDC', assetScale: 6, chain: 'solana:devnet' },
      rate: '1.0',
    };
    vi.mocked(streamSwap).mockResolvedValue({
      state: 'completed',
      claims: [
        {
          packetIndex: 0,
          sourceAmount: 1000n,
          targetAmount: 999n,
          claimBytes: new Uint8Array([1, 2, 3, 4]),
          millEphemeralPubkey: 'ab'.repeat(32),
          claimId: 'claim-1',
          channelId: '1111',
          recipient: 'SoLrecipient',
          millSignerAddress: 'MILLsigner',
          nonce: '1',
          cumulativeAmount: '999',
          pair,
          receivedAt: 0,
        },
      ],
      rejections: [],
      errors: [],
      abortReason: 'complete',
      cumulativeSource: 1000n,
      cumulativeTarget: 999n,
      packetsSent: 1,
      packetsScheduled: 1,
    } as unknown as Awaited<ReturnType<typeof streamSwap>>);

    const res = await runner.swap({
      destination: 'g.townhouse.mill',
      amount: '1000',
      millPubkey: 'cd'.repeat(32),
      pair,
      chainRecipient: 'SoLrecipient',
    });

    // streamSwap got the request params (default single packet).
    const arg = vi.mocked(streamSwap).mock.calls[0]![0];
    expect(arg.millIlpAddress).toBe('g.townhouse.mill');
    expect(arg.millPubkey).toBe('cd'.repeat(32));
    expect(arg.totalAmount).toBe(1000n);
    expect(arg.chainRecipient).toBe('SoLrecipient');
    expect(arg.packetCount).toBe(1);

    // The accumulated claim is mapped (claimBytes → base64).
    expect(res.accepted).toBe(true);
    expect(res.packetsAccepted).toBe(1);
    expect(res.cumulativeTarget).toBe('999');
    expect(res.state).toBe('completed');
    expect(res.claims[0]).toMatchObject({
      sourceAmount: '1000',
      targetAmount: '999',
      claim: Buffer.from([1, 2, 3, 4]).toString('base64'),
      channelId: '1111',
      recipient: 'SoLrecipient',
      millSignerAddress: 'MILLsigner',
      claimId: 'claim-1',
    });
  });

  it('swap surfaces a mill rejection (no claims) as not-accepted', async () => {
    await runner.bootstrap();
    const pair = {
      from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:base:84532' },
      to: { assetCode: 'USDC', assetScale: 6, chain: 'solana:devnet' },
      rate: '1.0',
    };
    vi.mocked(streamSwap).mockResolvedValue({
      state: 'failed',
      claims: [],
      rejections: [
        {
          packetIndex: 0,
          sourceAmount: 1000n,
          code: 'F99',
          message: 'Payment rejected',
        },
      ],
      errors: [],
      abortReason: 'all-rejected',
      cumulativeSource: 0n,
      cumulativeTarget: 0n,
      packetsSent: 1,
      packetsScheduled: 1,
    } as unknown as Awaited<ReturnType<typeof streamSwap>>);

    const res = await runner.swap({
      destination: 'g.townhouse.mill',
      amount: '1000',
      millPubkey: 'cd'.repeat(32),
      pair,
      chainRecipient: 'SoLrecipient',
    });
    expect(res.accepted).toBe(false);
    expect(res.packetsAccepted).toBe(0);
    expect(res.code).toBe('F99');
    expect(res.message).toBe('Payment rejected');
  });

  it('subscribe + getEvents delegate to the relay subscription', async () => {
    const { subId } = runner.subscribe({ filters: { kinds: [1] } });
    expect(typeof subId).toBe('string');
    expect(runner.getEvents({}).events).toEqual([]);
  });

  it('throws if peerNegotiations layout changed', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).peerNegotiations = undefined;
    await runner.bootstrap();
    expect(runner.getStatus().lastError).toContain(
      'peerNegotiations layout changed'
    );
  });
});
