import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the SDK swap boundary so swap() can be unit-tested without a real mill
// (a faithful fake would have to unwrap the gift wrap + encrypt a FULFILL to the
// ephemeral key generated inside swap()).
vi.mock('@toon-protocol/sdk/swap', () => ({ streamSwap: vi.fn() }));
import { streamSwap } from '@toon-protocol/sdk/swap';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NostrEvent, EventTemplate } from 'nostr-tools/pure';
import {
  ClientRunner,
  InvalidPayloadError,
  NotReadyError,
  PublishRejectedError,
  TargetError,
  type ToonClientLike,
} from './client-runner.js';
import type { ResolvedDaemonConfig } from './config.js';
import { RelaySubscription } from '../relay-subscription.js';
import { ILP_PEER_INFO_KIND } from '@toon-protocol/core';
import { loadTargets } from './targets-store.js';

let tmpDir: string;

function makeConfig(
  overrides: Partial<ResolvedDaemonConfig> = {}
): ResolvedDaemonConfig {
  const base = {
    httpPort: 8787,
    relayUrl: 'ws://relay.test',
    hasUplink: true,
    destination: 'g.proxy',
    feePerEvent: 1n,
    chain: 'evm' as const,
    apexChannelStorePath: join(tmpDir, 'apex-channels.json'),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    toonClientConfig: { btpUrl: 'ws://apex.test/btp' } as any,
    ...overrides,
  };
  // Mirror resolveConfig: publish/store destinations fall back to `destination`.
  return {
    ...base,
    publishDestination: overrides.publishDestination ?? base.destination,
    storeDestination: overrides.storeDestination ?? base.destination,
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
  /** Records the destination passed on the last publishEvent call. */
  lastPublishDest?: string;
  async publishEvent(
    event: NostrEvent,
    options?: { destination?: string }
  ): Promise<{
    success: boolean;
    eventId?: string;
    data?: string;
    error?: string;
  }> {
    this.lastPublishDest = options?.destination;
    return this.publishImpl(event);
  }
  async signBalanceProof(channelId: string, amount: bigint): Promise<unknown> {
    const ch = (this.channels[channelId] ??= { nonce: 0, cumulative: 0n });
    ch.nonce += 1;
    ch.cumulative += amount;
    return { channelId, signature: '0xsig' };
  }
  /** Records the last template signed, and returns a deterministic signed event. */
  lastSigned?: EventTemplate;
  signEvent(template: EventTemplate): NostrEvent {
    this.lastSigned = template;
    return {
      id: `signed-${template.kind}-${template.created_at}`,
      pubkey: this.getPublicKey(),
      sig: '0xsig',
      created_at: template.created_at,
      kind: template.kind,
      tags: template.tags,
      content: template.content,
    };
  }
  uploadImpl: () => Promise<{
    success: boolean;
    txId?: string;
    eventId?: string;
    error?: string;
  }> = async () => ({ success: true, txId: 'tx-abc', eventId: 'blob-evt' });
  /** Records the destination passed on the last uploadBlob call. */
  lastUploadDest?: string;
  async uploadBlob(params?: { destination?: string }): Promise<{
    success: boolean;
    txId?: string;
    eventId?: string;
    error?: string;
  }> {
    this.lastUploadDest = params?.destination;
    return this.uploadImpl();
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
  async h402Fetch(): Promise<Response> {
    return new Response('hello', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    });
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
  let prevHome: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'toon-runner-'));
    // Isolate from the user's real ~/.toon-client (persisted targets.json,
    // channel stores) so tests never read or write live state.
    prevHome = process.env['TOON_CLIENT_HOME'];
    process.env['TOON_CLIENT_HOME'] = tmpDir;
    client = new FakeClient();
    runner = new ClientRunner({
      config: makeConfig({
        apex: {
          destination: 'g.proxy',
          peerId: 'proxy',
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
    if (prevHome === undefined) delete process.env['TOON_CLIENT_HOME'];
    else process.env['TOON_CLIENT_HOME'] = prevHome;
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

  it('getStatus includes feePerEvent from config', () => {
    const status = runner.getStatus();
    expect(status.feePerEvent).toBe('1');
  });

  it('injects the apex negotiation into the ToonClient', async () => {
    await runner.bootstrap();
    expect(client.peerNegotiations.get('proxy')).toMatchObject({
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
          destination: 'g.proxy',
          peerId: 'proxy',
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
    expect(saved['g.proxy|evm'].channelId).toBe('chan-1');
    expect(saved['g.proxy|evm'].context).toMatchObject({
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
        'g.proxy|evm': {
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
          destination: 'g.proxy',
          peerId: 'proxy',
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
      throw new Error('BTP never connected');
    };
    await runner.bootstrap();
    expect(runner.isReady()).toBe(false);
    expect(runner.getStatus().lastError).toContain('BTP never connected');
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

  it('publishUnsigned builds the event, signs with the held key, and publishes', async () => {
    await runner.bootstrap();
    const res = await runner.publishUnsigned({
      kind: 1,
      content: 'hello',
      tags: [['t', 'toon']],
    });
    expect(client.lastSigned?.kind).toBe(1);
    expect(client.lastSigned?.content).toBe('hello');
    expect(client.lastSigned?.tags).toEqual([['t', 'toon']]);
    expect(res.channelId).toBe('chan-1');
    expect(res.nonce).toBe(1);
    expect(res.eventId).toMatch(/^signed-1-/);
  });

  it('publishUnsigned validates the model-authored payload', async () => {
    await runner.bootstrap();
    await expect(runner.publishUnsigned({ kind: -1 })).rejects.toBeInstanceOf(
      InvalidPayloadError
    );
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      runner.publishUnsigned({ kind: 1, tags: ['not-an-array'] as any })
    ).rejects.toBeInstanceOf(InvalidPayloadError);
  });

  it('uploadMedia uploads to Arweave then publishes a referencing media event', async () => {
    await runner.bootstrap();
    const res = await runner.uploadMedia({
      dataBase64: Buffer.from('img-bytes').toString('base64'),
      mime: 'image/png',
      kind: 20,
    });
    expect(res.txId).toBe('tx-abc');
    // Primary gateway is ar.io; the others travel as `fallback` mirrors.
    expect(res.url).toBe('https://ar-io.dev/tx-abc');
    expect(client.lastSigned?.kind).toBe(20);
    const imeta = client.lastSigned?.tags?.[0] ?? [];
    expect(imeta[0]).toBe('imeta');
    expect(imeta[1]).toBe('url https://ar-io.dev/tx-abc');
    expect(imeta).toContain('fallback https://arweave.net/tx-abc');
    expect(imeta).toContain('fallback https://permagate.io/tx-abc');
  });

  it('uploadMedia honors a custom config.arweaveGateways list', async () => {
    const c = new FakeClient();
    const r = new ClientRunner({
      config: makeConfig({
        apex: {
          destination: 'g.proxy',
          peerId: 'proxy',
          chain: 'evm',
          chainKey: 'evm:base:84532',
          chainId: 84532,
          settlementAddress: '0xapex',
          tokenAddress: '0xusdc',
          tokenNetwork: '0xtn',
        },
        arweaveGateways: ['https://my.gw', 'https://backup.gw'],
      }),
      createClient: () => c,
      createRelay: fakeRelay,
    });
    await r.bootstrap();
    const res = await r.uploadMedia({
      dataBase64: Buffer.from('x').toString('base64'),
      mime: 'image/png',
      kind: 20,
    });
    expect(res.url).toBe('https://my.gw/tx-abc');
    const imeta = c.lastSigned?.tags?.[0] ?? [];
    expect(imeta[1]).toBe('url https://my.gw/tx-abc');
    expect(imeta).toContain('fallback https://backup.gw/tx-abc');
    expect(imeta).not.toContain('fallback https://arweave.net/tx-abc');
  });

  it('uploadMedia surfaces a DVM upload failure as PublishRejectedError', async () => {
    await runner.bootstrap();
    client.uploadImpl = async () => ({ success: false, error: 'F99 dvm down' });
    await expect(
      runner.uploadMedia({ dataBase64: 'AAAA' })
    ).rejects.toBeInstanceOf(PublishRejectedError);
  });

  // ── Split write destinations (publish → relay, upload → store) ──────────────
  const splitApex = {
    destination: 'g.proxy.relay.store',
    peerId: 'store',
    chain: 'evm' as const,
    chainKey: 'evm:base:84532',
    chainId: 84532,
    settlementAddress: '0xapex',
    tokenNetwork: '0xtn',
  };
  function splitRunner(c: FakeClient): ClientRunner {
    return new ClientRunner({
      config: makeConfig({
        destination: 'g.proxy.relay.store',
        publishDestination: 'g.proxy.relay',
        storeDestination: 'g.proxy.store',
        apex: splitApex,
      }),
      createClient: () => c,
      createRelay: fakeRelay,
    });
  }

  it('publish routes to publishDestination by default (not the apex anchor)', async () => {
    const c = new FakeClient();
    const r = splitRunner(c);
    await r.bootstrap();
    await r.publish({ event: { id: 'evtA' } as NostrEvent });
    expect(c.lastPublishDest).toBe('g.proxy.relay');
  });

  it('publish honors an explicit per-call destination over the default', async () => {
    const c = new FakeClient();
    const r = splitRunner(c);
    await r.bootstrap();
    await r.publish({
      event: { id: 'evtB' } as NostrEvent,
      destination: 'g.custom.dest',
    });
    expect(c.lastPublishDest).toBe('g.custom.dest');
  });

  it('uploadMedia sends the blob to storeDestination and the reference event to publishDestination', async () => {
    const c = new FakeClient();
    const r = splitRunner(c);
    await r.bootstrap();
    await r.uploadMedia({
      dataBase64: Buffer.from('img').toString('base64'),
      kind: 20,
    });
    expect(c.lastUploadDest).toBe('g.proxy.store'); // blob → store backend
    expect(c.lastPublishDest).toBe('g.proxy.relay'); // NIP-94 ref event → relay
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
      destination: 'g.proxy.mill',
      amount: '1000',
      millPubkey: 'cd'.repeat(32),
      pair,
      chainRecipient: 'SoLrecipient',
    });

    // streamSwap got the request params (default single packet).
    const arg = vi.mocked(streamSwap).mock.calls[0]![0];
    expect(arg.millIlpAddress).toBe('g.proxy.mill');
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
      destination: 'g.proxy.mill',
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

  it('reports a direct transport (no anon/HS overlay)', () => {
    const r = new ClientRunner({
      config: makeConfig(),
      createClient: () => client,
      createRelay: fakeRelay,
    });
    expect(r.getStatus().transport.type).toBe('direct');
  });
});

// ── 1-to-many: dynamic relays + apexes, fan-out reads, persistence ──────────

/** A relay factory backed by drivable fake sockets, honoring onEvent wiring. */
function relayFactory(): {
  createRelay: (opts: {
    relayUrl: string;
    onEvent: (subId: string, event: NostrEvent) => void;
  }) => RelaySubscription;
  emit: (relayUrl: string, subId: string, event: NostrEvent) => void;
} {
  const handlersByUrl = new Map<
    string,
    Record<string, (a?: unknown) => void>
  >();
  const createRelay = (opts: {
    relayUrl: string;
    onEvent: (subId: string, event: NostrEvent) => void;
  }): RelaySubscription => {
    const handlers: Record<string, (a?: unknown) => void> = {};
    handlersByUrl.set(opts.relayUrl, handlers);
    return new RelaySubscription({
      relayUrl: opts.relayUrl,
      onEvent: opts.onEvent,
      wsFactory: () =>
        ({
          send: () => {},
          close: () => {},
          on: (ev: string, cb: (a?: unknown) => void) => {
            handlers[ev] = cb;
          },
        }) as never,
    });
  };
  const emit = (relayUrl: string, subId: string, event: NostrEvent): void =>
    handlersByUrl
      .get(relayUrl)
      ?.['message']?.(JSON.stringify(['EVENT', subId, event]));
  return { createRelay, emit };
}

function note(id: string): NostrEvent {
  return {
    id,
    pubkey: 'p'.repeat(64),
    created_at: 1,
    kind: 1,
    tags: [],
    sig: 's'.repeat(128),
    content: 'hi',
  };
}

function apexAnnouncement(ilpAddress: string): NostrEvent {
  return {
    id: 'd'.repeat(64),
    pubkey: 'e'.repeat(64),
    created_at: 1,
    kind: ILP_PEER_INFO_KIND,
    tags: [],
    sig: 'f'.repeat(128),
    content: JSON.stringify({
      ilpAddress,
      btpEndpoint: 'ws://apex2.example/btp',
      assetCode: 'USD',
      assetScale: 6,
      supportedChains: ['evm:base:84532'],
      settlementAddresses: { 'evm:base:84532': '0xS2' },
    }),
  };
}

describe('ClientRunner multi-target', () => {
  let dir: string;
  let targetsPath: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'toon-mt-'));
    targetsPath = join(dir, 'targets.json');
    // Isolate per-apex channel stores (configDir()) from the user's real home.
    prevHome = process.env['TOON_CLIENT_HOME'];
    process.env['TOON_CLIENT_HOME'] = dir;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env['TOON_CLIENT_HOME'];
    else process.env['TOON_CLIENT_HOME'] = prevHome;
    rmSync(dir, { recursive: true, force: true });
  });

  function build() {
    const { createRelay, emit } = relayFactory();
    const runner = new ClientRunner({
      config: makeConfig({
        relayUrl: 'ws://relay.test',
        apexChannelStorePath: join(dir, 'apex-channels.json'),
      }),
      createClient: () => new FakeClient(),
      createRelay,
      targetsPath,
    });
    return { runner, emit };
  }

  it('fans out a subscription across relays and merges reads with one cursor', async () => {
    const { runner, emit } = build();
    runner.start();
    await runner.addRelay('ws://relay2.test');

    const { subId, relays } = runner.subscribe({ filters: { kinds: [1] } });
    expect(relays.sort()).toEqual(['ws://relay.test', 'ws://relay2.test']);

    emit('ws://relay.test', subId, note('1'.repeat(64)));
    emit('ws://relay2.test', subId, note('2'.repeat(64)));

    const first = runner.getEvents({});
    expect(first.events.map((e) => e.id)).toEqual([
      '1'.repeat(64),
      '2'.repeat(64),
    ]);
    // Cursor advances; a second drain past it is empty.
    expect(runner.getEvents({ cursor: first.cursor }).events).toEqual([]);
  });

  it('de-dups the same event seen on two relays', async () => {
    const { runner, emit } = build();
    runner.start();
    await runner.addRelay('ws://relay2.test');
    const { subId } = runner.subscribe({ filters: { kinds: [1] } });
    emit('ws://relay.test', subId, note('9'.repeat(64)));
    emit('ws://relay2.test', subId, note('9'.repeat(64)));
    expect(runner.getEvents({}).events).toHaveLength(1);
  });

  it('scopes a read to one relay via relayUrl', async () => {
    const { runner, emit } = build();
    runner.start();
    await runner.addRelay('ws://relay2.test');
    const { subId } = runner.subscribe({ filters: { kinds: [1] } });
    emit('ws://relay.test', subId, note('a'.repeat(64)));
    emit('ws://relay2.test', subId, note('b'.repeat(64)));
    const scoped = runner.getEvents({ relayUrl: 'ws://relay2.test' });
    expect(scoped.events.map((e) => e.id)).toEqual(['b'.repeat(64)]);
  });

  it('addRelay persists and getTargets reflects it; default relay is not removable', async () => {
    const { runner } = build();
    runner.start();
    await runner.addRelay('ws://relay2.test');
    expect(
      runner
        .getTargets()
        .relays.map((r) => r.relayUrl)
        .sort()
    ).toEqual(['ws://relay.test', 'ws://relay2.test']);
    expect(loadTargets(targetsPath).relays).toEqual([
      { relayUrl: 'ws://relay2.test' },
    ]);
    expect(() => runner.removeRelay('ws://relay.test')).toThrow(/default/i);
    runner.removeRelay('ws://relay2.test');
    expect(runner.getTargets().relays.map((r) => r.relayUrl)).toEqual([
      'ws://relay.test',
    ]);
    expect(loadTargets(targetsPath).relays).toEqual([]);
  });

  it('replays a persisted relay on construction', async () => {
    const { createRelay } = relayFactory();
    // Seed the store, then construct a fresh runner pointed at it.
    const seed = new ClientRunner({
      config: makeConfig({ apexChannelStorePath: join(dir, 'a.json') }),
      createClient: () => new FakeClient(),
      createRelay,
      targetsPath,
    });
    seed.start();
    await seed.addRelay('ws://persisted.test');

    const fresh = new ClientRunner({
      config: makeConfig({ apexChannelStorePath: join(dir, 'a.json') }),
      createClient: () => new FakeClient(),
      createRelay,
      targetsPath,
    });
    fresh.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(fresh.getTargets().relays.map((r) => r.relayUrl)).toContain(
      'ws://persisted.test'
    );
  });

  it('discovers + adds an apex from a relay announcement (persisted)', async () => {
    const { runner, emit } = build();
    runner.start();
    // Pre-buffer the apex's kind:10032 on the discovery relay.
    emit(
      'ws://relay.test',
      'apex-discovery-g.other.town',
      apexAnnouncement('g.other.town')
    );

    const res = await runner.addApex({
      ilpAddress: 'g.other.town',
      relayUrl: 'ws://relay.test',
    });
    expect(res.btpUrl).toBe('ws://apex2.example/btp');
    const apexes = runner.getTargets().apexes;
    expect(apexes.map((a) => a.btpUrl)).toContain('ws://apex2.example/btp');
    expect(loadTargets(targetsPath).apexes.map((a) => a.btpUrl)).toEqual([
      'ws://apex2.example/btp',
    ]);
  });

  it('publish to an unknown apex throws; default apex is not removable', async () => {
    const { runner } = build();
    runner.start();
    await runner.bootstrap();
    await expect(
      runner.publish({ event: note('c'.repeat(64)), btpUrl: 'ws://nope/btp' })
    ).rejects.toThrow(/no such apex/i);
    await expect(runner.removeApex('ws://apex.test/btp')).rejects.toThrow(
      /default/i
    );
  });
});

// ── Proxy-mode (no BTP) negotiation + lazy channel open + read-only (#69) ─────
describe('ClientRunner — proxy mode (#69)', () => {
  let prevHome: string | undefined;
  let prevProxy: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'toon-runner-proxy-'));
    prevHome = process.env['TOON_CLIENT_HOME'];
    prevProxy = process.env['TOON_CLIENT_PROXY_URL'];
    process.env['TOON_CLIENT_HOME'] = tmpDir;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env['TOON_CLIENT_HOME'];
    else process.env['TOON_CLIENT_HOME'] = prevHome;
    if (prevProxy === undefined) delete process.env['TOON_CLIENT_PROXY_URL'];
    else process.env['TOON_CLIENT_PROXY_URL'] = prevProxy;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** A proxy-mode config: no btpUrl, a synthesized apex negotiation, proxy set. */
  function proxyConfig(): ResolvedDaemonConfig {
    return makeConfig({
      hasUplink: true,
      proxyUrl: 'https://proxy.test',
      destination: 'g.proxy.relay',
      apexChannelStorePath: join(tmpDir, 'apex-channels.json'),
      apex: {
        destination: 'g.proxy.relay',
        peerId: 'relay',
        chain: 'evm',
        chainKey: 'evm:devnet:31337',
        chainId: 31337,
        settlementAddress: '0xConnectorSettle',
        tokenAddress: '0xUSDC',
        tokenNetwork: '0xTokenNetwork',
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      toonClientConfig: { proxyUrl: 'https://proxy.test' } as any,
    });
  }

  it('injects the apex negotiation in proxy mode WITHOUT a BTP socket', async () => {
    const client = new FakeClient();
    const openSpy = vi.spyOn(client, 'openChannel');
    const runner = new ClientRunner({
      config: proxyConfig(),
      createClient: () => client,
      createRelay: fakeRelay,
    });
    await runner.bootstrap();
    expect(runner.isReady()).toBe(true);
    // Negotiation injected under the apex peerId (last ILP segment "relay").
    expect(client.peerNegotiations.get('relay')).toMatchObject({
      chainType: 'evm',
      chainId: 31337,
      settlementAddress: '0xConnectorSettle',
      tokenNetwork: '0xTokenNetwork',
    });
    // Channel open is DEFERRED at bootstrap (fund-after-start flow).
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('opens the channel lazily on first publish and persists it (proxy mode)', async () => {
    const client = new FakeClient();
    const openSpy = vi.spyOn(client, 'openChannel');
    const runner = new ClientRunner({
      config: proxyConfig(),
      createClient: () => client,
      createRelay: fakeRelay,
    });
    await runner.bootstrap();
    const res = await runner.publish({ event: { id: 'evt-proxy' } as NostrEvent });
    expect(openSpy).toHaveBeenCalledTimes(1); // opened on first write
    expect(res.channelId).toBe('chan-1');
    expect(res.nonce).toBe(1);
    // Persisted for restart-resume, keyed by (destination|chain).
    const saved = JSON.parse(
      readFileSync(join(tmpDir, 'apex-channels.json'), 'utf8')
    );
    expect(saved['g.proxy.relay|evm'].channelId).toBe('chan-1');
    expect(saved['g.proxy.relay|evm'].context).toMatchObject({
      chainType: 'evm',
      chainId: 31337,
      recipient: '0xConnectorSettle',
    });
    // A second publish reuses the channel (no second open).
    await runner.publish({ event: { id: 'evt2' } as NostrEvent });
    expect(openSpy).toHaveBeenCalledTimes(1);
  });

  it('read-only daemon (no uplink) serves reads but rejects writes (#69)', async () => {
    const client = new FakeClient();
    const runner = new ClientRunner({
      config: makeConfig({
        hasUplink: false,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        toonClientConfig: {} as any,
      }),
      createClient: () => client,
      createRelay: fakeRelay,
    });
    runner.start();
    // No apex bootstrap is kicked off in read-only mode.
    await runner.bootstrap();
    expect(runner.isBootstrapping()).toBe(false);
    // Reads still work (subscribe returns a sub id, no uplink needed).
    const sub = runner.subscribe({ filters: { kinds: [1] } });
    expect(sub.subId).toBeTruthy();
    // Writes are rejected with an actionable "configure an uplink" message.
    await expect(
      runner.publish({ event: { id: 'e' } as NostrEvent })
    ).rejects.toBeInstanceOf(TargetError);
    await expect(
      runner.openChannel()
    ).rejects.toThrow(/read-only|uplink/i);
  });
});
