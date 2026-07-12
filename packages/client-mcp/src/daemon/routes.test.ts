import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// swap() streams via the SDK; mock the boundary so route wiring tests don't need
// a real swap peer. The mock returns a single accepted claim.
vi.mock('@toon-protocol/sdk/swap', () => ({
  streamSwap: vi.fn().mockResolvedValue({
    state: 'completed',
    claims: [
      {
        packetIndex: 0,
        sourceAmount: 10n,
        targetAmount: 10n,
        claimBytes: new Uint8Array([1]),
        swapEphemeralPubkey: 'ab'.repeat(32),
        pair: {},
        receivedAt: 0,
      },
    ],
    rejections: [],
    errors: [],
    abortReason: 'complete',
    cumulativeSource: 10n,
    cumulativeTarget: 10n,
    packetsSent: 1,
    packetsScheduled: 1,
  }),
}));
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import type { NostrEvent, EventTemplate } from 'nostr-tools/pure';
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
  signEvent(template: EventTemplate): NostrEvent {
    return {
      id: `signed-${template.kind}`,
      pubkey: this.getPublicKey(),
      sig: '0xsig',
      created_at: template.created_at,
      kind: template.kind,
      tags: template.tags,
      content: template.content,
    };
  }
  async uploadBlob(): Promise<{
    success: boolean;
    txId?: string;
    eventId?: string;
    error?: string;
  }> {
    return { success: true, txId: 'tx-routes', eventId: 'blob-evt' };
  }
  openChannelError?: unknown;
  async openChannel(): Promise<string> {
    if (this.openChannelError) throw this.openChannelError;
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
  getChannelDepositTotal(): bigint {
    return 1_000_000n;
  }
  async getBalances(): Promise<{ chain: string; address: string; amount: string }[]> {
    return [{ chain: 'evm', address: '0xself', amount: '5000000' }];
  }
  async depositToChannel(
    channelId: string,
    amount: string
  ): Promise<{ channelId: string; txHash?: string; depositTotal: string }> {
    return { channelId, txHash: '0xdeposit', depositTotal: String(1_000_000n + BigInt(amount)) };
  }
  closeStateValue: 'open' | 'closing' | 'settleable' | 'settled' = 'open';
  settleableAtValue?: bigint;
  settleError?: Error;
  async closeChannel(
    channelId: string
  ): Promise<{ channelId: string; txHash?: string; closedAt: string; settleableAt: string }> {
    this.closeStateValue = 'closing';
    this.settleableAtValue = 2000n;
    return { channelId, txHash: '0xclose', closedAt: '1000', settleableAt: '2000' };
  }
  async settleChannel(channelId: string): Promise<{ channelId: string; txHash?: string }> {
    if (this.settleError) throw this.settleError;
    this.closeStateValue = 'settled';
    return { channelId, txHash: '0xsettle' };
  }
  getChannelCloseState(): 'open' | 'closing' | 'settleable' | 'settled' {
    return this.closeStateValue;
  }
  getSettleableAt(): bigint | undefined {
    return this.settleableAtValue;
  }
  async sendSwapPacket(): Promise<{ accepted: boolean }> {
    return { accepted: true };
  }
  /** Default: a 200 text/plain 'hello'. Overridden per-test where needed. */
  h402Fetch = vi.fn(
    async (): Promise<Response> =>
      new Response('hello', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      })
  );
}

