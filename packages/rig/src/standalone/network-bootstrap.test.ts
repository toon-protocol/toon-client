/**
 * Tests for the #264 network bootstrap: kind:10032 announce discovery,
 * payment-peer selection, per-chain settlement derivation, the documented
 * settlement-chain selection rule, and core 2.x genesis-seed loading.
 */

import { describe, it, expect } from 'vitest';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';

import type { NostrEvent } from '../remote-state.js';
import {
  DEVNET_CHAIN_RPC_URLS,
  TokenNetworkUnderivableError,
  discoverAnnouncedPeers,
  evmPresetForChain,
  evmTokenBalance,
  genesisSeedPubkeys,
  isDevnetZonePeer,
  loadGenesisSeed,
  pickPaymentPeer,
  resolveChainSettlement,
  selectSettlementChain,
  type AnnouncedPeer,
} from './network-bootstrap.js';

// ---------------------------------------------------------------------------
// Fixtures — modeled on the LIVE devnet announces (connector >= 3.28.5)
// ---------------------------------------------------------------------------

const APEX_PUBKEY = 'a1'.repeat(32);
const STORE_PUBKEY = 'b2'.repeat(32);
const SEED_PUBKEY = 'c3'.repeat(32);

/** The apex announce content (devnet shape: qualified chains + routes). */
const APEX_CONTENT = {
  ilpAddress: 'g.proxy.relay',
  btpEndpoint: 'wss://proxy.devnet.toonprotocol.dev:443',
  assetCode: 'USDC',
  assetScale: 6,
  httpEndpoint: 'https://proxy.devnet.toonprotocol.dev/ilp',
  relayUrl: 'wss://relay-ws.devnet.toonprotocol.dev',
  supportedChains: ['evm:31337', 'solana:devnet', 'mina:devnet'],
  settlementAddresses: {
    'evm:31337': '0xC0E55cD2E967a4F625627DaE5d4946f54267C7ab',
    'solana:devnet': 'A3FG5y6rfBNJQrsGYTNNR7UHAXCREPJgV362LdTQGNwK',
    'mina:devnet': 'B62qkEx3MsKtaEJqJMg8ZC2eXtz8FNpZy4huVpBnnUHVRUEf5f1vqdq',
  },
  routes: { publish: 'g.proxy.relay', store: 'g.proxy.store' },
};

function announceEvent(
  pubkey: string,
  content: unknown,
  createdAt = 1000,
  overrides: Partial<NostrEvent> = {}
): NostrEvent {
  return {
    id: 'e0'.repeat(32),
    pubkey,
    created_at: createdAt,
    kind: 10032,
    tags: [],
    content: JSON.stringify(content),
    sig: 'f0'.repeat(64),
    ...overrides,
  };
}

function announcedPeer(
  pubkey: string,
  content: Record<string, unknown>,
  createdAt = 1000
): AnnouncedPeer {
  const event = announceEvent(pubkey, content, createdAt);
  // Build through the same content JSON the parser sees.
  return {
    pubkey,
    info: content as unknown as AnnouncedPeer['info'],
    ...(content['routes']
      ? { routes: content['routes'] as AnnouncedPeer['routes'] }
      : {}),
    createdAt: event.created_at,
  };
}

// ---------------------------------------------------------------------------
// Mock relay
// ---------------------------------------------------------------------------

