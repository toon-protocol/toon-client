/**
 * Tests for the #264 topology resolution in standalone mode:
 * `explicit config > live announce > genesis seed`, per field, plus the
 * tokenNetwork derivation and settlement-chain wiring.
 *
 * `resolveNetworkTopology` is pure (announce/genesis/records injected), so
 * the full matrix runs without any network or client start.
 */

import { describe, it, expect } from 'vitest';

import type { AnnouncedPeer } from '../standalone/network-bootstrap.js';
import {
  MissingUplinkError,
  resolveNetworkTopology,
  type ClientConfigFile,
  type GenesisSeedLike,
  type NetworkTopologyInputs,
} from './standalone-mode.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Standard BIP-39 test vector phrase (never holds real funds). */
const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const APEX_PUBKEY = 'a1'.repeat(32);
const RELAY = 'wss://relay-ws.devnet.toonprotocol.dev';

/** Live-devnet-shaped apex announce. */
function apexAnnounce(
  overrides: Partial<Record<string, unknown>> = {}
): AnnouncedPeer {
  const content = {
    ilpAddress: 'g.proxy.relay',
    btpEndpoint: 'wss://proxy.devnet.toonprotocol.dev:443',
    assetCode: 'USDC',
    assetScale: 6,
    httpEndpoint: 'https://proxy.devnet.toonprotocol.dev/ilp',
    relayUrl: RELAY,
    supportedChains: ['evm:31337', 'solana:devnet', 'mina:devnet'],
    settlementAddresses: {
      'evm:31337': '0xC0E55cD2E967a4F625627DaE5d4946f54267C7ab',
      'solana:devnet': 'A3FG5y6rfBNJQrsGYTNNR7UHAXCREPJgV362LdTQGNwK',
      'mina:devnet': 'B62qkEx3MsKtaEJqJMg8ZC2eXtz8FNpZy4huVpBnnUHVRUEf5f1vqdq',
    },
    ...overrides,
  };
  return {
    pubkey: APEX_PUBKEY,
    info: content as unknown as AnnouncedPeer['info'],
    routes: { publish: 'g.proxy.relay', store: 'g.proxy.store' },
    createdAt: 1000,
  };
}

const GENESIS: GenesisSeedLike = {
  pubkey: 'c3'.repeat(32),
  relayUrl: RELAY,
  ilpAddress: 'g.proxy',
  btpEndpoint: 'wss://proxy.devnet.toonprotocol.dev:443',
};

