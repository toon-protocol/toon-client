import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveConfig, resolveMnemonic, readConfigFile } from './config.js';

const MNEMONIC = 'test test test test test test test test test test test junk';

const ENV_KEYS = [
  'TOON_CLIENT_MNEMONIC',
  'TOON_CLIENT_BTP_URL',
  'TOON_CLIENT_PROXY_URL',
  'TOON_CLIENT_FAUCET_URL',
  'TOON_CLIENT_FAUCET_TIMEOUT_MS',
  'TOON_CLIENT_RELAY_URL',
  'TOON_CLIENT_HTTP_PORT',
  'TOON_CLIENT_NETWORK',
  'TOON_CLIENT_CHAIN',
  'TOON_CLIENT_DESTINATION',
  'TOON_CLIENT_PUBLISH_DESTINATION',
  'TOON_CLIENT_STORE_DESTINATION',
  'TOON_CLIENT_KEYSTORE_PASSWORD',
  'TOON_CLIENT_ARWEAVE_GATEWAYS',
];

describe('daemon config', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      Reflect.deleteProperty(process.env, k);
    }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) Reflect.deleteProperty(process.env, k);
      else process.env[k] = saved[k];
    }
  });

  it('resolveMnemonic prefers env over the config file', () => {
    process.env['TOON_CLIENT_MNEMONIC'] = MNEMONIC;
    expect(resolveMnemonic({ mnemonic: 'other words here' })).toBe(MNEMONIC);
  });

  it('resolveMnemonic falls back to the config file mnemonic', () => {
    expect(resolveMnemonic({ mnemonic: MNEMONIC })).toBe(MNEMONIC);
  });

  it('resolveMnemonic throws when nothing is configured', () => {
    expect(() => resolveMnemonic({})).toThrow(/No mnemonic/);
  });

  it('resolveMnemonic requires a password when keystorePath is set', () => {
    expect(() => resolveMnemonic({ keystorePath: '/tmp/x.json' })).toThrow(
      /KEYSTORE_PASSWORD/
    );
  });

  it('readConfigFile returns {} when the file is absent', () => {
    expect(readConfigFile('/nonexistent/toon-client/config.json')).toEqual({});
  });

  it('resolves read-only (no uplink) with hasUplink=false — reads need none (#69)', () => {
    const cfg = resolveConfig({ mnemonic: MNEMONIC });
    expect(cfg.hasUplink).toBe(false);
    // A read-only daemon still builds a usable ToonClientConfig (relay reads),
    // with a dummy connectorUrl satisfying validateConfig (no proxy/BTP).
    expect(cfg.toonClientConfig.btpUrl).toBeUndefined();
    expect(cfg.proxyUrl).toBeUndefined();
    expect(cfg.apex).toBeUndefined();
  });

  it('arweaveGateways defaults to the shared ar.io-first list', () => {
    const cfg = resolveConfig({ mnemonic: MNEMONIC });
    expect(cfg.arweaveGateways).toEqual([
      'https://ar-io.dev',
      'https://arweave.net',
      'https://permagate.io',
    ]);
  });

  it('TOON_CLIENT_ARWEAVE_GATEWAYS env overrides (comma-split, trimmed)', () => {
    process.env['TOON_CLIENT_ARWEAVE_GATEWAYS'] =
      ' https://my.gw , https://backup.gw ';
    const cfg = resolveConfig({
      mnemonic: MNEMONIC,
      arweaveGateways: ['https://ignored.gw'],
    });
    expect(cfg.arweaveGateways).toEqual(['https://my.gw', 'https://backup.gw']);
  });

  it('falls back to the config-file arweaveGateways when no env is set', () => {
    const cfg = resolveConfig({
      mnemonic: MNEMONIC,
      arweaveGateways: ['https://file.gw'],
    });
    expect(cfg.arweaveGateways).toEqual(['https://file.gw']);
  });

  it('proxyUrl satisfies the uplink requirement (no btpUrl needed)', () => {
    const cfg = resolveConfig({
      mnemonic: MNEMONIC,
      proxyUrl: 'https://proxy.devnet.toonprotocol.dev',
      destination: 'g.proxy',
    });
    expect(cfg.hasUplink).toBe(true);
    expect(cfg.proxyUrl).toBe('https://proxy.devnet.toonprotocol.dev');
    expect(cfg.destination).toBe('g.proxy');
    // No BTP socket is configured on the proxy path.
    expect(cfg.toonClientConfig.btpUrl).toBeUndefined();
    expect(
      (cfg.toonClientConfig as Record<string, unknown>)['proxyUrl']
    ).toBe('https://proxy.devnet.toonprotocol.dev');
    // connectorUrl is NOT injected as a dummy when proxyUrl is present.
    expect(cfg.toonClientConfig.connectorUrl).toBeUndefined();
  });

  it('proxy mode synthesizes an apex negotiation from settlement config (#69)', () => {
    const cfg = resolveConfig({
      mnemonic: MNEMONIC,
      proxyUrl: 'https://proxy.devnet.toonprotocol.dev',
      destination: 'g.proxy.relay',
      chain: 'evm',
      settlementAddresses: {
        'evm:devnet:31337': '0x51d35a8a80377d0e70c226dc7abb97e200c68f04',
      },
      tokenNetworks: {
        'evm:devnet:31337': '0xCafac3dD18aC6c6e92c921884f9E4176737C052c',
      },
      preferredTokens: {
        'evm:devnet:31337': '0x5FbDB2315678afecb367f032d93F642f64180aa3',
      },
    });
    const a = cfg.apex;
    expect(a).toBeDefined();
    if (!a) throw new Error('expected synthesized apex negotiation');
    expect(a.peerId).toBe('relay'); // last segment of g.proxy.relay
    expect(a.destination).toBe('g.proxy.relay');
    expect(a.chain).toBe('evm');
    expect(a.chainKey).toBe('evm:devnet:31337');
    expect(a.chainId).toBe(31337);
    expect(a.settlementAddress).toBe(
      '0x51d35a8a80377d0e70c226dc7abb97e200c68f04'
    );
    expect(a.tokenNetwork).toBe(
      '0xCafac3dD18aC6c6e92c921884f9E4176737C052c'
    );
    expect(a.tokenAddress).toBe(
      '0x5FbDB2315678afecb367f032d93F642f64180aa3'
    );
  });

  it('proxy mode WITHOUT a settlement address defers to discovery (no apex)', () => {
    // No counterparty address → cannot synthesize; the runner falls back to
    // live kind:10032 discovery rather than fabricating an address (#69).
    const cfg = resolveConfig({
      mnemonic: MNEMONIC,
      proxyUrl: 'https://proxy.devnet.toonprotocol.dev',
      destination: 'g.proxy.relay',
      chain: 'evm',
    });
    expect(cfg.hasUplink).toBe(true);
    expect(cfg.apex).toBeUndefined();
  });

  it('explicit file.apex overrides the synthesized proxy negotiation', () => {
    const explicit = {
      destination: 'g.proxy.relay',
      peerId: 'relay',
      chain: 'evm' as const,
      chainKey: 'evm:devnet:31337',
      chainId: 31337,
      settlementAddress: '0xExplicitConnectorAddr',
    };
    const cfg = resolveConfig({
      mnemonic: MNEMONIC,
      proxyUrl: 'https://proxy.devnet.toonprotocol.dev',
      destination: 'g.proxy.relay',
      apex: explicit,
      settlementAddresses: {
        'evm:devnet:31337': '0xSynthesizedAddrShouldLose',
      },
    });
    expect(cfg.apex?.settlementAddress).toBe('0xExplicitConnectorAddr');
  });

  it('TOON_CLIENT_PROXY_URL / FAUCET_URL / DESTINATION env overrides', () => {
    process.env['TOON_CLIENT_PROXY_URL'] = 'https://env-proxy/ilp';
    process.env['TOON_CLIENT_FAUCET_URL'] = 'https://env-faucet';
    process.env['TOON_CLIENT_DESTINATION'] = 'g.proxy.relay';
    const cfg = resolveConfig({
      mnemonic: MNEMONIC,
      proxyUrl: 'https://file-proxy',
      faucetUrl: 'https://file-faucet',
      destination: 'g.file.dest',
    });
    expect(cfg.proxyUrl).toBe('https://env-proxy/ilp');
    expect(cfg.faucetUrl).toBe('https://env-faucet');
    expect(cfg.destination).toBe('g.proxy.relay');
    expect(
      (cfg.toonClientConfig as Record<string, unknown>)['faucetUrl']
    ).toBe('https://env-faucet');
  });

  it('faucetTimeoutMs is unset by default (faucet picks a chain-aware default)', () => {
    const cfg = resolveConfig({ mnemonic: MNEMONIC });
    expect(cfg.faucetTimeoutMs).toBeUndefined();
  });

  it('faucetTimeoutMs comes from the file and is overridden by the env var', () => {
    const fromFile = resolveConfig({ mnemonic: MNEMONIC, faucetTimeoutMs: 90000 });
    expect(fromFile.faucetTimeoutMs).toBe(90000);

    process.env['TOON_CLIENT_FAUCET_TIMEOUT_MS'] = '150000';
    const fromEnv = resolveConfig({ mnemonic: MNEMONIC, faucetTimeoutMs: 90000 });
    expect(fromEnv.faucetTimeoutMs).toBe(150000);
  });

  it('publishDestination / storeDestination are DERIVED from the .relay.store anchor when unset', () => {
    const cfg = resolveConfig({
      mnemonic: MNEMONIC,
      proxyUrl: 'https://proxy.devnet.toonprotocol.dev',
      destination: 'g.proxy.relay.store',
    });
    // The bare anchor would forward a /write to the store backend → 404; routes
    // must split to the relay (publish) and store (upload) terminate addresses.
    expect(cfg.publishDestination).toBe('g.proxy.relay');
    expect(cfg.storeDestination).toBe('g.proxy.store');
  });

  it('route derivation falls back to the anchor for non-.relay.store destinations', () => {
    const cfg = resolveConfig({
      mnemonic: MNEMONIC,
      btpUrl: 'ws://apex.test:3000/btp',
      destination: 'g.custom.apex',
    });
    expect(cfg.publishDestination).toBe('g.custom.apex');
    expect(cfg.storeDestination).toBe('g.custom.apex');
  });

  it('publishDestination / storeDestination use explicit file values', () => {
    const cfg = resolveConfig({
      mnemonic: MNEMONIC,
      proxyUrl: 'https://proxy.devnet.toonprotocol.dev',
      destination: 'g.proxy.relay.store',
      publishDestination: 'g.proxy.relay',
      storeDestination: 'g.proxy.store',
    });
    expect(cfg.publishDestination).toBe('g.proxy.relay');
    expect(cfg.storeDestination).toBe('g.proxy.store');
  });

  it('TOON_CLIENT_PUBLISH_DESTINATION / STORE_DESTINATION env overrides win over file', () => {
    process.env['TOON_CLIENT_PUBLISH_DESTINATION'] = 'g.env.relay';
    process.env['TOON_CLIENT_STORE_DESTINATION'] = 'g.env.store';
    const cfg = resolveConfig({
      mnemonic: MNEMONIC,
      proxyUrl: 'https://proxy.devnet.toonprotocol.dev',
      destination: 'g.proxy.relay.store',
      publishDestination: 'g.file.relay',
      storeDestination: 'g.file.store',
    });
    expect(cfg.publishDestination).toBe('g.env.relay');
    expect(cfg.storeDestination).toBe('g.env.store');
  });

  it('still injects a dummy connectorUrl on the BTP-only path', () => {
    const cfg = resolveConfig({
      mnemonic: MNEMONIC,
      btpUrl: 'ws://apex.test:3000/btp',
    });
    expect(cfg.toonClientConfig.connectorUrl).toBe('http://127.0.0.1:1');
    expect(cfg.proxyUrl).toBeUndefined();
  });

  it('resolveConfig builds a ToonClientConfig with defaults', () => {
    const cfg = resolveConfig({
      mnemonic: MNEMONIC,
      btpUrl: 'ws://apex.test:3000/btp',
    });
    expect(cfg.httpPort).toBe(8787);
    expect(cfg.relayUrl).toBe('ws://localhost:7100');
    // No file/env destination and an empty bundled genesis list → last-resort
    // fallback. Once core ships a seeded genesis-peers.json this resolves to the
    // seed apex's ILP anchor instead.
    expect(cfg.destination).toBe('g.proxy');
    expect(cfg.feePerEvent).toBe(1n);
    expect(cfg.toonClientConfig.btpUrl).toBe('ws://apex.test:3000/btp');
    // The legacy anon/HS transport overlay is gone — no transport knobs survive.
    expect(
      (cfg.toonClientConfig as Record<string, unknown>)['transport']
    ).toBeUndefined();
    expect(
      (cfg.toonClientConfig as Record<string, unknown>)['managedAnonProxy']
    ).toBeUndefined();
  });

  it('env overrides win over the config file', () => {
    process.env['TOON_CLIENT_BTP_URL'] = 'ws://env-apex/btp';
    process.env['TOON_CLIENT_RELAY_URL'] = 'ws://env-relay';
    process.env['TOON_CLIENT_HTTP_PORT'] = '9999';
    const cfg = resolveConfig({
      mnemonic: MNEMONIC,
      btpUrl: 'ws://file-apex/btp',
      relayUrl: 'ws://file-relay',
      httpPort: 1234,
    });
    expect(cfg.toonClientConfig.btpUrl).toBe('ws://env-apex/btp');
    expect(cfg.relayUrl).toBe('ws://env-relay');
    expect(cfg.httpPort).toBe(9999);
  });

  it('passes a named network tier through to the ToonClient config', () => {
    const cfg = resolveConfig({
      mnemonic: MNEMONIC,
      btpUrl: 'ws://apex/btp',
      network: 'testnet',
    });
    expect(cfg.toonClientConfig.network).toBe('testnet');
    expect(cfg.network).toBe('testnet');
  });

  it('defaults the active settlement chain to evm', () => {
    const cfg = resolveConfig({ mnemonic: MNEMONIC, btpUrl: 'ws://apex/btp' });
    expect(cfg.chain).toBe('evm');
  });

  it('selects the apex negotiation for the active chain from apexChains', () => {
    const apexChains = {
      evm: {
        destination: 'g.proxy',
        peerId: 'proxy',
        chain: 'evm' as const,
        chainKey: 'evm:base:84532',
        chainId: 84532,
        settlementAddress: '0xevm',
      },
      solana: {
        destination: 'g.proxy',
        peerId: 'proxy',
        chain: 'solana' as const,
        chainKey: 'solana:devnet',
        chainId: 0,
        settlementAddress: 'SoLApex',
      },
    };
    const evm = resolveConfig({
      mnemonic: MNEMONIC,
      btpUrl: 'ws://apex/btp',
      apexChains,
    });
    expect(evm.chain).toBe('evm');
    expect(evm.apex?.settlementAddress).toBe('0xevm');

    const sol = resolveConfig({
      mnemonic: MNEMONIC,
      btpUrl: 'ws://apex/btp',
      chain: 'solana',
      apexChains,
    });
    expect(sol.chain).toBe('solana');
    expect(sol.apex?.settlementAddress).toBe('SoLApex');
  });

  it('passes apexChildPeers through (and omits the key when unset)', () => {
    const withChildren = resolveConfig({
      mnemonic: MNEMONIC,
      btpUrl: 'ws://apex/btp',
      apexChildPeers: ['store', 'mill'],
    });
    expect(withChildren.apexChildPeers).toEqual(['store', 'mill']);

    const without = resolveConfig({
      mnemonic: MNEMONIC,
      btpUrl: 'ws://apex/btp',
    });
    expect(without.apexChildPeers).toBeUndefined();
  });

  it('TOON_CLIENT_CHAIN overrides the configured chain', () => {
    process.env['TOON_CLIENT_CHAIN'] = 'mina';
    const cfg = resolveConfig({
      mnemonic: MNEMONIC,
      btpUrl: 'ws://apex/btp',
      chain: 'evm',
    });
    expect(cfg.chain).toBe('mina');
  });

  it('passes solanaChannel and minaChannel through to the ToonClient config', () => {
    const cfg = resolveConfig({
      mnemonic: MNEMONIC,
      btpUrl: 'ws://apex/btp',
      solanaChannel: { rpcUrl: 'https://sol', programId: 'Prog' },
      minaChannel: { graphqlUrl: 'https://mina', zkAppAddress: 'B62zk' },
    });
    expect(cfg.toonClientConfig.solanaChannel?.programId).toBe('Prog');
    expect(cfg.toonClientConfig.minaChannel?.zkAppAddress).toBe('B62zk');
  });
});
