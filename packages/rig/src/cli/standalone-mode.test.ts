/**
 * Tests for the #264 topology resolution in standalone mode:
 * `explicit config > live announce > genesis seed`, per field, plus the
 * tokenNetwork derivation and settlement-chain wiring.
 *
 * `resolveNetworkTopology` is pure (announce/genesis/records injected), so
 * the full matrix runs without any network or client start.
 */

import { describe, it, expect } from 'vitest';
import { deriveFullIdentity } from '@toon-protocol/client';

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
    probeSolanaBalance: () => Promise.resolve(0n),
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

  it('prefers a Solana chain funded for the identity-derived address', async () => {
    // A wallet funded ONLY on Solana settles there automatically: the EVM
    // probe finds nothing, the SPL probe (against the mnemonic's own derived
    // base58 address) does. The announce must carry the program id/mint —
    // the devnet-zone apex self-hosts its validator (no preset fallback).
    const probedOwners: string[] = [];
    const topology = await resolveNetworkTopology(
      inputs({
        announce: apexAnnounce({
          tokenNetworks: { 'solana:devnet': 'ProgramAnnounced11111' },
          preferredTokens: { 'solana:devnet': 'MintAnnounced1111111' },
        }),
        probeBalance: () => Promise.resolve(0n),
        probeSolanaBalance: (args) => {
          probedOwners.push(args.owner);
          expect(args.rpcUrl).toBe('https://solana-rpc.devnet.toonprotocol.dev');
          expect(args.tokenAddress).toBe('MintAnnounced1111111');
          return Promise.resolve(5000n);
        },
      })
    );
    expect(topology.selection).toMatchObject({
      chain: 'solana:devnet',
      reason: 'funded',
    });
    // The probed owner is the identity's own Solana address (the client's
    // SLIP-0010 m/44'/501'/{account}'/0' derivation from the mnemonic).
    const identity = await deriveFullIdentity(MNEMONIC, 0);
    expect(probedOwners).toEqual([identity.solana.publicKey]);
    expect(identity.solana.publicKey).not.toBe('');
    // The funded Solana pick is settlement-complete for the embedded client.
    expect(topology.supportedChains).toEqual(['solana:devnet']);
    expect(topology.solanaChannel).toEqual({
      rpcUrl: 'https://solana-rpc.devnet.toonprotocol.dev',
      programId: 'ProgramAnnounced11111',
      tokenMint: 'MintAnnounced1111111',
    });
  });

  it('falls back to the default EVM chain when the Solana probe errors', async () => {
    const topology = await resolveNetworkTopology(
      inputs({
        announce: apexAnnounce({
          tokenNetworks: { 'solana:devnet': 'ProgramAnnounced11111' },
          preferredTokens: { 'solana:devnet': 'MintAnnounced1111111' },
        }),
        probeBalance: () => Promise.resolve(0n),
        probeSolanaBalance: () => Promise.reject(new Error('rpc down')),
      })
    );
    expect(topology.selection).toMatchObject({
      chain: 'evm:31337',
      reason: 'default',
    });
  });

  it('prefers a live persisted channel chain (#262 map)', async () => {
    const topology = await resolveNetworkTopology(
      inputs({
        // The devnet-zone apex self-hosts its Solana validator, so the
        // program id/mint must ride the announce (no preset fallback).
        announce: apexAnnounce({
          tokenNetworks: { 'solana:devnet': 'ProgramAnnounced11111' },
          preferredTokens: { 'solana:devnet': 'MintAnnounced1111111' },
        }),
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
    // The selected Solana chain is settlement-complete: channel params
    // derived from the announce + the devnet-zone RPC table.
    expect(topology.solanaChannel).toEqual({
      rpcUrl: 'https://solana-rpc.devnet.toonprotocol.dev',
      programId: 'ProgramAnnounced11111',
      tokenMint: 'MintAnnounced1111111',
    });
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
          // A listed Solana chain must be settlement-complete; the explicit
          // channel object covers it.
          solanaChannel: {
            rpcUrl: 'https://solana-rpc.devnet.toonprotocol.dev',
            programId: 'ProgramExplicit111111',
          },
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
    // The explicit solanaChannel rides through buildPublisher verbatim — the
    // topology does not re-derive one.
    expect(topology.solanaChannel).toBeUndefined();
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

  it('drops a listed Solana chain with no derivable channel params (warned)', async () => {
    // The devnet-zone announce carries no solana program/mint and the zone's
    // validator is self-hosted (presets do not apply): a listed solana:devnet
    // without a solanaChannel config cannot be settled on, so it must not be
    // advertised to negotiation — negotiation landing there is guaranteed to
    // die later as the embedded client's "Solana channel config not
    // provided". The remaining chains keep working.
    const warnings: string[] = [];
    const topology = await resolveNetworkTopology(
      inputs({
        file: { supportedChains: ['evm:31337', 'solana:devnet'] },
        warn: (line) => warnings.push(line),
      })
    );
    expect(topology.supportedChains).toEqual(['evm:31337']);
    expect(topology.solanaChannel).toBeUndefined();
    const dropWarning = warnings.find((w) => w.includes('dropping'));
    expect(dropWarning).toContain('solana:devnet');
    expect(dropWarning).toContain('solanaChannel');
  });

  it('aligns a configured EVM spelling to the announced chain id (devnet config shape)', async () => {
    // The live-devnet failure shape: the shared daemon config lists
    // `evm:base:31337` while the apex announces `evm:31337` — negotiation
    // matches identifiers exactly, so the EVM chain was silently stranded
    // and negotiation fell through to solana:devnet (which standalone could
    // not open). The listed chain must be advertised under the ANNOUNCED
    // spelling, its explicit parameters carried over, and the chain-keyed
    // maps pruned to the advertised list (the client validates
    // chainRpcUrls keys ⊆ supportedChains).
    const warnings: string[] = [];
    const topology = await resolveNetworkTopology(
      inputs({
        file: {
          supportedChains: ['evm:base:31337', 'solana:devnet', 'mina:devnet'],
          tokenNetworks: {
            'evm:base:31337': '0xCafac3dD18aC6c6e92c921884f9E4176737C052c',
          },
          preferredTokens: {
            'evm:base:31337': '0x5FbDB2315678afecb367f032d93F642f64180aa3',
          },
          chainRpcUrls: {
            'evm:base:31337': 'https://evm-rpc.devnet.toonprotocol.dev',
            'solana:devnet': 'https://solana-rpc.devnet.toonprotocol.dev',
            'mina:devnet': 'https://mina.devnet.toonprotocol.dev/graphql',
          },
        },
        warn: (line) => warnings.push(line),
      })
    );
    // evm aligned to the announced spelling; underivable solana dropped;
    // mina passed through.
    expect(topology.supportedChains).toEqual(['evm:31337', 'mina:devnet']);
    expect(topology.selection?.chain).toBe('evm:31337');
    // Explicit parameters carried over under the announced spelling.
    expect(topology.tokenNetworks).toEqual({
      'evm:31337': '0xCafac3dD18aC6c6e92c921884f9E4176737C052c',
    });
    expect(topology.preferredTokens).toEqual({
      'evm:31337': '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    });
    expect(topology.chainRpcUrls).toEqual({
      'evm:31337': 'https://evm-rpc.devnet.toonprotocol.dev',
      'mina:devnet': 'https://mina.devnet.toonprotocol.dev/graphql',
    });
    expect(warnings.some((w) => w.includes('aligning'))).toBe(true);
  });

  it('fails fast when EVERY listed chain is an underivable Solana chain', async () => {
    await expect(
      resolveNetworkTopology(
        inputs({
          file: { supportedChains: ['solana:devnet'] },
        })
      )
    ).rejects.toThrow(/Solana channel parameters.*solana:devnet/s);
  });

  it('fails fast when the SELECTED chain is Solana with no derivable params', async () => {
    await expect(
      resolveNetworkTopology(
        inputs({
          channelRecords: () => [
            {
              chain: 'solana:devnet',
              lastUsedAt: '2026-07-01T00:00:00Z',
              closed: false,
            },
          ],
        })
      )
    ).rejects.toThrow(/Solana channel parameters.*solana:devnet/s);
  });

  it('derives solanaChannel for a listed Solana chain from the announce', async () => {
    const topology = await resolveNetworkTopology(
      inputs({
        announce: apexAnnounce({
          tokenNetworks: { 'solana:devnet': 'ProgramAnnounced11111' },
          preferredTokens: { 'solana:devnet': 'MintAnnounced1111111' },
        }),
        file: { supportedChains: ['solana:devnet'] },
      })
    );
    expect(topology.solanaChannel).toEqual({
      rpcUrl: 'https://solana-rpc.devnet.toonprotocol.dev',
      programId: 'ProgramAnnounced11111',
      tokenMint: 'MintAnnounced1111111',
    });
    // The mint also fills the chain-keyed token map (negotiation fallback).
    expect(topology.preferredTokens?.['solana:devnet']).toBe(
      'MintAnnounced1111111'
    );
  });

  it('supports Solana mainnet-beta once the program id is known', async () => {
    // A non-devnet-zone peer announcing mainnet-beta with its program id:
    // RPC + Circle USDC mint come from the core preset, the program from the
    // announce — settlement-complete without any local config.
    const mainnetAnnounce = apexAnnounce({
      httpEndpoint: 'https://proxy.example.com/ilp',
      btpEndpoint: 'wss://proxy.example.com:443',
      relayUrl: 'wss://relay.example.com',
      supportedChains: ['solana:mainnet-beta'],
      settlementAddresses: {
        'solana:mainnet-beta': 'A3FG5y6rfBNJQrsGYTNNR7UHAXCREPJgV362LdTQGNwK',
      },
      tokenNetworks: { 'solana:mainnet-beta': 'ProgramMainnet111111' },
    });
    const topology = await resolveNetworkTopology(
      inputs({ announce: mainnetAnnounce })
    );
    expect(topology.selection?.chain).toBe('solana:mainnet-beta');
    expect(topology.solanaChannel).toEqual({
      rpcUrl: 'https://api.mainnet-beta.solana.com',
      programId: 'ProgramMainnet111111',
      tokenMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    });
  });

  it('fails fast on Solana mainnet-beta without a program id, naming it', async () => {
    const mainnetAnnounce = apexAnnounce({
      httpEndpoint: 'https://proxy.example.com/ilp',
      btpEndpoint: 'wss://proxy.example.com:443',
      relayUrl: 'wss://relay.example.com',
      supportedChains: ['solana:mainnet-beta'],
      settlementAddresses: {
        'solana:mainnet-beta': 'A3FG5y6rfBNJQrsGYTNNR7UHAXCREPJgV362LdTQGNwK',
      },
    });
    await expect(
      resolveNetworkTopology(inputs({ announce: mainnetAnnounce }))
    ).rejects.toThrow(/solana:mainnet-beta.*missing: programId/s);
  });

  it('supports EVM mainnet (Base 8453) when the announce carries its TokenNetwork', async () => {
    const mainnetAnnounce = apexAnnounce({
      httpEndpoint: 'https://proxy.example.com/ilp',
      btpEndpoint: 'wss://proxy.example.com:443',
      relayUrl: 'wss://relay.example.com',
      supportedChains: ['evm:base:8453'],
      settlementAddresses: {
        'evm:base:8453': '0xC0E55cD2E967a4F625627DaE5d4946f54267C7ab',
      },
      tokenNetworks: { 'evm:base:8453': '0xMAINNETTN' },
    });
    const topology = await resolveNetworkTopology(
      inputs({ announce: mainnetAnnounce })
    );
    expect(topology.selection?.chain).toBe('evm:base:8453');
    expect(topology.tokenNetworks?.['evm:base:8453']).toBe('0xMAINNETTN');
    // RPC + Circle USDC from the core base-mainnet preset (chain-id match).
    expect(topology.chainRpcUrls?.['evm:base:8453']).toBe(
      'https://mainnet.base.org'
    );
    expect(topology.preferredTokens?.['evm:base:8453']).toBe(
      '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
    );
    expect(topology.solanaChannel).toBeUndefined();
  });

  it('fails fast on EVM mainnet without an announced TokenNetwork', async () => {
    // TOON's TokenNetwork is not deployed on Base mainnet, so the preset
    // cannot fill it — only the announce or explicit config can.
    const mainnetAnnounce = apexAnnounce({
      httpEndpoint: 'https://proxy.example.com/ilp',
      btpEndpoint: 'wss://proxy.example.com:443',
      relayUrl: 'wss://relay.example.com',
      supportedChains: ['evm:base:8453'],
      settlementAddresses: {
        'evm:base:8453': '0xC0E55cD2E967a4F625627DaE5d4946f54267C7ab',
      },
    });
    await expect(
      resolveNetworkTopology(inputs({ announce: mainnetAnnounce }))
    ).rejects.toThrow(/TokenNetwork.*evm:base:8453/s);
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
