import { describe, it, expect, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerToonApps } from './apps-server.js';
import {
  DaemonAppBackend,
  type DaemonControl,
  type DaemonPublishResponse,
  type DaemonPublishUnsignedRequest,
  type DaemonQueryRequest,
  type DaemonQueryResponse,
  type DaemonUploadMediaRequest,
  type DaemonUploadMediaResponse,
} from './daemon-backend.js';
import { type SwapRequest, type SwapResponse } from './backend.js';
import { type NostrEvent, type NostrFilter } from '../types.js';

const APP_HTML = '<!doctype html><html><body><div id="root"></div></body></html>';

/**
 * In-memory `DaemonControl` recording every call. Returns deterministic
 * daemon-shaped responses (`channelId` + `nonce` from a paid write; `url`/`txId`
 * from an Arweave upload) so the mapping into `PublishResult`/`UploadResult`
 * can be asserted exactly.
 */
class FakeDaemonControl implements DaemonControl {
  readonly queries: DaemonQueryRequest[] = [];
  readonly publishes: DaemonPublishUnsignedRequest[] = [];
  readonly uploads: DaemonUploadMediaRequest[] = [];
  readonly opens: { destination?: string }[] = [];
  readonly swaps: SwapRequest[] = [];
  private nonce = 0;
  events: NostrEvent[] = [
    {
      id: 'n_root',
      pubkey: 'a11ce',
      created_at: 1_700_000_100,
      kind: 1,
      tags: [],
      content: 'gm over TOON',
      sig: 'sig',
    },
  ];

  query(body: DaemonQueryRequest): Promise<DaemonQueryResponse> {
    this.queries.push(body);
    const filters = (Array.isArray(body.filters) ? body.filters : [body.filters]) as NostrFilter[];
    const events = this.events.filter((e) =>
      filters.some((f) => !f.kinds || f.kinds.includes(e.kind))
    );
    return Promise.resolve({ events });
  }

  publishUnsigned(body: DaemonPublishUnsignedRequest): Promise<DaemonPublishResponse> {
    this.publishes.push(body);
    const nonce = ++this.nonce;
    const eventId = `pub_${nonce}`;
    this.events.push({
      id: eventId,
      pubkey: 'self',
      created_at: 1_700_001_000 + nonce,
      kind: body.kind,
      tags: body.tags ?? [],
      content: body.content ?? '',
      sig: 'sig',
    });
    return Promise.resolve({ eventId, channelId: 'chan-1', nonce });
  }

  uploadMedia(body: DaemonUploadMediaRequest): Promise<DaemonUploadMediaResponse> {
    this.uploads.push(body);
    const nonce = ++this.nonce;
    const txId = `ar_${nonce}`;
    const url = `https://arweave.net/${txId}`;
    const eventId = `media_${nonce}`;
    this.events.push({
      id: eventId,
      pubkey: 'self',
      created_at: 1_700_001_000 + nonce,
      kind: body.kind ?? 1063,
      tags: [['url', url], ['m', body.mime ?? 'application/octet-stream']],
      content: body.caption ?? '',
      sig: 'sig',
    });
    return Promise.resolve({ eventId, channelId: 'chan-1', nonce, url, txId });
  }

  openChannel(body: { destination?: string }): Promise<{ channelId: string }> {
    this.opens.push(body);
    return Promise.resolve({ channelId: `chan-${++this.nonce}` });
  }

  swap(body: SwapRequest): Promise<SwapResponse> {
    this.swaps.push(body);
    return Promise.resolve({
      accepted: true,
      packetsAccepted: 1,
      claims: [
        { sourceAmount: body.amount, targetAmount: body.amount, claim: 'claim_b64' },
      ],
      cumulativeSource: body.amount,
      cumulativeTarget: body.amount,
      state: 'completed',
    });
  }
}

async function connect(): Promise<{ client: Client; control: FakeDaemonControl }> {
  const control = new FakeDaemonControl();
  const server = new McpServer({ name: 'toon-daemon-test', version: '0.0.0' });
  registerToonApps(server, { backend: new DaemonAppBackend(control), appHtml: APP_HTML });
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientT), server.connect(serverT)]);
  return { client, control };
}

