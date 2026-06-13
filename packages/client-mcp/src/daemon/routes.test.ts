import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import type { NostrEvent } from 'nostr-tools/pure';
import { registerRoutes } from './routes.js';
import { ClientRunner, type ToonClientLike } from './client-runner.js';
import type { ResolvedDaemonConfig } from './config.js';
import { RelaySubscription } from '../relay-subscription.js';

/** Minimal happy-path fake client for route wiring tests. */
class FakeClient implements ToonClientLike {
  peerNegotiations = new Map<string, unknown>();
  nonce = 0;
  async start(): Promise<{ peersDiscovered: number; mode: string }> {
    return { peersDiscovered: 0, mode: 'http' };
  }
  async stop(): Promise<void> {}
  getPublicKey(): string {
    return 'pk';
  }
  getEvmAddress(): string | undefined {
    return '0x1';
  }
  getSolanaAddress(): string | undefined {
    return undefined;
  }
  getMinaAddress(): string | undefined {
    return undefined;
  }
  getNetworkStatus(): undefined {
    return undefined;
  }
  async publishEvent(
    e: NostrEvent
  ): Promise<{ success: boolean; eventId?: string }> {
    return { success: true, eventId: e.id };
  }
  async signBalanceProof(): Promise<unknown> {
    this.nonce += 1;
    return {};
  }
  async openChannel(): Promise<string> {
    return 'chan-1';
  }
  getTrackedChannels(): string[] {
    return ['chan-1'];
  }
  getChannelNonce(): number {
    return this.nonce;
  }
  getChannelCumulativeAmount(): bigint {
    return BigInt(this.nonce);
  }
  async sendSwapPacket(): Promise<{ accepted: boolean }> {
    return { accepted: true };
  }
}

function config(): ResolvedDaemonConfig {
  return {
    httpPort: 0,
    relayUrl: 'ws://relay.test',
    destination: 'g.townhouse.town',
    feePerEvent: 1n,
    chain: 'evm',
    apexChannelStorePath: join(
      tmpdir(),
      `toon-routes-apex-${process.pid}.json`
    ),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    toonClientConfig: { btpUrl: 'ws://apex/btp' } as any,
  };
}

function fakeRelay(): RelaySubscription {
  return new RelaySubscription({
    relayUrl: 'ws://relay.test',
    wsFactory: () => ({ send: () => {}, close: () => {}, on: () => {} }),
  });
}

const signedEvent = (id: string): NostrEvent => ({
  id,
  pubkey: 'pk',
  created_at: 1,
  kind: 1,
  tags: [],
  content: '',
  sig: 'sig',
});

describe('control-plane routes', () => {
  let app: FastifyInstance;
  let runner: ClientRunner;
  let client: FakeClient;

  async function build(ready: boolean): Promise<void> {
    client = new FakeClient();
    runner = new ClientRunner({
      config: config(),
      createClient: () => client,
      createRelay: fakeRelay,
    });
    if (ready) await runner.bootstrap();
    app = Fastify();
    registerRoutes(app, runner);
    await app.ready();
  }

  afterEach(async () => {
    await app?.close();
  });

  describe('when ready', () => {
    beforeEach(() => build(true));

    it('GET /status returns ready', async () => {
      const res = await app.inject({ method: 'GET', url: '/status' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ready: true, bootstrapping: false });
    });

    it('POST /publish returns eventId + nonce', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/publish',
        payload: { event: signedEvent('e1') },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        eventId: 'e1',
        channelId: 'chan-1',
        nonce: 1,
      });
    });

    it('POST /publish rejects an unsigned event with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/publish',
        payload: { event: { id: 'x' } },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_event');
    });

    it('POST /subscribe + GET /events round-trip', async () => {
      const sub = await app.inject({
        method: 'POST',
        url: '/subscribe',
        payload: { filters: { kinds: [1] } },
      });
      expect(sub.statusCode).toBe(200);
      const subId = sub.json().subId as string;
      const events = await app.inject({
        method: 'GET',
        url: `/events?subId=${subId}`,
      });
      expect(events.statusCode).toBe(200);
      expect(events.json()).toMatchObject({
        events: [],
        cursor: 0,
        hasMore: false,
      });
    });

    it('GET /channels lists the tracked channel', async () => {
      const res = await app.inject({ method: 'GET', url: '/channels' });
      expect(res.json().channels).toEqual([
        { channelId: 'chan-1', nonce: 0, cumulativeAmount: '0' },
      ]);
    });

    it('POST /swap forwards to the client', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/swap',
        payload: { destination: 'g.toon.mill', amount: '10' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().accepted).toBe(true);
    });

    it('POST /swap rejects a missing destination with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/swap',
        payload: { amount: '10' },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('when bootstrapping', () => {
    beforeEach(() => build(false));

    it('POST /publish returns 503 retryable', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/publish',
        payload: { event: signedEvent('e1') },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({
        error: 'bootstrapping',
        retryable: true,
      });
    });

    it('GET /status still answers (reads are independent)', async () => {
      const res = await app.inject({ method: 'GET', url: '/status' });
      expect(res.statusCode).toBe(200);
    });

    it('POST /subscribe works while bootstrapping (free reads)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/subscribe',
        payload: { filters: { kinds: [1] } },
      });
      expect(res.statusCode).toBe(200);
    });
  });
});
