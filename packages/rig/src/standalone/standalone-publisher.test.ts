/**
 * StandalonePublisher conformance tests (#228) — mocked ToonClient, no real
 * network: event kinds/tags for kind:5094 git-object uploads, one
 * balance-proof claim per paid write, fee accounting, FULFILL txId decoding,
 * and the daemon-collision / lockfile nonce guard wired into every paid op.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnsignedEvent } from '../nip34-events.js';
import { MAX_OBJECT_SIZE } from '../objects.js';
import {
  ChannelMapCorruptError,
  ChannelMapStore,
  type ChannelMapRecord,
  type PersistedChannelContext,
} from './channel-map.js';
import { DaemonIdentityConflictError, StandaloneLockError } from './nonce-guard.js';
import {
  StandalonePublisher,
  StandalonePublishError,
  deriveRouteDestinations,
  extractArweaveTxId,
  type SignedNostrEvent,
  type ToonClientLike,
} from './standalone-publisher.js';

const PUBKEY = 'c'.repeat(64);
const TX_ID = 'A'.repeat(43); // valid 43-char base64url Arweave tx id

/** Base64 FULFILL data carrying the proxy's verbatim HTTP store response. */
function httpFulfill(body: string, status = 200): string {
  const message =
    `HTTP/1.1 ${status} ${status === 200 ? 'OK' : 'Bad Request'}\r\n` +
    `content-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
  return Buffer.from(message, 'utf8').toString('base64');
}

interface MockCalls {
  start: number;
  openChannel: (string | undefined)[];
  claims: { channelId: string; amount: bigint }[];
  publishes: {
    event: SignedNostrEvent;
    options:
      | {
          destination?: string;
          claim?: unknown;
          ilpAmount?: bigint;
          proxyPath?: string;
        }
      | undefined;
  }[];
}

function mockClient(overrides?: {
  publishResult?: (event: SignedNostrEvent) => {
    success: boolean;
    eventId?: string;
    data?: string;
    error?: string;
  };
}): { client: ToonClientLike; calls: MockCalls } {
  const calls: MockCalls = {
    start: 0,
    openChannel: [],
    claims: [],
    publishes: [],
  };
  const client: ToonClientLike = {
    async start() {
      calls.start += 1;
      return {};
    },
    async stop() {},
    isStarted: () => calls.start > 0,
    getPublicKey: () => PUBKEY,
    signEvent: (template: UnsignedEvent): SignedNostrEvent => ({
      ...template,
      id: 'e'.repeat(64),
      pubkey: PUBKEY,
      sig: 'f'.repeat(128),
    }),
    async openChannel(destination?: string) {
      calls.openChannel.push(destination);
      return 'channel-1';
    },
    async signBalanceProof(channelId: string, amount: bigint) {
      calls.claims.push({ channelId, amount });
      return { nonce: calls.claims.length, amount } as never;
    },
    async publishEvent(event, options) {
      calls.publishes.push({ event, options });
      return (
        overrides?.publishResult?.(event) ?? {
          success: true,
          eventId: event.id,
          data: httpFulfill(JSON.stringify({ accept: true, txId: TX_ID })),
        }
      );
    },
  };
  return { client, calls };
}

/** fetch mock: no daemon listening. */
const noDaemon = vi.fn(async () => {
  throw new Error('connect ECONNREFUSED');
}) as unknown as typeof fetch;

/** fetch mock: daemon /status answering with the given pubkey. */
function daemonWith(pubkey: string): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify({ identity: { nostrPubkey: pubkey } }), {
      status: 200,
    })
  ) as unknown as typeof fetch;
}

const EVENT: UnsignedEvent = {
  kind: 30618,
  content: '',
  created_at: 1_700_000_000,
  tags: [['d', 'repo']],
};

describe('StandalonePublisher', () => {
  let lockDir: string;

  beforeEach(() => {
    lockDir = mkdtempSync(join(tmpdir(), 'standalone-pub-'));
  });

  afterEach(() => {
    rmSync(lockDir, { recursive: true, force: true });
  });

  function build(
    client: ToonClientLike,
    extra?: Partial<ConstructorParameters<typeof StandalonePublisher>[0]>
  ): StandalonePublisher {
    return new StandalonePublisher({
      client,
      channelDestination: 'g.proxy.relay.store',
      lockDir,
      fetchImpl: noDaemon,
      ...extra,
    });
  }

  describe('construction', () => {
    it('requires exactly one of clientConfig | client', () => {
      expect(() => new StandalonePublisher({})).toThrow(/one of/);
      const { client } = mockClient();
      expect(
        () =>
          new StandalonePublisher({
            client,
            clientConfig: {} as never,
          })
      ).toThrow(/not both/);
    });
  });

  describe('route derivation', () => {
    it('splits a <base>.relay.store anchor into relay + store routes', () => {
      expect(deriveRouteDestinations('g.proxy.relay.store')).toEqual({
        publish: 'g.proxy.relay',
        store: 'g.proxy.store',
      });
    });

    it('passes non-convention anchors through unchanged', () => {
      expect(deriveRouteDestinations('g.toon.peer1')).toEqual({
        publish: 'g.toon.peer1',
        store: 'g.toon.peer1',
      });
    });
  });

  describe('getFeeRates', () => {
    it('returns the daemon-convention defaults (eventFee 1, 10/byte uploads)', async () => {
      const { client } = mockClient();
      const publisher = build(client);
      await expect(publisher.getFeeRates()).resolves.toEqual({
        uploadFeePerByte: 10n,
        eventFee: 1n,
      });
    });

    it('honours configured overrides', async () => {
      const { client } = mockClient();
      const publisher = build(client, { eventFee: 7n, uploadFeePerByte: 3n });
      await expect(publisher.getFeeRates()).resolves.toEqual({
        uploadFeePerByte: 3n,
        eventFee: 7n,
      });
    });
  });

  describe('publishEvent', () => {
    it('signs, pays ONE claim per write at the flat event fee, and routes to the relay destination', async () => {
      const { client, calls } = mockClient();
      const publisher = build(client, { eventFee: 5n });

      const receipt = await publisher.publishEvent(EVENT, ['wss://relay']);
      expect(receipt).toEqual({ eventId: 'e'.repeat(64), feePaid: 5n });

      // Channel anchored at the configured destination, derived publish route.
      expect(calls.openChannel).toEqual(['g.proxy.relay.store']);
      expect(calls.claims).toEqual([{ channelId: 'channel-1', amount: 5n }]);
      const pub = calls.publishes[0]!;
      expect(pub.options?.destination).toBe('g.proxy.relay');
      expect(pub.options?.ilpAmount).toBe(5n);
      expect(pub.options?.claim).toBeDefined();
      expect(pub.options?.proxyPath).toBeUndefined();
      expect(pub.event.sig).toBeDefined(); // signed impl-side
      await publisher.stop();
    });

    it('signs a FRESH claim per write (cumulative watermark delegated to the client)', async () => {
      const { client, calls } = mockClient();
      const publisher = build(client);
      await publisher.publishEvent(EVENT, []);
      await publisher.publishEvent(EVENT, []);
      expect(calls.claims).toHaveLength(2);
      expect(calls.start).toBe(1); // started once, channel reused
      expect(calls.openChannel).toHaveLength(1);
      await publisher.stop();
    });

    it('refuses multi-relay fan-out (plural surface parked, #84)', async () => {
      const { client, calls } = mockClient();
      const publisher = build(client);
      await expect(
        publisher.publishEvent(EVENT, ['wss://a', 'wss://b'])
      ).rejects.toThrow(/multi-relay/);
      expect(calls.claims).toHaveLength(0); // refused BEFORE paying
      await publisher.stop();
    });

    it('throws (no receipt) when the relay rejects the write', async () => {
      const { client } = mockClient({
        publishResult: () => ({ success: false, error: 'rate limited' }),
      });
      const publisher = build(client);
      await expect(publisher.publishEvent(EVENT, [])).rejects.toThrow(
        /rate limited/
      );
      await publisher.stop();
    });
  });

  describe('uploadGitObject', () => {
    const upload = {
      sha: '1234567890abcdef1234567890abcdef12345678',
      type: 'blob' as const,
      body: Buffer.from('hello git object'),
      repoId: 'toon-meta',
    };

    it('publishes a kind:5094 Git-SHA/Git-Type/Repo-tagged store write, bytes × rate fee, one claim', async () => {
      const { client, calls } = mockClient();
      const publisher = build(client, { uploadFeePerByte: 10n });

      const receipt = await publisher.uploadGitObject(upload);
      const expectedFee = BigInt(upload.body.length) * 10n;
      expect(receipt).toEqual({ txId: TX_ID, feePaid: expectedFee });

      expect(calls.claims).toEqual([
        { channelId: 'channel-1', amount: expectedFee },
      ]);
      const pub = calls.publishes[0]!;
      expect(pub.event.kind).toBe(5094);
      expect(pub.event.content).toBe('');
      expect(pub.event.tags).toEqual([
        ['i', upload.body.toString('base64'), 'blob'],
        ['bid', expectedFee.toString(), 'usdc'],
        ['output', 'application/octet-stream'],
        ['Git-SHA', upload.sha],
        ['Git-Type', 'blob'],
        ['Repo', 'toon-meta'],
      ]);
      // Store writes route to the derived store destination via POST /store.
      expect(pub.options?.destination).toBe('g.proxy.store');
      expect(pub.options?.proxyPath).toBe('/store');
      expect(pub.options?.ilpAmount).toBe(expectedFee);
      await publisher.stop();
    });

    it('decodes a legacy bare-base64 txId FULFILL (non-proxy providers)', async () => {
      const { client } = mockClient({
        publishResult: (event) => ({
          success: true,
          eventId: event.id,
          data: Buffer.from(TX_ID, 'utf8').toString('base64'),
        }),
      });
      const publisher = build(client);
      const receipt = await publisher.uploadGitObject(upload);
      expect(receipt.txId).toBe(TX_ID);
      await publisher.stop();
    });

    it('hard-errors oversize objects BEFORE paying', async () => {
      const { client, calls } = mockClient();
      const publisher = build(client);
      await expect(
        publisher.uploadGitObject({
          ...upload,
          body: Buffer.alloc(MAX_OBJECT_SIZE + 1),
        })
      ).rejects.toThrow(/exceeds/);
      expect(calls.claims).toHaveLength(0);
      expect(calls.publishes).toHaveLength(0);
      await publisher.stop();
    });

    it('throws on an accept:false store response', async () => {
      const { client } = mockClient({
        publishResult: (event) => ({
          success: true,
          eventId: event.id,
          data: httpFulfill(
            JSON.stringify({ accept: false, error: 'disk full' })
          ),
        }),
      });
      const publisher = build(client);
      await expect(publisher.uploadGitObject(upload)).rejects.toThrow(
        /accept:false.*disk full/
      );
      await publisher.stop();
    });

    it('throws when the FULFILL has no data', async () => {
      const { client } = mockClient({
        publishResult: (event) => ({ success: true, eventId: event.id }),
      });
      const publisher = build(client);
      await expect(publisher.uploadGitObject(upload)).rejects.toThrow(
        /no data/
      );
      await publisher.stop();
    });
  });

  describe('nonce guard integration', () => {
    it('REFUSES every paid op while a toon-clientd holds the SAME identity', async () => {
      const { client, calls } = mockClient();
      const publisher = build(client, { fetchImpl: daemonWith(PUBKEY) });

      await expect(publisher.publishEvent(EVENT, [])).rejects.toThrow(
        DaemonIdentityConflictError
      );
      await expect(publisher.publishEvent(EVENT, [])).rejects.toThrow(
        /use daemon mode or stop the daemon/
      );
      // Never started the client, never signed a claim, took no lock.
      expect(calls.start).toBe(0);
      expect(calls.claims).toHaveLength(0);
      await publisher.stop();
    });

    it('proceeds when the daemon holds a DIFFERENT identity', async () => {
      const { client } = mockClient();
      const publisher = build(client, {
        fetchImpl: daemonWith('d'.repeat(64)),
      });
      await expect(publisher.publishEvent(EVENT, [])).resolves.toMatchObject({
        feePaid: 1n,
      });
      await publisher.stop();
    });

    it('holds the per-identity lock for its lifetime: a second standalone instance refuses', async () => {
      const { client } = mockClient();
      const first = build(client);
      await first.publishEvent(EVENT, []);

      // Simulate a SECOND standalone process: same identity + lock dir but a
      // different live pid recorded in the lockfile (the first instance's).
      writeFileSync(
        join(lockDir, `standalone-${PUBKEY}.lock`),
        JSON.stringify({ pid: process.ppid, pubkey: PUBKEY, createdAt: 'x' })
      );
      const { client: client2 } = mockClient();
      const second = build(client2);
      await expect(second.publishEvent(EVENT, [])).rejects.toThrow(
        StandaloneLockError
      );
      await first.stop();
    });

    it('reclaims a stale lock from a dead process and proceeds', async () => {
      writeFileSync(
        join(lockDir, `standalone-${PUBKEY}.lock`),
        'corrupt-stale-lock'
      );
      const { client } = mockClient();
      const publisher = build(client);
      await expect(publisher.publishEvent(EVENT, [])).resolves.toBeDefined();
      await publisher.stop();
    });

    it('stop() releases the lock so the next instance can acquire it', async () => {
      const { client } = mockClient();
      const first = build(client);
      await first.publishEvent(EVENT, []);
      await first.stop();

      const { client: client2 } = mockClient();
      const second = build(client2);
      await expect(second.publishEvent(EVENT, [])).resolves.toBeDefined();
      await second.stop();
    });

    it('start() failure after taking the lock releases it', async () => {
      const { client } = mockClient();
      const failing: ToonClientLike = {
        ...client,
        isStarted: () => false,
        async start() {
          throw new Error('bootstrap exploded');
        },
      };
      const first = build(failing);
      await expect(first.publishEvent(EVENT, [])).rejects.toThrow(
        /bootstrap exploded/
      );

      // Lock must be free for the next instance.
      const { client: client2 } = mockClient();
      const second = build(client2);
      await expect(second.publishEvent(EVENT, [])).resolves.toBeDefined();
      await second.stop();
    });
  });

  // ── channel persistence (#262) ────────────────────────────────────────────
  //
  // A mock ToonClient with the PRIVATE internals the resume path introspects
  // (peerNegotiations + channelManager.{trackChannel,peerChannels}), whose
  // openChannel mirrors ensureChannel: an entry in peerChannels is returned
  // as-is (no on-chain open); otherwise a fresh channel opens on-chain.
  describe('channel persistence (#262)', () => {
    const ANCHOR = 'g.proxy.relay.store';
    const PEER_ID = 'nostr-2813187e';
    const NEGOTIATION = {
      chain: 'evm:31337',
      chainType: 'evm',
      chainId: 31337,
      settlementAddress: '0x' + '44'.repeat(20),
      tokenAddress: '0x' + '33'.repeat(20),
      tokenNetwork: '0x' + '22'.repeat(20),
    };

    interface ChannelMockCalls extends MockCalls {
      onChainOpens: number;
      trackChannel: { channelId: string; context: PersistedChannelContext }[];
      rehydrates: { channelId: string; chain: string }[];
    }

    /** One "process": fresh in-memory maps, shared on-disk store. */
    function mockChannelClient(opts?: {
      openedDeposit?: bigint;
      rehydratedDeposit?: bigint;
      negotiations?: Map<string, typeof NEGOTIATION>;
    }): { client: ToonClientLike; calls: ChannelMockCalls } {
      const peerChannels = new Map<string, string>();
      const peerNegotiations =
        opts?.negotiations ?? new Map([[PEER_ID, NEGOTIATION]]);
      const calls: ChannelMockCalls = {
        start: 0,
        openChannel: [],
        claims: [],
        publishes: [],
        onChainOpens: 0,
        trackChannel: [],
        rehydrates: [],
      };
      const { client: base } = mockClient();
      const client = {
        ...base,
        isStarted: () => calls.start > 0,
        async start() {
          calls.start += 1;
          return {};
        },
        peerNegotiations,
        channelManager: {
          peerChannels,
          trackChannel(channelId: string, context: PersistedChannelContext) {
            calls.trackChannel.push({ channelId, context });
          },
        },
        async openChannel(destination?: string) {
          calls.openChannel.push(destination);
          const existing = peerChannels.get(PEER_ID);
          if (existing) return existing; // ensureChannel: reuse, no on-chain
          calls.onChainOpens += 1;
          const channelId = `0xchannel-${calls.onChainOpens}`;
          peerChannels.set(PEER_ID, channelId);
          return channelId;
        },
        async signBalanceProof(channelId: string, amount: bigint) {
          calls.claims.push({ channelId, amount });
          return { nonce: calls.claims.length, amount } as never;
        },
        getChannelDepositTotal: () => opts?.openedDeposit ?? 100000n,
        async rehydrateChannelDeposit(
          channelId: string,
          o: { chain: string; tokenNetworkAddress: string }
        ) {
          calls.rehydrates.push({ channelId, chain: o.chain });
          return opts?.rehydratedDeposit ?? 100000n;
        },
      } as unknown as ToonClientLike;
      return { client, calls };
    }

    let stateDir: string;
    let map: ChannelMapStore;
    let warnings: string[];

    beforeEach(() => {
      stateDir = mkdtempSync(join(tmpdir(), 'rig-chan-persist-'));
      map = new ChannelMapStore({
        mapPath: join(stateDir, 'rig-channels.json'),
        watermarkPath: join(stateDir, 'channels.json'),
      });
      warnings = [];
    });

    afterEach(() => {
      rmSync(stateDir, { recursive: true, force: true });
    });

    function buildPersistent(client: ToonClientLike): StandalonePublisher {
      return build(client, {
        channelMap: map,
        warn: (line) => warnings.push(line),
      });
    }

    it('records the first lazy open (identity+peer+chain+tokenNetwork key, context, deposit) and seeds the 0/0 watermark', async () => {
      const { client, calls } = mockChannelClient();
      const publisher = buildPersistent(client);
      await publisher.publishEvent(EVENT, []);
      await publisher.stop();

      expect(calls.onChainOpens).toBe(1);
      const records = map.list();
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        channelId: '0xchannel-1',
        peerId: PEER_ID,
        identity: PUBKEY,
        destination: ANCHOR,
        chain: 'evm:31337',
        tokenNetwork: NEGOTIATION.tokenNetwork,
        depositTotal: '100000',
        context: {
          chainType: 'evm',
          chainId: 31337,
          tokenNetworkAddress: NEGOTIATION.tokenNetwork,
          tokenAddress: NEGOTIATION.tokenAddress,
          recipient: NEGOTIATION.settlementAddress,
        },
      });
      // Fresh channel's watermark seeded so a later resume can tell
      // "never claimed" from "watermark lost".
      expect(map.readWatermark('0xchannel-1')).toEqual({
        nonce: 0,
        cumulativeAmount: '0',
      });
      expect(warnings).toEqual([]);
    });

    it('REUSES the channel across invocations: second run resumes, zero on-chain opens', async () => {
      // Run 1 (process A): lazy open + record.
      const { client: clientA, calls: callsA } = mockChannelClient();
      const runA = buildPersistent(clientA);
      await runA.publishEvent(EVENT, []);
      await runA.stop();
      expect(callsA.onChainOpens).toBe(1);

      // The embedded ChannelManager persisted claims meanwhile (this is what
      // @toon-protocol/client's JsonFileChannelStore writes after signing).
      writeFileSync(
        join(stateDir, 'channels.json'),
        JSON.stringify({
          '0xchannel-1': { nonce: 15, cumulativeAmount: '16120' },
        })
      );

      // Run 2 (process B): fresh in-memory state, same on-disk stores.
      const { client: clientB, calls: callsB } = mockChannelClient();
      const runB = buildPersistent(clientB);
      await runB.publishEvent(EVENT, []);
      await runB.stop();

      // ONE channel total: run 2 resumed instead of opening on-chain.
      expect(callsB.onChainOpens).toBe(0);
      expect(callsB.claims).toEqual([
        { channelId: '0xchannel-1', amount: 1n },
      ]);
      // trackChannel got the persisted chain context — the client rehydrates
      // the nonce/cumulative watermark from channels.json off exactly this
      // call (covered by @toon-protocol/client's ChannelManager tests).
      expect(callsB.trackChannel).toEqual([
        {
          channelId: '0xchannel-1',
          context: {
            chainType: 'evm',
            chainId: 31337,
            tokenNetworkAddress: NEGOTIATION.tokenNetwork,
            tokenAddress: NEGOTIATION.tokenAddress,
            recipient: NEGOTIATION.settlementAddress,
          },
        },
      ]);
      // Resumed deposits are re-read from chain (persisted state omits them).
      expect(callsB.rehydrates).toEqual([
        { channelId: '0xchannel-1', chain: 'evm:31337' },
      ]);
      // The advanced watermark was NOT clobbered by the seed.
      expect(map.readWatermark('0xchannel-1')).toEqual({
        nonce: 15,
        cumulativeAmount: '16120',
      });
      expect(map.list()).toHaveLength(1);
      expect(warnings).toEqual([]);
    });

    it('a corrupt map file REFUSES the paid op before any open (never a silent duplicate)', async () => {
      writeFileSync(join(stateDir, 'rig-channels.json'), 'not-json{');
      const { client, calls } = mockChannelClient();
      const publisher = buildPersistent(client);

      await expect(publisher.publishEvent(EVENT, [])).rejects.toThrow(
        ChannelMapCorruptError
      );
      expect(calls.openChannel).toHaveLength(0);
      expect(calls.onChainOpens).toBe(0);
      expect(calls.claims).toHaveLength(0);
      await publisher.stop();
    });

    it('resuming with a MISSING watermark warns (stale-claim rejection is diagnosable) but proceeds', async () => {
      const { client: clientA } = mockChannelClient();
      const runA = buildPersistent(clientA);
      await runA.publishEvent(EVENT, []);
      await runA.stop();

      // Watermark store lost (the map survived).
      rmSync(join(stateDir, 'channels.json'));

      const { client: clientB, calls: callsB } = mockChannelClient();
      const runB = buildPersistent(clientB);
      await runB.publishEvent(EVENT, []);
      await runB.stop();

      expect(callsB.onChainOpens).toBe(0); // still resumed — fails safe
      expect(warnings.join('\n')).toMatch(/no local claim watermark/);
    });

    it('never resumes a closed/settled channel: opens fresh and re-records', async () => {
      const { client: clientA } = mockChannelClient();
      const runA = buildPersistent(clientA);
      await runA.publishEvent(EVENT, []);
      await runA.stop();

      // Withdraw flow closed the channel (client persists the timers).
      writeFileSync(
        join(stateDir, 'channels.json'),
        JSON.stringify({
          '0xchannel-1': {
            nonce: 15,
            cumulativeAmount: '16120',
            closedAt: '100',
            settleableAt: '200',
          },
        })
      );

      const { client: clientB, calls: callsB } = mockChannelClient();
      const runB = buildPersistent(clientB);
      await runB.publishEvent(EVENT, []);
      await runB.stop();

      expect(callsB.trackChannel).toEqual([]); // no resume attempt
      expect(callsB.onChainOpens).toBe(1); // fresh open
      const records = map.list();
      expect(records).toHaveLength(1); // same key → replaced
      expect(records[0]?.channelId).toBe('0xchannel-1'); // process B's first open id
    });

    it('a rotated peer identity (recorded peerId no longer negotiated) opens fresh instead of stale claims', async () => {
      const { client: clientA } = mockChannelClient();
      const runA = buildPersistent(clientA);
      await runA.publishEvent(EVENT, []);
      await runA.stop();

      const rotated = new Map([['nostr-rotated', NEGOTIATION]]);
      const { client: clientB, calls: callsB } = mockChannelClient({
        negotiations: rotated,
      });
      // Process B's openChannel keys peerChannels by PEER_ID, so a resume
      // seed for the OLD peer id must not be found: assert no resume happened.
      const runB = buildPersistent(clientB);
      await runB.publishEvent(EVENT, []);
      await runB.stop();

      expect(callsB.trackChannel).toEqual([]);
      expect(callsB.onChainOpens).toBe(1);
    });

    it('without a channelMap nothing is recorded (historical behaviour)', async () => {
      const { client, calls } = mockChannelClient();
      const publisher = build(client); // no channelMap
      await publisher.publishEvent(EVENT, []);
      await publisher.stop();
      expect(calls.onChainOpens).toBe(1);
      expect(map.list()).toEqual([]);
    });

    it('map records survive as human-readable JSON (schema smoke test)', async () => {
      const { client } = mockChannelClient();
      const publisher = buildPersistent(client);
      await publisher.publishEvent(EVENT, []);
      await publisher.stop();

      const raw = JSON.parse(
        readFileSync(join(stateDir, 'rig-channels.json'), 'utf8')
      ) as { version: number; channels: Record<string, ChannelMapRecord> };
      expect(raw.version).toBe(1);
      const key = `${PUBKEY}|${ANCHOR}|evm:31337|${NEGOTIATION.tokenNetwork}`;
      expect(Object.keys(raw.channels)).toEqual([key]);
      expect(raw.channels[key]?.openedAt).toBeTruthy();
      expect(raw.channels[key]?.lastUsedAt).toBeTruthy();
    });
  });
});

describe('extractArweaveTxId', () => {
  it('rejects an invalid legacy payload', () => {
    expect(() =>
      extractArweaveTxId(Buffer.from('nope', 'utf8').toString('base64'))
    ).toThrow(StandalonePublishError);
  });

  it('reads the txId from the data-field fallback', () => {
    const body = JSON.stringify({
      accept: true,
      data: Buffer.from(TX_ID, 'utf8').toString('base64'),
    });
    const data = Buffer.from(
      `HTTP/1.1 200 OK\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
      'utf8'
    ).toString('base64');
    expect(extractArweaveTxId(data)).toBe(TX_ID);
  });

  it('rejects a non-2xx store response', () => {
    const data = Buffer.from(
      'HTTP/1.1 500 Internal Server Error\r\ncontent-length: 4\r\n\r\noops',
      'utf8'
    ).toString('base64');
    expect(() => extractArweaveTxId(data)).toThrow(/HTTP 500/);
  });
});