function config(): ResolvedDaemonConfig {
  return {
    httpPort: 0,
    relayUrl: 'ws://relay.test',
    hasUplink: true,
    destination: 'g.proxy',
    publishDestination: 'g.proxy',
    storeDestination: 'g.proxy',
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

describe('control API routes', () => {
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

    it('GET /status returns ready and feePerEvent', async () => {
      const res = await app.inject({ method: 'GET', url: '/status' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        ready: true,
        bootstrapping: false,
        feePerEvent: '1',
      });
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

    it('POST /publish-unsigned signs + publishes, returning eventId + nonce', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/publish-unsigned',
        payload: { kind: 1, content: 'hi', tags: [['t', 'x']] },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ channelId: 'chan-1', nonce: 1 });
      expect(res.json().eventId).toBe('signed-1');
    });

    it('POST /publish-unsigned rejects a missing kind with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/publish-unsigned',
        payload: { content: 'no kind' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_event');
    });

    it('POST /upload-media uploads + publishes, returning url + txId', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/upload-media',
        payload: { dataBase64: Buffer.from('x').toString('base64'), mime: 'image/png', kind: 20 },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        url: 'https://ar-io.dev/tx-routes',
        txId: 'tx-routes',
      });
    });

    it('POST /upload-media rejects missing bytes with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/upload-media',
        payload: { mime: 'image/png' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_media');
    });

    it('POST /upload-media accepts a filePath read off disk', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'toon-routes-upload-'));
      const path = join(dir, 'pic.bin');
      writeFileSync(path, Buffer.from('disk-bytes'));
      const res = await app.inject({
        method: 'POST',
        url: '/upload-media',
        payload: { filePath: path, mime: 'image/png', kind: 20 },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ url: 'https://ar-io.dev/tx-routes', txId: 'tx-routes' });
    });

    it('POST /upload-media rejects supplying BOTH dataBase64 and filePath with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/upload-media',
        payload: { dataBase64: Buffer.from('x').toString('base64'), filePath: '/tmp/x.bin' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_payload');
    });

    it('POST /query returns matching events (empty buffer → [])', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/query',
        payload: { filters: { kinds: [1] }, timeoutMs: 10 },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ events: [] });
    });

    it('POST /query rejects a missing filter with 400', async () => {
      const res = await app.inject({ method: 'POST', url: '/query', payload: {} });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_filters');
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
        {
          channelId: 'chan-1',
          nonce: 0,
          cumulativeAmount: '0',
          depositTotal: '1000000',
          availableBalance: '1000000',
          closeState: 'open',
        },
      ]);
    });

    it('GET /balances returns the wallet balances', async () => {
      const res = await app.inject({ method: 'GET', url: '/balances' });
      expect(res.json().balances).toEqual([{ chain: 'evm', address: '0xself', amount: '5000000' }]);
    });

    it('POST /channels/deposit adds the delta and returns the new total', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/channels/deposit',
        payload: { channelId: 'chan-1', amount: '500000' },
      });
      expect(res.json()).toEqual({
        channelId: 'chan-1',
        txHash: '0xdeposit',
        depositTotal: '1500000', // mock base 1_000_000 + delta 500_000
      });
    });

    it('POST /channels/close returns closedAt + settleableAt', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/channels/close',
        payload: { channelId: 'chan-1' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ channelId: 'chan-1', closedAt: '1000', settleableAt: '2000' });
    });

    it('POST /channels/settle too-early returns 425 retryable', async () => {
      client.settleError = Object.assign(new Error('not settleable yet'), {
        name: 'SettleTooEarlyError',
        retryable: true,
      });
      const res = await app.inject({
        method: 'POST',
        url: '/channels/settle',
        payload: { channelId: 'chan-1' },
      });
      expect(res.statusCode).toBe(425);
      expect(res.json()).toMatchObject({ error: 'settle_too_early', retryable: true });
    });

    it('POST /channels maps a settlement-gas revert to 402 insufficient_gas (#65)', async () => {
      // The client tags the first-write channel-open gas revert; routes matches
      // it by name (no client-package import), like SettleTooEarlyError above.
      client.openChannelError = Object.assign(
        new Error(
          'Settlement wallet 0x1 has no gas on evm to open a payment channel. ' +
            'Run toon_fund_wallet (or fund the wallet) and retry.'
        ),
        { name: 'ChannelFundingError', retryable: true }
      );
      const res = await app.inject({ method: 'POST', url: '/channels', payload: {} });
      expect(res.statusCode).toBe(402);
      expect(res.json()).toMatchObject({ error: 'insufficient_gas', retryable: true });
      expect(res.json().detail).toContain('toon_fund_wallet');
    });

    it('POST /channels surfaces a gas revert nested in a cause chain as 402 (#65)', async () => {
      // On the upload/publish path the tagged error is wrapped in a
      // ToonClientError('Failed to publish event'); the mapper must walk the
      // `cause` chain to find the actionable message.
      const funding = Object.assign(new Error('Settlement wallet 0x1 has no gas on evm — fund it.'), {
        name: 'ChannelFundingError',
      });
      client.openChannelError = Object.assign(new Error('Failed to publish event'), {
        name: 'ToonClientError',
        cause: funding,
      });
      const res = await app.inject({ method: 'POST', url: '/channels', payload: {} });
      expect(res.statusCode).toBe(402);
      expect(res.json()).toMatchObject({ error: 'insufficient_gas', retryable: true });
      expect(res.json().detail).toContain('fund it');
    });

    it('POST /swap forwards to the client', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/swap',
        payload: {
          destination: 'g.toon.swap',
          amount: '10',
          swapPubkey: 'cd'.repeat(32),
          pair: {
            from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:base:84532' },
            to: { assetCode: 'USDC', assetScale: 6, chain: 'solana:devnet' },
            rate: '1.0',
          },
          chainRecipient: 'SoLrecipient',
        },
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

    it('POST /swap rejects a missing pair/swapPubkey/chainRecipient with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/swap',
        payload: { destination: 'g.toon.swap', amount: '10' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('GET /swap/claims returns the persisted received-claim list (#352)', async () => {
      const res = await app.inject({ method: 'GET', url: '/swap/claims' });
      expect(res.statusCode).toBe(200);
      // The route-mock claim carries no settlement metadata (legacy), so
      // nothing was persisted — the wire shape is still the claims envelope.
      expect(res.json()).toEqual({ claims: [] });
    });

    it('POST /swap/settle with nothing to settle returns empty results (#352)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/swap/settle',
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ results: [] });
    });

    it('POST /http-fetch-paid returns { status, headers, body }', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/http-fetch-paid',
        payload: { url: 'https://paid.example/resource' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        status: 200,
        headers: { 'content-type': 'text/plain' },
        body: 'hello',
      });
      expect(client.h402Fetch).toHaveBeenCalledWith(
        'https://paid.example/resource',
        {}
      );
    });

    it('POST /http-fetch-paid forwards method/headers/body/timeout', async () => {
      await app.inject({
        method: 'POST',
        url: '/http-fetch-paid',
        payload: {
          url: 'https://paid.example/post',
          method: 'POST',
          headers: { 'x-test': '1' },
          body: 'payload',
          timeout: 5000,
        },
      });
      expect(client.h402Fetch).toHaveBeenCalledWith(
        'https://paid.example/post',
        {
          method: 'POST',
          headers: { 'x-test': '1' },
          body: 'payload',
          timeout: 5000,
        }
      );
    });

    it('POST /http-fetch-paid rejects a missing url with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/http-fetch-paid',
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });

    it('POST /http-fetch-paid surfaces a thrown error via ErrorResponse', async () => {
      client.h402Fetch.mockRejectedValueOnce(new Error('origin exploded'));
      const res = await app.inject({
        method: 'POST',
        url: '/http-fetch-paid',
        payload: { url: 'https://paid.example/boom' },
      });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toMatchObject({
        error: 'internal_error',
        detail: 'origin exploded',
      });
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