function structured(res: unknown): Record<string, unknown> {
  return (res as { structuredContent?: Record<string, unknown> }).structuredContent ?? {};
}

describe('DaemonAppBackend (daemon-backed apps surface)', () => {
  let client: Client;
  let control: FakeDaemonControl;

  beforeEach(async () => {
    ({ client, control } = await connect());
  });

  it('exposes the same generative-UI tools as the fake-backed server', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'toon_atoms',
        'toon_render',
        'toon_query',
        'toon_publish_unsigned',
        'toon_upload_media',
      ])
    );
  });

  it('toon_query forwards the filter to control.query and returns its events', async () => {
    const res = await client.callTool({ name: 'toon_query', arguments: { filter: { kinds: [1] } } });
    const events = structured(res)['events'] as { kind: number }[];
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.kind === 1)).toBe(true);
    // The view-layer filter was passed through as `{ filters: <filter> }`.
    expect(control.queries).toHaveLength(1);
    expect(control.queries[0]).toEqual({ filters: { kinds: [1] } });
  });

  it('toon_publish_unsigned delegates to control.publishUnsigned and maps PublishResult', async () => {
    const res = await client.callTool({
      name: 'toon_publish_unsigned',
      arguments: { kind: 1, content: 'posted from the UI', tags: [['t', 'demo']] },
    });
    const sc = structured(res);
    // Mapped daemon response: eventId + channelId + nonce (no key material).
    expect(sc['eventId']).toBe('pub_1');
    expect(sc['channelId']).toBe('chan-1');
    expect(sc['nonce']).toBe(1);
    // The unsigned shell reached the daemon unchanged.
    expect(control.publishes).toEqual([
      { kind: 1, content: 'posted from the UI', tags: [['t', 'demo']] },
    ]);
    // Reflected on the next read (journey loop).
    const after = structured(
      await client.callTool({ name: 'toon_query', arguments: { filter: { kinds: [1] } } })
    )['events'] as { content: string }[];
    expect(after.some((e) => e.content === 'posted from the UI')).toBe(true);
  });

  it('toon_upload_media delegates to control.uploadMedia and maps UploadResult', async () => {
    const res = await client.callTool({
      name: 'toon_upload_media',
      arguments: { dataBase64: Buffer.from('img').toString('base64'), mime: 'image/png', kind: 20 },
    });
    const sc = structured(res);
    expect(String(sc['url'])).toMatch(/arweave\.net\//);
    expect(sc['txId']).toBe('ar_1');
    expect(sc['eventId']).toBe('media_1');
    expect(sc['channelId']).toBe('chan-1');
    expect(sc['nonce']).toBe(1);
    expect(control.uploads).toHaveLength(1);
    expect(control.uploads[0]?.kind).toBe(20);
    expect(control.uploads[0]?.mime).toBe('image/png');
  });

  it('openChannel + swap (DeFi seam) delegate to the control port', async () => {
    const ctrl = new FakeDaemonControl();
    const backend = new DaemonAppBackend(ctrl);

    const ch = await backend.openChannel({ destination: 'g.proxy.relay' });
    expect(ch.channelId).toMatch(/^chan-/);
    expect(ctrl.opens).toEqual([{ destination: 'g.proxy.relay' }]);

    const req: SwapRequest = {
      destination: 'g.proxy.mill',
      amount: '1000',
      millPubkey: 'ab'.repeat(32),
      pair: {
        from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:31337' },
        to: { assetCode: 'USDC', assetScale: 6, chain: 'solana:devnet' },
        rate: '1',
      },
      chainRecipient: 'SoLrecipient',
    };
    const sr = await backend.swap(req);
    expect(sr.accepted).toBe(true);
    expect(sr.state).toBe('completed');
    expect(sr.cumulativeTarget).toBe('1000');
    expect(ctrl.swaps).toEqual([req]);
  });
});