async function withMockRelay(
  events: NostrEvent[],
  run: (relayUrl: string) => Promise<void>
): Promise<void> {
  const wss = new WebSocketServer({ port: 0 });
  wss.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as [string, string, unknown];
      if (msg[0] !== 'REQ') return;
      const subId = msg[1];
      for (const event of events) {
        socket.send(JSON.stringify(['EVENT', subId, event]));
      }
      socket.send(JSON.stringify(['EOSE', subId]));
    });
  });
  await new Promise<void>((resolve) => wss.on('listening', resolve));
  const { port } = wss.address() as AddressInfo;
  try {
    await run(`ws://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }
}

// ---------------------------------------------------------------------------
// discoverAnnouncedPeers
// ---------------------------------------------------------------------------

describe('discoverAnnouncedPeers', () => {
  it('returns the latest schema-valid announce per author with routes', async () => {
    await withMockRelay(
      [
        announceEvent(APEX_PUBKEY, APEX_CONTENT, 500),
        announceEvent(APEX_PUBKEY, APEX_CONTENT, 900), // newer wins
        announceEvent(STORE_PUBKEY, 'not json at all', 800, {
          content: 'not json at all',
        }),
        // A plain kind:10032 experiment (invalid IlpPeerInfo) is skipped.
        announceEvent('d4'.repeat(32), { hello: 'world' }, 700),
      ],
      async (relayUrl) => {
        const peers = await discoverAnnouncedPeers(relayUrl, {
          timeoutMs: 2000,
        });
        expect(peers).toHaveLength(1);
        const apex = peers[0] as AnnouncedPeer;
        expect(apex.pubkey).toBe(APEX_PUBKEY);
        expect(apex.createdAt).toBe(900);
        expect(apex.info.ilpAddress).toBe('g.proxy.relay');
        expect(apex.info.supportedChains).toEqual([
          'evm:31337',
          'solana:devnet',
          'mina:devnet',
        ]);
        expect(apex.routes).toEqual({
          publish: 'g.proxy.relay',
          store: 'g.proxy.store',
        });
      }
    );
  });

  it('skips NIP-40 expired announces', async () => {
    await withMockRelay(
      [
        announceEvent(APEX_PUBKEY, APEX_CONTENT, 900, {
          tags: [['expiration', '1']], // long past
        }),
      ],
      async (relayUrl) => {
        const peers = await discoverAnnouncedPeers(relayUrl, {
          timeoutMs: 2000,
        });
        expect(peers).toHaveLength(0);
      }
    );
  });

  it('rejects on an unreachable relay', async () => {
    await expect(
      discoverAnnouncedPeers('ws://127.0.0.1:1', { timeoutMs: 2000 })
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// pickPaymentPeer
// ---------------------------------------------------------------------------

describe('pickPaymentPeer', () => {
  const apex = announcedPeer(APEX_PUBKEY, APEX_CONTENT, 900);
  const store = announcedPeer(
    STORE_PUBKEY,
    {
      ...APEX_CONTENT,
      ilpAddress: 'g.proxy.store',
      httpEndpoint: 'https://proxy.store.devnet.toonprotocol.dev/ilp',
      btpEndpoint: 'wss://proxy.store.devnet.toonprotocol.dev:443',
      supportedChains: ['evm:31337'],
      settlementAddresses: { 'evm:31337': '0x1f4E' },
    },
    950
  );

  it('prefers the genesis-seed pubkey announce over anything else', () => {
    const seeded = announcedPeer(SEED_PUBKEY, APEX_CONTENT, 100);
    expect(pickPaymentPeer([store, apex, seeded], [SEED_PUBKEY])).toBe(seeded);
  });

  it('prefers the publish edge (ilpAddress === routes.publish)', () => {
    // The store announce is NEWER but its ilpAddress is the store route.
    expect(pickPaymentPeer([store, apex], [])).toBe(apex);
  });

  it('falls back to the freshest payable announce', () => {
    const noRoutes = announcedPeer(
      STORE_PUBKEY,
      { ...APEX_CONTENT, ilpAddress: 'g.other', routes: undefined },
      2000
    );
    const older = announcedPeer(
      APEX_PUBKEY,
      { ...APEX_CONTENT, ilpAddress: 'g.other2', routes: undefined },
      1000
    );
    expect(pickPaymentPeer([older, noRoutes], [])).toBe(noRoutes);
  });

  it('returns undefined when no announce can take paid writes', () => {
    const noUplink = announcedPeer(APEX_PUBKEY, {
      ...APEX_CONTENT,
      httpEndpoint: undefined,
      btpEndpoint: undefined,
    });
    const noSettlement = announcedPeer(STORE_PUBKEY, {
      ...APEX_CONTENT,
      settlementAddresses: undefined,
    });
    expect(pickPaymentPeer([noUplink, noSettlement], [])).toBeUndefined();
    expect(pickPaymentPeer([], [])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveChainSettlement — explicit > announce > devnet table > core preset
// ---------------------------------------------------------------------------

describe('resolveChainSettlement', () => {
  const apex = announcedPeer(APEX_PUBKEY, APEX_CONTENT);

  it('derives evm:31337 fully for a devnet-zone peer (no explicit config)', () => {
    const s = resolveChainSettlement('evm:31337', {}, apex);
    expect(s.family).toBe('evm');
    // RPC: the devnet endpoint table (announce hosts are *.devnet.toonprotocol.dev).
    expect(s.rpcUrl).toBe(DEVNET_CHAIN_RPC_URLS['evm:31337']);
    // TokenNetwork/token: core's deterministic anvil (31337) chain preset.
    const preset = evmPresetForChain('evm:31337');
    expect(preset).toBeDefined();
    expect(s.tokenNetwork).toBe(preset?.tokenNetworkAddress);
    expect(s.tokenAddress).toBe(preset?.usdcAddress);
  });

  it('explicit config beats announce and presets', () => {
    const announceWithParams = announcedPeer(APEX_PUBKEY, {
      ...APEX_CONTENT,
      tokenNetworks: { 'evm:31337': '0xANNOUNCED' },
      preferredTokens: { 'evm:31337': '0xANNOUNCEDTOKEN' },
    });
    const s = resolveChainSettlement(
      'evm:31337',
      {
        tokenNetworks: { 'evm:31337': '0xEXPLICIT' },
        preferredTokens: { 'evm:31337': '0xEXPLICITTOKEN' },
        chainRpcUrls: { 'evm:31337': 'http://explicit:8545' },
      },
      announceWithParams
    );
    expect(s.tokenNetwork).toBe('0xEXPLICIT');
    expect(s.tokenAddress).toBe('0xEXPLICITTOKEN');
    expect(s.rpcUrl).toBe('http://explicit:8545');
  });

  it('announce tokenNetworks beat the chain preset', () => {
    const announceWithParams = announcedPeer(APEX_PUBKEY, {
      ...APEX_CONTENT,
      tokenNetworks: { 'evm:31337': '0xANNOUNCED' },
    });
    const s = resolveChainSettlement('evm:31337', {}, announceWithParams);
    expect(s.tokenNetwork).toBe('0xANNOUNCED');
  });

  it('does not apply the devnet RPC table for non-devnet peers', () => {
    const local = announcedPeer(APEX_PUBKEY, {
      ...APEX_CONTENT,
      httpEndpoint: 'http://localhost:8080/ilp',
      btpEndpoint: 'ws://localhost:3000',
      relayUrl: 'ws://localhost:7100',
    });
    expect(isDevnetZonePeer(local)).toBe(false);
    const s = resolveChainSettlement('evm:31337', {}, local);
    // Falls to the anvil preset's localhost RPC — right for a local stack.
    expect(s.rpcUrl).toBe(evmPresetForChain('evm:31337')?.rpcUrl);
  });

  it('leaves fields undefined for an unknown EVM chain', () => {
    const s = resolveChainSettlement('evm:999999', {}, apex);
    expect(s.tokenNetwork).toBeUndefined();
    expect(s.rpcUrl).toBeUndefined();
  });

  it('TokenNetworkUnderivableError names the announce, chain, and relay', () => {
    const err = new TokenNetworkUnderivableError(
      'evm:999999',
      apex,
      'wss://relay.example'
    );
    expect(err.message).toContain('evm:999999');
    expect(err.message).toContain(APEX_PUBKEY.slice(0, 16));
    expect(err.message).toContain('wss://relay.example');
    const errNoAnnounce = new TokenNetworkUnderivableError(
      'evm:999999',
      undefined,
      'wss://relay.example'
    );
    expect(errNoAnnounce.message).toContain('no kind:10032 announce');
  });
});

// ---------------------------------------------------------------------------
// selectSettlementChain — explicit > persisted channel > funded > first EVM
// ---------------------------------------------------------------------------

describe('selectSettlementChain', () => {
  const announcedChains = ['solana:devnet', 'evm:31337', 'mina:devnet'];
  const resolveSettlement = (chain: string) => ({
    chain,
    family: chain.split(':')[0] as string,
    rpcUrl: `http://rpc.example/${chain}`,
    tokenAddress: '0xTOKEN',
  });

  it('explicit full chain id wins even when not announced', async () => {
    const selection = await selectSettlementChain({
      explicitChain: 'evm:8453',
      announcedChains,
      resolveSettlement,
    });
    expect(selection).toMatchObject({ chain: 'evm:8453', reason: 'explicit' });
  });

  it('explicit family resolves against announced chains', async () => {
    const selection = await selectSettlementChain({
      explicitChain: 'evm',
      announcedChains,
      resolveSettlement,
    });
    expect(selection).toMatchObject({ chain: 'evm:31337', reason: 'explicit' });
  });

  it('explicit family not announced throws with the announced list', async () => {
    await expect(
      selectSettlementChain({
        explicitChain: 'xrp',
        announcedChains,
        resolveSettlement,
      })
    ).rejects.toThrow(/xrp.*not announced/s);
  });

  it('a live persisted channel beats funded/default (most recent first)', async () => {
    const selection = await selectSettlementChain({
      announcedChains,
      records: [
        { chain: 'mina:devnet', lastUsedAt: '2026-01-01T00:00:00Z', closed: false },
        { chain: 'solana:devnet', lastUsedAt: '2026-06-01T00:00:00Z', closed: false },
        { chain: 'evm:31337', lastUsedAt: '2026-07-01T00:00:00Z', closed: true },
      ],
      resolveSettlement,
    });
    expect(selection).toMatchObject({
      chain: 'solana:devnet',
      reason: 'persisted-channel',
    });
  });

  it('ignores persisted channels on chains the peer no longer announces', async () => {
    const selection = await selectSettlementChain({
      announcedChains,
      records: [
        { chain: 'evm:8453', lastUsedAt: '2026-07-01T00:00:00Z', closed: false },
      ],
      resolveSettlement,
    });
    expect(selection.reason).toBe('default');
  });

  it('picks the first funded EVM chain via the balance probe', async () => {
    const probed: string[] = [];
    const selection = await selectSettlementChain({
      announcedChains: ['evm:1', 'evm:31337', 'solana:devnet'],
      evmAddress: '0x' + '11'.repeat(20),
      resolveSettlement,
      probeBalance: (args) => {
        probed.push(args.rpcUrl);
        return Promise.resolve(
          args.rpcUrl.endsWith('evm:31337') ? 10000n : 0n
        );
      },
    });
    expect(selection).toMatchObject({ chain: 'evm:31337', reason: 'funded' });
    expect(probed).toHaveLength(2);
  });

  it('probe errors skip the candidate instead of failing selection', async () => {
    const selection = await selectSettlementChain({
      announcedChains: ['evm:1', 'evm:31337'],
      evmAddress: '0x' + '11'.repeat(20),
      resolveSettlement,
      probeBalance: (args) => {
        if (args.rpcUrl.endsWith('evm:1')) {
          return Promise.reject(new Error('rpc down'));
        }
        return Promise.resolve(5n);
      },
    });
    expect(selection).toMatchObject({ chain: 'evm:31337', reason: 'funded' });
  });

  it('defaults to the first announced EVM chain with a rationale', async () => {
    const selection = await selectSettlementChain({
      announcedChains,
      evmAddress: '0x' + '11'.repeat(20),
      resolveSettlement,
      probeBalance: () => Promise.resolve(0n),
    });
    expect(selection).toMatchObject({ chain: 'evm:31337', reason: 'default' });
    expect(selection.detail).toContain('first EVM chain');
  });

  it('defaults to the first announced chain when no EVM chain exists', async () => {
    const selection = await selectSettlementChain({
      announcedChains: ['solana:devnet', 'mina:devnet'],
      resolveSettlement,
    });
    expect(selection).toMatchObject({
      chain: 'solana:devnet',
      reason: 'default',
    });
  });

  it('throws when nothing is announced and nothing is explicit', async () => {
    await expect(
      selectSettlementChain({ announcedChains: [], resolveSettlement })
    ).rejects.toThrow(/no settlement chains/);
  });
});