function inputs(
  overrides: Partial<NetworkTopologyInputs> & {
    file?: ClientConfigFile;
  } = {}
): NetworkTopologyInputs {
  return {
    env: {},
    file: {},
    configPath: '/tmp/test/config.json',
    relayUrl: RELAY,
    announce: apexAnnounce(),
    genesisSeed: GENESIS,
    identity: { mnemonic: MNEMONIC, accountIndex: 0, pubkey: 'd4'.repeat(32) },
    channelRecords: () => [],
    probeBalance: () => Promise.resolve(0n),
    warn: () => {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Uplink resolution order
// ---------------------------------------------------------------------------

describe('resolveNetworkTopology — uplink', () => {
  it('derives the proxy uplink from the announce httpEndpoint (no config)', async () => {
    const topology = await resolveNetworkTopology(inputs());
    expect(topology.proxyUrl).toBe('https://proxy.devnet.toonprotocol.dev');
    expect(topology.btpUrl).toBeUndefined();
  });

  it('explicit env proxy beats the announce', async () => {
    const topology = await resolveNetworkTopology(
      inputs({ env: { TOON_CLIENT_PROXY_URL: 'https://my-proxy.example' } })
    );
    expect(topology.proxyUrl).toBe('https://my-proxy.example');
  });

  it('explicit config-file btpUrl beats the announce', async () => {
    const topology = await resolveNetworkTopology(
      inputs({ file: { btpUrl: 'wss://my-btp.example:443' } })
    );
    expect(topology.btpUrl).toBe('wss://my-btp.example:443');
    expect(topology.proxyUrl).toBeUndefined();
  });

  it('announce btpEndpoint is used when it has no httpEndpoint', async () => {
    const topology = await resolveNetworkTopology(
      inputs({ announce: apexAnnounce({ httpEndpoint: undefined }) })
    );
    expect(topology.proxyUrl).toBeUndefined();
    expect(topology.btpUrl).toBe('wss://proxy.devnet.toonprotocol.dev:443');
  });

  it('falls back to the genesis seed btpEndpoint without an announce', async () => {
    const topology = await resolveNetworkTopology(
      inputs({ announce: undefined })
    );
    expect(topology.btpUrl).toBe(GENESIS.btpEndpoint);
  });

  it('throws MissingUplinkError when no source yields an uplink', async () => {
    await expect(
      resolveNetworkTopology(
        inputs({ announce: undefined, genesisSeed: undefined })
      )
    ).rejects.toThrow(MissingUplinkError);
  });
});

// ---------------------------------------------------------------------------
// Destination anchor + routes
// ---------------------------------------------------------------------------

describe('resolveNetworkTopology — destination and routes', () => {
  it('anchors at the announce ilpAddress with announce routes', async () => {
    const topology = await resolveNetworkTopology(inputs());
    expect(topology.destination).toBe('g.proxy.relay');
    expect(topology.publishDestination).toBe('g.proxy.relay');
    expect(topology.storeDestination).toBe('g.proxy.store');
  });

  it('explicit destination + routes beat the announce', async () => {
    const topology = await resolveNetworkTopology(
      inputs({
        env: {
          TOON_CLIENT_DESTINATION: 'g.proxy.relay.store',
          TOON_CLIENT_PUBLISH_DESTINATION: 'g.mine.relay',
          TOON_CLIENT_STORE_DESTINATION: 'g.mine.store',
        },
      })
    );
    expect(topology.destination).toBe('g.proxy.relay.store');
    expect(topology.publishDestination).toBe('g.mine.relay');
    expect(topology.storeDestination).toBe('g.mine.store');
  });

  it('explicit destination keeps announce routes for unset route fields', async () => {
    const topology = await resolveNetworkTopology(
      inputs({ env: { TOON_CLIENT_DESTINATION: 'g.proxy.relay.store' } })
    );
    expect(topology.destination).toBe('g.proxy.relay.store');
    expect(topology.publishDestination).toBe('g.proxy.relay');
    expect(topology.storeDestination).toBe('g.proxy.store');
  });

  it('falls back to the genesis ilpAddress without an announce (no routes)', async () => {
    const topology = await resolveNetworkTopology(
      inputs({ announce: undefined })
    );
    expect(topology.destination).toBe('g.proxy');
    // No routes derivable — the publisher's anchor convention takes over.
    expect(topology.publishDestination).toBeUndefined();
    expect(topology.storeDestination).toBeUndefined();
  });

  it('bootstraps the client against the announced peer, else the seed', async () => {
    const withAnnounce = await resolveNetworkTopology(inputs());
    expect(withAnnounce.knownPeers).toEqual([
      {
        pubkey: APEX_PUBKEY,
        relayUrl: RELAY,
        btpEndpoint: 'wss://proxy.devnet.toonprotocol.dev:443',
      },
    ]);
    const seedOnly = await resolveNetworkTopology(
      inputs({ announce: undefined })
    );
    expect(seedOnly.knownPeers).toEqual([
      {
        pubkey: GENESIS.pubkey,
        relayUrl: GENESIS.relayUrl,
        btpEndpoint: GENESIS.btpEndpoint,
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Settlement chain + tokenNetwork derivation
// ---------------------------------------------------------------------------

describe('resolveNetworkTopology — settlement', () => {
  it('selects the first announced EVM chain and derives its full settlement', async () => {
    const warnings: string[] = [];
    const topology = await resolveNetworkTopology(
      inputs({ warn: (line) => warnings.push(line) })
    );
    expect(topology.selection).toMatchObject({
      chain: 'evm:31337',
      reason: 'default',
    });
    expect(topology.supportedChains).toEqual(['evm:31337']);
    // Deterministic anvil contracts (core preset) + devnet-zone RPC.
    expect(topology.tokenNetworks?.['evm:31337']).toMatch(/^0x/);
    expect(topology.preferredTokens?.['evm:31337']).toMatch(/^0x/);
    expect(topology.chainRpcUrls?.['evm:31337']).toBe(
      'https://evm-rpc.devnet.toonprotocol.dev'
    );
    expect(warnings.some((w) => w.includes('settlement chain evm:31337'))).toBe(
      true
    );
  });

  it('prefers the funded chain (balance probe)', async () => {
    const topology = await resolveNetworkTopology(
      inputs({ probeBalance: () => Promise.resolve(12345n) })
    );
    expect(topology.selection).toMatchObject({
      chain: 'evm:31337',
      reason: 'funded',
    });
  });

  it('prefers a live persisted channel chain (#262 map)', async () => {
    const topology = await resolveNetworkTopology(
      inputs({
        channelRecords: () => [
          {
            chain: 'solana:devnet',
            lastUsedAt: '2026-07-01T00:00:00Z',
            closed: false,
          },
        ],
      })
    );
    expect(topology.selection).toMatchObject({
      chain: 'solana:devnet',
      reason: 'persisted-channel',
    });
    expect(topology.supportedChains).toEqual(['solana:devnet']);
  });

  it('honors TOON_CLIENT_CHAIN as an explicit family pick', async () => {
    const topology = await resolveNetworkTopology(
      inputs({ env: { TOON_CLIENT_CHAIN: 'evm' } })
    );
    expect(topology.selection).toMatchObject({
      chain: 'evm:31337',
      reason: 'explicit',
    });
  });

  it('passes an explicit supportedChains list through unchanged, filling gaps', async () => {
    const topology = await resolveNetworkTopology(
      inputs({
        file: {
          supportedChains: ['solana:devnet', 'evm:31337'],
          tokenNetworks: { 'evm:31337': '0xEXPLICIT' },
        },
      })
    );
    expect(topology.supportedChains).toEqual(['solana:devnet', 'evm:31337']);
    expect(topology.selection).toMatchObject({ reason: 'explicit' });
    // Explicit tokenNetwork kept; token/RPC gaps filled by derivation.
    expect(topology.tokenNetworks?.['evm:31337']).toBe('0xEXPLICIT');
    expect(topology.preferredTokens?.['evm:31337']).toMatch(/^0x/);
    expect(topology.chainRpcUrls?.['evm:31337']).toBe(
      'https://evm-rpc.devnet.toonprotocol.dev'
    );
  });

  it('fails fast on an underivable EVM chain in an explicit supportedChains list', async () => {
    // Explicit config naming a custom EVM chain that no source (config map,
    // announce, core preset) can derive a TokenNetwork for must throw the
    // same actionable error as the announce-driven path — not sail through
    // and die later inside the embedded client.
    await expect(
      resolveNetworkTopology(
        inputs({
          file: { supportedChains: ['evm:999999'] },
        })
      )
    ).rejects.toThrow(/TokenNetwork.*evm:999999/s);
  });

  it('fails fast on a missing RPC URL for an explicit EVM chain', async () => {
    await expect(
      resolveNetworkTopology(
        inputs({
          file: {
            supportedChains: ['evm:999999'],
            tokenNetworks: { 'evm:999999': '0xEXPLICIT' },
          },
        })
      )
    ).rejects.toThrow(/RPC URL.*evm:999999/s);
  });

  it('throws the clear tokenNetwork error for an underivable EVM chain', async () => {
    await expect(
      resolveNetworkTopology(
        inputs({
          announce: apexAnnounce({
            supportedChains: ['evm:999999'],
            settlementAddresses: { 'evm:999999': '0xPEER' },
          }),
        })
      )
    ).rejects.toThrow(/TokenNetwork.*evm:999999/s);
  });

  it('warns instead of selecting when nothing is announced or configured', async () => {
    const warnings: string[] = [];
    const topology = await resolveNetworkTopology(
      inputs({
        announce: undefined,
        warn: (line) => warnings.push(line),
      })
    );
    expect(topology.selection).toBeUndefined();
    expect(topology.supportedChains).toBeUndefined();
    expect(
      warnings.some((w) => w.includes('no settlement chains'))
    ).toBe(true);
  });

  it('ignores the network preset for settlement (#260) with a warning', async () => {
    const warnings: string[] = [];
    const topology = await resolveNetworkTopology(
      inputs({
        file: { network: 'devnet' },
        warn: (line) => warnings.push(line),
      })
    );
    // The announce's chain wins — never the preset's Solana-first ordering.
    expect(topology.selection?.chain).toBe('evm:31337');
    expect(
      warnings.some((w) => w.includes('ignoring the "devnet" network preset'))
    ).toBe(true);
    // #280: user-facing warnings explain themselves in plain language — no
    // internal tracker numbers.
    expect(warnings.join('\n')).not.toMatch(/#\d+/);
  });
});
