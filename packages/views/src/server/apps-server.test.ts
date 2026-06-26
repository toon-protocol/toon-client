import { describe, it, expect, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ARWEAVE_GATEWAYS } from '@toon-protocol/arweave';
import { registerToonApps } from './apps-server.js';
import { FakeBackend } from './fake-backend.js';
import { APP_RESOURCE_URI } from '../tool-names.js';
import { type ViewSpec } from '../spec.js';

const APP_HTML = '<!doctype html><html><body><div id="root"></div></body></html>';

async function connect(): Promise<{ client: Client; backend: FakeBackend }> {
  const backend = new FakeBackend();
  const server = new McpServer({ name: 'toon-fake-test', version: '0.0.0' });
  registerToonApps(server, { backend, appHtml: APP_HTML });
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientT), server.connect(serverT)]);
  return { client, backend };
}

function structured(res: unknown): Record<string, unknown> {
  return (res as { structuredContent?: Record<string, unknown> }).structuredContent ?? {};
}

describe('TOON apps MCP server (fake-backed)', () => {
  let client: Client;
  let backend: FakeBackend;

  beforeEach(async () => {
    ({ client, backend } = await connect());
  });

  it('exposes the app resource with the mcp-app MIME', async () => {
    const list = await client.listResources();
    expect(list.resources.some((r) => r.uri === APP_RESOURCE_URI)).toBe(true);
    const read = await client.readResource({ uri: APP_RESOURCE_URI });
    const content = read.contents[0] as { mimeType?: string; text?: string };
    expect(content.mimeType).toBe('text/html;profile=mcp-app');
    expect(content.text).toContain('<div id="root">');
  });

  it('iframe CSP allows every Arweave gateway the media renderer can emit', async () => {
    // Regression for #127: media-embed renders <img>/<video> at the gateway
    // preference list (ar-io.dev primary, with fallbacks). An arweave.net-only
    // CSP silently blocked those origins so images never loaded. The default must
    // stay in lockstep with ARWEAVE_GATEWAYS — the renderer's source of truth.
    const list = await client.listResources();
    const app = list.resources.find((r) => r.uri === APP_RESOURCE_URI);
    const csp = (app?._meta as { ui?: { csp?: { resourceDomains?: string[]; connectDomains?: string[] } } })
      ?.ui?.csp;
    for (const gateway of ARWEAVE_GATEWAYS) {
      expect(csp?.resourceDomains).toContain(gateway);
      expect(csp?.connectDomains).toContain(gateway);
    }
  });

  it('lists the generative-UI tools (toon_render carries _meta.ui.resourceUri)', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'toon_atoms',
        'toon_render',
        'toon_query',
        'toon_publish_unsigned',
        'toon_upload',
        'toon_open_channel',
        'toon_swap',
        'toon_status',
      ])
    );
    const render = tools.find((t) => t.name === 'toon_render');
    const meta = render?._meta as { ui?: { resourceUri?: string } } | undefined;
    expect(meta?.ui?.resourceUri).toBe(APP_RESOURCE_URI);
  });

  it('toon_atoms returns the atom catalog in structuredContent and JSON text', async () => {
    const res = await client.callTool({ name: 'toon_atoms', arguments: {} });
    const atoms = structured(res)['atoms'] as { id: string }[];
    expect(atoms.some((a) => a.id === 'note-card')).toBe(true);
    expect(atoms.some((a) => a.id === 'generic-event')).toBe(true);
    const text = (res as { content?: { text?: string }[] }).content?.[0]?.text ?? '';
    const parsed = JSON.parse(text) as { atoms: { id: string }[] };
    expect(parsed.atoms.some((a) => a.id === 'note-card')).toBe(true);
  });

  it('toon_status returns the fee + settlement chain (deterministic stub)', async () => {
    const res = await client.callTool({ name: 'toon_status', arguments: {} });
    expect((res as { isError?: boolean }).isError).toBeFalsy();
    const sc = structured(res);
    expect(sc['feePerEvent']).toBe('1');
    expect(sc['settlementChain']).toBe('base');
    expect(sc['asset']).toBe('USDC');
  });

  it('toon_query reads seeded events from the fake relay', async () => {
    const res = await client.callTool({ name: 'toon_query', arguments: { filter: { kinds: [1] } } });
    const events = structured(res)['events'] as { kind: number }[];
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.kind === 1)).toBe(true);
  });

  it('toon_render echoes a valid ViewSpec and rejects an invalid one', async () => {
    const spec: ViewSpec = {
      title: 'Feed',
      root: { atom: 'stack', children: [{ atom: 'note-card', bind: { query: { kinds: [1] }, kindAuto: true } }] },
    };
    const ok = await client.callTool({ name: 'toon_render', arguments: { spec } });
    expect((ok as { isError?: boolean }).isError).toBeFalsy();
    expect(structured(ok)['viewSpec']).toEqual(spec);

    const bad = await client.callTool({ name: 'toon_render', arguments: { spec: { root: { atom: 'evil' } } } });
    expect((bad as { isError?: boolean }).isError).toBe(true);
  });

  it('a published note is reflected on the next read (journey loop)', async () => {
    const before = (structured(
      await client.callTool({ name: 'toon_query', arguments: { filter: { kinds: [1] } } })
    )['events'] as unknown[]).length;

    await client.callTool({
      name: 'toon_publish_unsigned',
      arguments: { kind: 1, content: 'posted from the UI' },
    });

    const after = structured(
      await client.callTool({ name: 'toon_query', arguments: { filter: { kinds: [1] } } })
    )['events'] as { content: string }[];
    expect(after.length).toBe(before + 1);
    expect(after.some((e) => e.content === 'posted from the UI')).toBe(true);
  });

  it('toon_upload uploads then publishes a referencing event', async () => {
    const res = await client.callTool({
      name: 'toon_upload',
      arguments: { dataBase64: Buffer.from('img').toString('base64'), mime: 'image/png', kind: 20 },
    });
    const sc = structured(res);
    expect(String(sc['url'])).toMatch(/arweave\.net\//);
    // the picture is now queryable
    const pics = structured(
      await client.callTool({ name: 'toon_query', arguments: { filter: { kinds: [20] } } })
    )['events'] as unknown[];
    expect(pics.length).toBeGreaterThan(0);
    expect(backend.size()).toBeGreaterThan(0);
  });

  it('toon_open_channel returns a channelId', async () => {
    const res = await client.callTool({
      name: 'toon_open_channel',
      arguments: { destination: 'g.proxy.mill' },
    });
    expect((res as { isError?: boolean }).isError).toBeFalsy();
    expect(String(structured(res)['channelId'])).toContain('fake-channel');
  });

  it('toon_swap returns a settlement receipt (SwapResponse + one claim)', async () => {
    const res = await client.callTool({
      name: 'toon_swap',
      arguments: {
        destination: 'g.proxy.mill',
        amount: '1000000',
        millPubkey: 'a'.repeat(64),
        pair: {
          from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:31337' },
          to: { assetCode: 'USDC', assetScale: 6, chain: 'solana:devnet' },
          rate: '1',
        },
        chainRecipient: '0x000000000000000000000000000000000000dEaD',
      },
    });
    expect((res as { isError?: boolean }).isError).toBeFalsy();
    const sc = structured(res);
    expect(sc['accepted']).toBe(true);
    expect(sc['state']).toBe('completed');
    expect(sc['cumulativeTarget']).toBe('1000000');
    const claims = sc['claims'] as { targetAmount: string; channelId?: string }[];
    expect(claims.length).toBe(1);
    expect(claims[0]?.targetAmount).toBe('1000000');
    expect(String(claims[0]?.channelId)).toContain('fake-target-channel');
  });
});