// ---------------------------------------------------------------------------
// evmTokenBalance — raw eth_call probe
// ---------------------------------------------------------------------------

describe('evmTokenBalance', () => {
  it('encodes balanceOf(owner) and decodes the hex result', async () => {
    let captured: { url: string; body: string } | undefined;
    const balance = await evmTokenBalance({
      rpcUrl: 'http://rpc.example',
      tokenAddress: '0x' + 'aa'.repeat(20),
      owner: '0x' + 'BB'.repeat(20),
      fetchImpl: ((url: string, init: { body: string }) => {
        captured = { url, body: init.body };
        return Promise.resolve(
          new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x2710' }))
        );
      }) as unknown as typeof fetch,
    });
    expect(balance).toBe(10000n);
    const body = JSON.parse(captured?.body ?? '{}') as {
      method: string;
      params: [{ to: string; data: string }, string];
    };
    expect(body.method).toBe('eth_call');
    expect(body.params[0].to).toBe('0x' + 'aa'.repeat(20));
    expect(body.params[0].data).toBe('0x70a08231' + '00'.repeat(12) + 'bb'.repeat(20));
  });

  it('throws on RPC errors', async () => {
    await expect(
      evmTokenBalance({
        rpcUrl: 'http://rpc.example',
        tokenAddress: '0x' + 'aa'.repeat(20),
        owner: '0x' + 'bb'.repeat(20),
        fetchImpl: (() =>
          Promise.resolve(
            new Response(
              JSON.stringify({ error: { message: 'execution reverted' } })
            )
          )) as unknown as typeof fetch,
      })
    ).rejects.toThrow(/execution reverted/);
  });
});

// ---------------------------------------------------------------------------
// Genesis seed (core 2.x)
// ---------------------------------------------------------------------------

describe('genesis seed (core 2.x)', () => {
  it('ships a non-empty, schema-valid seed (the #260 empty-seed regression)', () => {
    const seed = loadGenesisSeed();
    expect(seed).toBeDefined();
    expect(seed?.pubkey).toMatch(/^[0-9a-f]{64}$/);
    expect(seed?.ilpAddress).toMatch(/^g\./);
    expect(seed?.btpEndpoint).toMatch(/^wss?:\/\//);
    expect(seed?.relayUrl).toMatch(/^wss?:\/\//);
    expect(genesisSeedPubkeys()).toContain(seed?.pubkey);
  });
});
