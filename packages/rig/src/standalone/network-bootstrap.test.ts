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
  SolanaChannelUnderivableError,
  TokenNetworkUnderivableError,
  discoverAnnouncedPeers,
  evmPresetForChain,
  evmTokenBalance,
  genesisSeedPubkeys,
  loadGenesisSeed,
  pickPaymentPeer,
  resolveChainSettlement,
  selectSettlementChain,
  solanaPresetForChain,
  solanaTokenBalance,
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

  it('parses the out-of-band capabilities (route prices), skipping malformed entries', async () => {
    await withMockRelay(
      [
        announceEvent(APEX_PUBKEY, {
          ...APEX_CONTENT,
          capabilities: [
            { capability: 'os.publish', address: 'g.proxy.relay', price: '1000' },
            { capability: 'os.store', address: 'g.proxy.store', price: '1000' },
            // Malformed entries are skipped, not fatal:
            { capability: 'os.bad', address: 'g.proxy.bad', price: '-5' },
            { capability: 'os.bad2', address: '', price: '1' },
            { capability: 'os.bad3', address: 'g.proxy.bad3', price: 12 },
            'not an object',
          ],
        }),
      ],
      async (relayUrl) => {
        const peers = await discoverAnnouncedPeers(relayUrl, {
          timeoutMs: 2000,
        });
        expect(peers).toHaveLength(1);
        expect((peers[0] as AnnouncedPeer).capabilities).toEqual([
          { capability: 'os.publish', address: 'g.proxy.relay', price: '1000' },
          { capability: 'os.store', address: 'g.proxy.store', price: '1000' },
        ]);
      }
    );
  });

  it('announces without capabilities parse with the field absent', async () => {
    await withMockRelay(
      [announceEvent(APEX_PUBKEY, APEX_CONTENT)],
      async (relayUrl) => {
        const peers = await discoverAnnouncedPeers(relayUrl, {
          timeoutMs: 2000,
        });
        expect((peers[0] as AnnouncedPeer).capabilities).toBeUndefined();
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
// resolveChainSettlement — explicit > announce > core preset
// ---------------------------------------------------------------------------

describe('resolveChainSettlement', () => {
  const apex = announcedPeer(APEX_PUBKEY, APEX_CONTENT);

  it('derives evm:31337 fully from the core preset (no explicit config)', () => {
    const s = resolveChainSettlement('evm:31337', {}, apex);
    expect(s.family).toBe('evm');
    // RPC + TokenNetwork/token: core's deterministic anvil (31337) preset —
    // the announcing peer's zone no longer matters (the devnet's self-hosted
    // chain boxes are retired; explicit config/announce still win per field).
    const preset = evmPresetForChain('evm:31337');
    expect(preset).toBeDefined();
    expect(s.rpcUrl).toBe(preset?.rpcUrl);
    expect(s.tokenNetwork).toBe(preset?.tokenNetworkAddress);
    expect(s.tokenAddress).toBe(preset?.usdcAddress);
  });

  it('evm:84532 uses the CURRENT public Base Sepolia addresses, not the stale core preset', () => {
    // The core `base-sepolia` preset carries the retired e2e deployment (an
    // 18-decimal mock USDC `0xac806…`); the current public token is 6-decimal
    // at `0x49beE1…`. A bare fallback (announce omits the fields) must resolve
    // the current addresses so balance/settle target the right contracts.
    const preset = evmPresetForChain('evm:base:84532');
    expect(preset?.rpcUrl).toBe('https://sepolia.base.org');
    expect(preset?.usdcAddress).toBe('0x49beE1Bca5d15Fb0963117923403F9498119a9Ce');
    expect(preset?.tokenNetworkAddress).toBe('0x1E95493fEF46707E034b4a1945f25a8C76A1823D');
    // And the stale 18-decimal token must NOT leak through.
    expect(preset?.usdcAddress).not.toBe('0xac80670b86db1eeb5c18c82e18a6bda98fcb4504');

    // Full resolution with no explicit config + a bare announce falls back to it.
    const s = resolveChainSettlement('evm:base:84532', {}, apex);
    expect(s.tokenAddress).toBe('0x49beE1Bca5d15Fb0963117923403F9498119a9Ce');
    expect(s.tokenNetwork).toBe('0x1E95493fEF46707E034b4a1945f25a8C76A1823D');
  });

  it('matches core presets by EVM chain id for qualified spellings (#384)', () => {
    // The announce chain-key format is `evm:{network}:{chainId}` — the same
    // chain arrives spelled `evm:31337` OR `evm:anvil:31337`. An exact-key
    // miss must not leave the announced EVM chain without an RPC (else
    // zero-config negotiation cannot balance-probe it and falls through).
    const qualified = announcedPeer(APEX_PUBKEY, {
      ...APEX_CONTENT,
      supportedChains: ['evm:anvil:31337', 'solana:devnet'],
    });
    const s = resolveChainSettlement('evm:anvil:31337', {}, qualified);
    const preset = evmPresetForChain('evm:anvil:31337');
    expect(preset).toBeDefined();
    expect(s.rpcUrl).toBe(preset?.rpcUrl);
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

  it('resolves identically for a local-stack peer (no zone special-casing)', () => {
    const local = announcedPeer(APEX_PUBKEY, {
      ...APEX_CONTENT,
      httpEndpoint: 'http://localhost:8080/ilp',
      btpEndpoint: 'ws://localhost:3000',
      relayUrl: 'ws://localhost:7100',
    });
    const s = resolveChainSettlement('evm:31337', {}, local);
    // The anvil preset's localhost RPC — right for a local stack.
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

  it('derives EVM mainnet (Base 8453) RPC + Circle USDC from the preset', () => {
    // TOON TokenNetwork is not deployed on Base mainnet — RPC and token come
    // from the core preset, the TokenNetwork ONLY from announce/config.
    for (const chain of ['evm:8453', 'evm:base:8453']) {
      const s = resolveChainSettlement(chain, {}, apex);
      expect(s.rpcUrl).toBe('https://mainnet.base.org');
      expect(s.tokenAddress).toBe(
        '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
      );
      expect(s.tokenNetwork).toBeUndefined();
    }
    const announced = announcedPeer(APEX_PUBKEY, {
      ...APEX_CONTENT,
      tokenNetworks: { 'evm:base:8453': '0xMAINNETTN' },
    });
    const s = resolveChainSettlement('evm:base:8453', {}, announced);
    expect(s.tokenNetwork).toBe('0xMAINNETTN');
  });
});

// ---------------------------------------------------------------------------
// resolveChainSettlement — Solana
// ---------------------------------------------------------------------------

describe('resolveChainSettlement — solana', () => {
  const apex = announcedPeer(APEX_PUBKEY, APEX_CONTENT); // devnet-zone peer
  /** A peer OUTSIDE the devnet zone (local stack / public network). */
  const publicPeer = announcedPeer(APEX_PUBKEY, {
    ...APEX_CONTENT,
    httpEndpoint: 'https://proxy.example.com/ilp',
    btpEndpoint: 'wss://proxy.example.com:443',
    relayUrl: 'wss://relay.example.com',
  });

  it('solanaPresetForChain covers the public clusters from core presets', () => {
    // Public devnet: the deployed TOON program + mint.
    const devnet = solanaPresetForChain('solana:devnet');
    expect(devnet?.rpcUrl).toBe('https://api.devnet.solana.com');
    expect(devnet?.programId).toBeTruthy();
    expect(devnet?.tokenMint).toBeTruthy();
    // Mainnet-beta: RPC + Circle USDC mint; program not deployed yet.
    const mainnet = solanaPresetForChain('solana:mainnet-beta');
    expect(mainnet?.rpcUrl).toBe('https://api.mainnet-beta.solana.com');
    expect(mainnet?.tokenMint).toBe(
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
    );
    expect(mainnet?.programId).toBeUndefined();
    // No TOON deployment on Solana's testnet cluster; unknown clusters and
    // non-solana chains resolve to nothing.
    expect(solanaPresetForChain('solana:testnet')).toBeUndefined();
    expect(solanaPresetForChain('solana:localnet')).toBeUndefined();
    expect(solanaPresetForChain('evm:31337')).toBeUndefined();
  });

  it('public-cluster peer: full derivation from the core preset', () => {
    const s = resolveChainSettlement('solana:devnet', {}, publicPeer);
    expect(s.family).toBe('solana');
    const preset = solanaPresetForChain('solana:devnet');
    expect(s.rpcUrl).toBe(preset?.rpcUrl);
    expect(s.tokenAddress).toBe(preset?.tokenMint);
    expect(s.programId).toBe(preset?.programId);
    expect(s.tokenNetwork).toBeUndefined();
  });

  it('devnet-zone peer: the public-cluster preset applies (self-hosted chains retired)', () => {
    // The relay/proxy/store stay under `*.devnet.toonprotocol.dev`, but the
    // zone's self-hosted chain nodes are retired (2026-07): `solana:devnet`
    // IS the public cluster now, so the core preset must apply even when the
    // announcing peer lives under the devnet zone — the former zone guard
    // (zone RPC + preset suppression) would strand rig on a dead RPC.
    const s = resolveChainSettlement('solana:devnet', {}, apex);
    const preset = solanaPresetForChain('solana:devnet');
    expect(s.rpcUrl).toBe('https://api.devnet.solana.com');
    expect(s.programId).toBe(preset?.programId);
    expect(s.tokenAddress).toBe(preset?.tokenMint);
  });

  it('an explicit RPC wins while the preset fills the remaining gaps', () => {
    // Discovery skipped/failed (announce undefined) with an explicit RPC:
    // the RPC is honored verbatim, program/mint still derive per field.
    const s = resolveChainSettlement(
      'solana:devnet',
      {
        chainRpcUrls: { 'solana:devnet': 'http://explicit:8899' },
      },
      undefined
    );
    expect(s.rpcUrl).toBe('http://explicit:8899');
    const preset = solanaPresetForChain('solana:devnet');
    expect(s.programId).toBe(preset?.programId);
    expect(s.tokenAddress).toBe(preset?.tokenMint);
  });

  it('announce tokenNetworks/preferredTokens beat the preset program id + mint', () => {
    const announced = announcedPeer(APEX_PUBKEY, {
      ...APEX_CONTENT,
      tokenNetworks: { 'solana:devnet': 'ProgramAnnounced11111' },
      preferredTokens: { 'solana:devnet': 'MintAnnounced1111111' },
    });
    const s = resolveChainSettlement('solana:devnet', {}, announced);
    expect(s.programId).toBe('ProgramAnnounced11111');
    expect(s.tokenAddress).toBe('MintAnnounced1111111');
    expect(s.rpcUrl).toBe('https://api.devnet.solana.com');
  });

  it('explicit config beats announce and presets', () => {
    const announced = announcedPeer(APEX_PUBKEY, {
      ...APEX_CONTENT,
      tokenNetworks: { 'solana:devnet': 'ProgramAnnounced11111' },
      preferredTokens: { 'solana:devnet': 'MintAnnounced1111111' },
    });
    const s = resolveChainSettlement(
      'solana:devnet',
      {
        tokenNetworks: { 'solana:devnet': 'ProgramExplicit111111' },
        preferredTokens: { 'solana:devnet': 'MintExplicit11111111' },
        chainRpcUrls: { 'solana:devnet': 'http://explicit:8899' },
      },
      announced
    );
    expect(s.programId).toBe('ProgramExplicit111111');
    expect(s.tokenAddress).toBe('MintExplicit11111111');
    expect(s.rpcUrl).toBe('http://explicit:8899');
  });

  it('mainnet-beta with an announced program id is settlement-complete', () => {
    const announced = announcedPeer(APEX_PUBKEY, {
      ...APEX_CONTENT,
      supportedChains: ['solana:mainnet-beta'],
      httpEndpoint: 'https://proxy.example.com/ilp',
      btpEndpoint: 'wss://proxy.example.com:443',
      relayUrl: 'wss://relay.example.com',
      tokenNetworks: { 'solana:mainnet-beta': 'ProgramMainnet111111' },
    });
    const s = resolveChainSettlement('solana:mainnet-beta', {}, announced);
    expect(s.programId).toBe('ProgramMainnet111111');
    expect(s.rpcUrl).toBe('https://api.mainnet-beta.solana.com');
    expect(s.tokenAddress).toBe(
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
    );
  });

  it('SolanaChannelUnderivableError names the missing pieces and remedies', () => {
    const err = new SolanaChannelUnderivableError(
      'solana:devnet',
      ['programId', 'tokenMint'],
      apex,
      'wss://relay.example'
    );
    expect(err.message).toContain('solana:devnet');
    expect(err.message).toContain('programId, tokenMint');
    expect(err.message).toContain(APEX_PUBKEY.slice(0, 16));
    expect(err.message).toContain('solanaChannel');
    expect(err.message).toContain('tokenNetworks["solana:devnet"]');
    const errNoAnnounce = new SolanaChannelUnderivableError(
      'solana:mainnet-beta',
      ['programId'],
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

  it('aligns an explicit EVM chain id to the announced spelling (negotiation is exact-string)', async () => {
    // `evm:base:31337` pins the SAME chain the peer announces as `evm:31337`
    // — passing the configured spelling through verbatim would strand the
    // pin at the embedded client's exact-string chain negotiation.
    const selection = await selectSettlementChain({
      explicitChain: 'evm:base:31337',
      announcedChains,
      resolveSettlement,
    });
    expect(selection).toMatchObject({ chain: 'evm:31337', reason: 'explicit' });
    expect(selection.detail).toContain('evm:base:31337');
    expect(selection.detail).toContain('announced spelling');
  });

  it('an explicitly announced spelling passes through verbatim', async () => {
    const selection = await selectSettlementChain({
      explicitChain: 'evm:31337',
      announcedChains,
      resolveSettlement,
    });
    expect(selection).toMatchObject({
      chain: 'evm:31337',
      reason: 'explicit',
      detail: 'chain evm:31337 set by config',
    });
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

  it('picks a funded Solana chain when EVM chains are unfunded', async () => {
    const selection = await selectSettlementChain({
      announcedChains: ['evm:31337', 'solana:devnet'],
      evmAddress: '0x' + '11'.repeat(20),
      solanaAddress: 'So1anaOwner1111111111111111111111111111111',
      resolveSettlement,
      probeBalance: () => Promise.resolve(0n),
      probeSolanaBalance: (args) => {
        expect(args.rpcUrl).toBe('http://rpc.example/solana:devnet');
        expect(args.tokenAddress).toBe('0xTOKEN');
        expect(args.owner).toBe('So1anaOwner1111111111111111111111111111111');
        return Promise.resolve(250n);
      },
    });
    expect(selection).toMatchObject({
      chain: 'solana:devnet',
      reason: 'funded',
    });
    expect(selection.detail).toContain('250');
  });

  it('announce order decides when both an EVM and a Solana chain are funded', async () => {
    const probeArgs = {
      evmAddress: '0x' + '11'.repeat(20),
      solanaAddress: 'So1anaOwner1111111111111111111111111111111',
      resolveSettlement,
      probeBalance: () => Promise.resolve(7n),
      probeSolanaBalance: () => Promise.resolve(9n),
    };
    const solanaFirst = await selectSettlementChain({
      announcedChains: ['solana:devnet', 'evm:31337'],
      ...probeArgs,
    });
    expect(solanaFirst).toMatchObject({
      chain: 'solana:devnet',
      reason: 'funded',
    });
    const evmFirst = await selectSettlementChain({
      announcedChains: ['evm:31337', 'solana:devnet'],
      ...probeArgs,
    });
    expect(evmFirst).toMatchObject({ chain: 'evm:31337', reason: 'funded' });
  });

  it('Solana probe errors skip the candidate instead of failing selection', async () => {
    const selection = await selectSettlementChain({
      announcedChains: ['solana:devnet', 'evm:31337'],
      evmAddress: '0x' + '11'.repeat(20),
      solanaAddress: 'So1anaOwner1111111111111111111111111111111',
      resolveSettlement,
      probeBalance: () => Promise.resolve(0n),
      probeSolanaBalance: () => Promise.reject(new Error('rpc down')),
    });
    expect(selection).toMatchObject({ chain: 'evm:31337', reason: 'default' });
  });

  it('does not probe Solana chains without a solanaAddress', async () => {
    let solanaProbed = 0;
    const selection = await selectSettlementChain({
      announcedChains: ['solana:devnet', 'evm:31337'],
      evmAddress: '0x' + '11'.repeat(20),
      resolveSettlement,
      probeBalance: () => Promise.resolve(3n),
      probeSolanaBalance: () => {
        solanaProbed += 1;
        return Promise.resolve(999n);
      },
    });
    expect(solanaProbed).toBe(0);
    expect(selection).toMatchObject({ chain: 'evm:31337', reason: 'funded' });
  });

  it('skips a Solana candidate whose settlement lacks RPC or mint', async () => {
    const selection = await selectSettlementChain({
      announcedChains: ['solana:devnet', 'evm:31337'],
      evmAddress: '0x' + '11'.repeat(20),
      solanaAddress: 'So1anaOwner1111111111111111111111111111111',
      resolveSettlement: (chain) => ({
        chain,
        family: chain.split(':')[0] as string,
        // No rpcUrl/tokenAddress for solana — the mint is underivable.
        ...(chain.startsWith('evm:')
          ? { rpcUrl: `http://rpc.example/${chain}`, tokenAddress: '0xTOKEN' }
          : {}),
      }),
      probeBalance: () => Promise.resolve(4n),
      probeSolanaBalance: () => Promise.resolve(999n),
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

  it('devnet zero-config: probes the announced public chains via core presets', async () => {
    // A bare mnemonic against the devnet: the announce carries no
    // chainRpcUrls, and the zone's self-hosted chain boxes are retired —
    // every announced public chain must resolve a reachable preset RPC so
    // the funded probe can reach it (announce order preserved).
    const apex = announcedPeer(APEX_PUBKEY, {
      ...APEX_CONTENT,
      supportedChains: ['solana:devnet', 'evm:base:84532'],
    });
    const probed: string[] = [];
    const selection = await selectSettlementChain({
      announcedChains: ['solana:devnet', 'evm:base:84532'],
      evmAddress: '0x' + '11'.repeat(20),
      solanaAddress: 'So1anaOwner1111111111111111111111111111111',
      resolveSettlement: (chain) => resolveChainSettlement(chain, {}, apex),
      probeBalance: (args) => {
        probed.push(args.rpcUrl);
        return Promise.resolve(10000n);
      },
      // solana:devnet resolves the public preset (RPC + mint) even though
      // the announce comes from a `*.devnet.toonprotocol.dev` peer.
      probeSolanaBalance: (args) => {
        probed.push(args.rpcUrl);
        return Promise.resolve(0n);
      },
    });
    expect(selection).toMatchObject({
      chain: 'evm:base:84532',
      reason: 'funded',
    });
    expect(probed).toEqual([
      'https://api.devnet.solana.com',
      'https://sepolia.base.org',
    ]);
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
// solanaTokenBalance — raw getTokenAccountsByOwner probe
// ---------------------------------------------------------------------------

describe('solanaTokenBalance', () => {
  const OWNER = 'A3FG5y6rfBNJQrsGYTNNR7UHAXCREPJgV362LdTQGNwK';
  const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

  const tokenAccount = (amount: string) => ({
    account: { data: { parsed: { info: { tokenAmount: { amount } } } } },
  });

  it('requests the owner accounts for the mint and sums their amounts', async () => {
    let captured: { url: string; body: string } | undefined;
    const balance = await solanaTokenBalance({
      rpcUrl: 'http://rpc.example',
      tokenAddress: MINT,
      owner: OWNER,
      fetchImpl: ((url: string, init: { body: string }) => {
        captured = { url, body: init.body };
        return Promise.resolve(
          new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              result: { value: [tokenAccount('123'), tokenAccount('7')] },
            })
          )
        );
      }) as unknown as typeof fetch,
    });
    expect(balance).toBe(130n);
    expect(captured?.url).toBe('http://rpc.example');
    const body = JSON.parse(captured?.body ?? '{}') as {
      method: string;
      params: [string, { mint: string }, { encoding: string }];
    };
    expect(body.method).toBe('getTokenAccountsByOwner');
    expect(body.params[0]).toBe(OWNER);
    expect(body.params[1]).toEqual({ mint: MINT });
    expect(body.params[2]).toEqual({ encoding: 'jsonParsed' });
  });

  it('returns 0n when the owner has no token accounts for the mint', async () => {
    const balance = await solanaTokenBalance({
      rpcUrl: 'http://rpc.example',
      tokenAddress: MINT,
      owner: OWNER,
      fetchImpl: (() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ jsonrpc: '2.0', id: 1, result: { value: [] } })
          )
        )) as unknown as typeof fetch,
    });
    expect(balance).toBe(0n);
  });

  it('throws on RPC errors', async () => {
    await expect(
      solanaTokenBalance({
        rpcUrl: 'http://rpc.example',
        tokenAddress: MINT,
        owner: OWNER,
        fetchImpl: (() =>
          Promise.resolve(
            new Response(
              JSON.stringify({ error: { message: 'Invalid param: WrongSize' } })
            )
          )) as unknown as typeof fetch,
      })
    ).rejects.toThrow(/Invalid param: WrongSize/);
  });

  it('throws on HTTP failures', async () => {
    await expect(
      solanaTokenBalance({
        rpcUrl: 'http://rpc.example',
        tokenAddress: MINT,
        owner: OWNER,
        fetchImpl: (() =>
          Promise.resolve(
            new Response('rate limited', { status: 429 })
          )) as unknown as typeof fetch,
      })
    ).rejects.toThrow(/HTTP 429/);
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
