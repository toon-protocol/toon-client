/**
 * StandalonePublisher conformance tests (#228) — mocked ToonClient, no real
 * network: event kinds/tags for kind:5094 git-object uploads, one
 * balance-proof claim per paid write, fee accounting, FULFILL txId decoding,
 * and the daemon-collision / lockfile nonce guard wired into every paid op.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnsignedEvent } from '../nip34-events.js';
import { MAX_OBJECT_SIZE } from '../objects.js';
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
  openChannel: Array<string | undefined>;
  claims: Array<{ channelId: string; amount: bigint }>;
  publishes: Array<{
    event: SignedNostrEvent;
    options:
      | {
          destination?: string;
          claim?: unknown;
          ilpAmount?: bigint;
          proxyPath?: string;
        }
      | undefined;
  }>;
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
