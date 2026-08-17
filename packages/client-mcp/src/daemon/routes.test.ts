import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import type { NostrEvent, EventTemplate } from 'nostr-tools/pure';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { wrapEvent } from 'nostr-tools/nip59';
import {
  unwrapGiftWrapWithKey,
  evmClaimDigest,
  type UnwrappedGiftWrap,
} from '@toon-protocol/client';
import { hexToBytes } from '@toon-protocol/core';
import { privateKeyToAccount } from 'viem/accounts';
import { registerRoutes } from './routes.js';
import { ClientRunner, type ToonClientLike } from './client-runner.js';
import type { ResolvedDaemonConfig } from './config.js';
import { RelaySubscription } from '../relay-subscription.js';

// toon-client#598: swap() only speaks the ROLLING protocol now (no more
// `@toon-protocol/sdk/swap` boundary to mock). A route wiring test that wants
// an accepted swap needs a real, fully-verifiable EVM balance-proof claim —
// the rolling receive path throws on a metadata-less claim rather than
// surfacing it unverified (unlike the deleted legacy sender). Mirrors the
// fixtures in `client-runner.test.ts`'s rolling-swap tests.
const SWAP_SIGNER_ACCOUNT = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
);
const SWAP_SIGNER = SWAP_SIGNER_ACCOUNT.address.toLowerCase();
const SWAP_RECIPIENT = '0x' + 'aa'.repeat(20);
const SWAP_CHANNEL = '0x' + '11'.repeat(32);
const SWAP_VERIFYING_CONTRACT = '0x' + '22'.repeat(20);
const SWAP_PAIR = {
  from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:base:84532' },
  to: { assetCode: 'USDC', assetScale: 6, chain: 'evm:anvil:31337' },
  rate: '1.0',
};
const SWAP_CHAIN_ID = 31337;
const SWAP_VERIFYING_CONTRACTS = { [SWAP_PAIR.to.chain]: SWAP_VERIFYING_CONTRACT };
/** 16-byte lowercase-hex streamNonce, pinned to skip the RFQ probe (#573/#585). */
const STREAM_NONCE = '6e'.repeat(16);

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

  /**
   * The flat route price this fake connector charges for any destination
   * (ADR 0020). `null` would mean it terminates no matching route.
   */
  routePrice: bigint | null = 1000n;
  async getRoutePrice(): Promise<bigint | null> {
    return this.routePrice;
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
  /**
   * A real secp256k1 identity, independent of `getPublicKey()`'s fake `'pk'`
   * string — used ONLY by the `/nip59-unwrap` route tests (toon-meta#256),
   * which need genuine NIP-44 crypto to exercise a real wrap→unwrap round
   * trip through the HTTP layer.
   */
  readonly nip59SecretKey = generateSecretKey();
  readonly nip59Pubkey = getPublicKey(this.nip59SecretKey);
  unwrapGiftWrap(wrap: NostrEvent): UnwrappedGiftWrap {
    return unwrapGiftWrapWithKey(this.nip59SecretKey, this.nip59Pubkey, wrap);
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
  async getBalances(): Promise<
    { chain: string; address: string; amount: string }[]
  > {
    return [{ chain: 'evm', address: '0xself', amount: '5000000' }];
  }
  async depositToChannel(
    channelId: string,
    amount: string
  ): Promise<{ channelId: string; txHash?: string; depositTotal: string }> {
    return {
      channelId,
      txHash: '0xdeposit',
      depositTotal: String(1_000_000n + BigInt(amount)),
    };
  }
  closeStateValue: 'open' | 'closing' | 'settleable' | 'settled' = 'open';
  settleableAtValue?: bigint;
  settleError?: Error;
  async closeChannel(
    channelId: string
  ): Promise<{
    channelId: string;
    txHash?: string;
    closedAt: string;
    settleableAt: string;
  }> {
    this.closeStateValue = 'closing';
    this.settleableAtValue = 2000n;
    return {
      channelId,
      txHash: '0xclose',
      closedAt: '1000',
      settleableAt: '2000',
    };
  }
  async settleChannel(
    channelId: string
  ): Promise<{ channelId: string; txHash?: string }> {
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
  /**
   * Captured from `ToonClientConfig.jobHandler` at `createClient(cfg)` time
   * (toon-client#573) — routes an inbound rolling leg-B advance to the
   * daemon's session registry, same as `FakeRollingMakerClient` in
   * `client-runner.test.ts`.
   */
  jobHandler?: (job: {
    amount: bigint;
    destination: string;
    executionCondition: Uint8Array;
    expiresAt: Date;
    data: Uint8Array;
  }) => Promise<{ fulfillment: Uint8Array; data?: Uint8Array }>;

  /**
   * Plays the maker's leg-B role for a rolling fill: reads the leg-A fill
   * payload, hands a genuinely-signed EVM advance to the captured
   * `jobHandler`, and reports FULFILLed iff the daemon's own verify-before-
   * reveal accepted it.
   */
  async sendSwapPacket(params: {
    destination: string;
    amount: bigint;
    toonData: Uint8Array;
    executionCondition?: Uint8Array;
    expiresAt?: Date;
  }): Promise<{ accepted: boolean; code?: string; message?: string }> {
    if (!this.jobHandler) return { accepted: true };
    const fill = JSON.parse(new TextDecoder().decode(params.toonData)) as {
      streamNonce: string;
      seq: number;
    };
    const nonce = String(fill.seq);
    const cumulativeAmount = String(Number(params.amount) * fill.seq);
    const digest = evmClaimDigest(
      { chainId: SWAP_CHAIN_ID, verifyingContract: SWAP_VERIFYING_CONTRACT },
      {
        channelId: SWAP_CHANNEL,
        cumulativeAmount: BigInt(cumulativeAmount),
        nonce: BigInt(nonce),
        recipient: SWAP_RECIPIENT,
      }
    );
    const sigHex = await SWAP_SIGNER_ACCOUNT.sign({ hash: digest });
    const data = new TextEncoder().encode(
      JSON.stringify({
        proto: 'rolling/1',
        type: 'advance',
        streamNonce: fill.streamNonce,
        seq: fill.seq,
        claim: Buffer.from(hexToBytes(sigHex)).toString('base64'),
        channelId: SWAP_CHANNEL,
        nonce,
        cumulativeAmount,
        recipient: SWAP_RECIPIENT,
        swapSignerAddress: SWAP_SIGNER,
        rate: '1.0',
        rateTimestamp: 1_700_000_000_000,
        sourceAmount: String(params.amount),
        targetAmount: String(params.amount),
      })
    );
    try {
      await this.jobHandler({
        amount: params.amount,
        destination: params.destination,
        executionCondition: params.executionCondition ?? new Uint8Array(32),
        expiresAt: params.expiresAt ?? new Date(Date.now() + 30_000),
        data,
      });
      return { accepted: true };
    } catch (err) {
      return {
        accepted: false,
        code: 'F99',
        message: err instanceof Error ? err.message : String(err),
      };
    }
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
    toonClientConfig: {
      btpUrl: 'ws://apex/btp',
      swapVerifyingContracts: SWAP_VERIFYING_CONTRACTS,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
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
      createClient: (cfg) => {
        client.jobHandler = cfg.jobHandler as typeof client.jobHandler;
        return client;
      },
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

    it('POST /nip59-unwrap unwraps a real gift wrap, returning rumor + sealPubkey', async () => {
      const senderSecretKey = generateSecretKey();
      const senderPubkey = getPublicKey(senderSecretKey);
      const wrap = wrapEvent(
        { kind: 30078, content: 'super-secret-channel-key', tags: [['d', 'chan']] },
        senderSecretKey,
        client.nip59Pubkey
      );

      const res = await app.inject({
        method: 'POST',
        url: '/nip59-unwrap',
        payload: { wrap },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.rumor).toMatchObject({
        kind: 30078,
        content: 'super-secret-channel-key',
        tags: [['d', 'chan']],
      });
      // The real author, read off the SEAL — not the wrap's ephemeral pubkey.
      expect(body.sealPubkey).toBe(senderPubkey);
      expect(body.sealPubkey).not.toBe(wrap.pubkey);
    });

    it('POST /nip59-unwrap rejects a wrap addressed to someone else with 400', async () => {
      const senderSecretKey = generateSecretKey();
      const someoneElsePubkey = getPublicKey(generateSecretKey());
      const wrap = wrapEvent(
        { kind: 1, content: 'not for you' },
        senderSecretKey,
        someoneElsePubkey
      );

      const res = await app.inject({
        method: 'POST',
        url: '/nip59-unwrap',
        payload: { wrap },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_wrap');
    });

    it('POST /nip59-unwrap rejects a missing wrap with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/nip59-unwrap',
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_wrap');
    });

    it('POST /nip59-unwrap rejects garbage ciphertext with 422', async () => {
      const senderPubkey = getPublicKey(generateSecretKey());
      const garbageWrap: NostrEvent = {
        kind: 1059,
        pubkey: senderPubkey,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['p', client.nip59Pubkey]],
        content: 'not-nip44-ciphertext-at-all',
        id: 'a'.repeat(64),
        sig: 'b'.repeat(128),
      };

      const res = await app.inject({
        method: 'POST',
        url: '/nip59-unwrap',
        payload: { wrap: garbageWrap },
      });

      expect(res.statusCode).toBe(422);
      expect(res.json().error).toBe('decrypt_failed');
    });

    it('POST /upload-media uploads + publishes, returning url + txId', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/upload-media',
        payload: {
          dataBase64: Buffer.from('x').toString('base64'),
          mime: 'image/png',
          kind: 20,
        },
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
      expect(res.json()).toMatchObject({
        url: 'https://ar-io.dev/tx-routes',
        txId: 'tx-routes',
      });
    });

    it('POST /upload-media rejects supplying BOTH dataBase64 and filePath with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/upload-media',
        payload: {
          dataBase64: Buffer.from('x').toString('base64'),
          filePath: '/tmp/x.bin',
        },
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
      const res = await app.inject({
        method: 'POST',
        url: '/query',
        payload: {},
      });
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
      expect(res.json().balances).toEqual([
        { chain: 'evm', address: '0xself', amount: '5000000' },
      ]);
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
      expect(res.json()).toMatchObject({
        channelId: 'chan-1',
        closedAt: '1000',
        settleableAt: '2000',
      });
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
      expect(res.json()).toMatchObject({
        error: 'settle_too_early',
        retryable: true,
      });
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
      const res = await app.inject({
        method: 'POST',
        url: '/channels',
        payload: {},
      });
      expect(res.statusCode).toBe(402);
      expect(res.json()).toMatchObject({
        error: 'insufficient_gas',
        retryable: true,
      });
      expect(res.json().detail).toContain('toon_fund_wallet');
    });

    it('POST /channels surfaces a gas revert nested in a cause chain as 402 (#65)', async () => {
      // On the upload/publish path the tagged error is wrapped in a
      // ToonClientError('Failed to publish event'); the mapper must walk the
      // `cause` chain to find the actionable message.
      const funding = Object.assign(
        new Error('Settlement wallet 0x1 has no gas on evm — fund it.'),
        {
          name: 'ChannelFundingError',
        }
      );
      client.openChannelError = Object.assign(
        new Error('Failed to publish event'),
        {
          name: 'ToonClientError',
          cause: funding,
        }
      );
      const res = await app.inject({
        method: 'POST',
        url: '/channels',
        payload: {},
      });
      expect(res.statusCode).toBe(402);
      expect(res.json()).toMatchObject({
        error: 'insufficient_gas',
        retryable: true,
      });
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
          pair: SWAP_PAIR,
          chainRecipient: SWAP_RECIPIENT,
          // Pin the session (toon-client#573/#585) so this fake — a plain
          // rolling fill responder, not an RFQ-capable one — can be driven
          // straight to a fill without wiring kind:20033/20034 wire mechanics.
          streamNonce: STREAM_NONCE,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().accepted).toBe(true);
    });

    it('[#595] POST /swap answers 502 rolling_unavailable — not 400 — when the maker establishes no session', async () => {
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
      // A counterparty fault, not a malformed request.
      expect(res.statusCode).toBe(502);
      expect(res.json()).toMatchObject({
        error: 'rolling_unavailable',
        reason: 'no-sender-address',
        swapPubkey: 'cd'.repeat(32),
        destination: 'g.toon.swap',
      });
      // The detail is the diagnosis, naming the maker and the way out — no
      // legacy fallback to mention any more (ADR 0003, toon-client#598).
      expect(res.json().detail).toContain('g.toon.swap');
      expect(res.json().detail).toContain('kind:20033 RFQ intake');
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
