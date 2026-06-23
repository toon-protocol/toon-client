import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveConfig, resolveMnemonic, readConfigFile } from './config.js';

const MNEMONIC = 'test test test test test test test test test test test junk';

const ENV_KEYS = [
  'TOON_CLIENT_MNEMONIC',
  'TOON_CLIENT_BTP_URL',
  'TOON_CLIENT_RELAY_URL',
  'TOON_CLIENT_HTTP_PORT',
  'TOON_CLIENT_NETWORK',
  'TOON_CLIENT_CHAIN',
  'TOON_CLIENT_KEYSTORE_PASSWORD',
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

  it('resolveConfig requires a btpUrl', () => {
    expect(() => resolveConfig({ mnemonic: MNEMONIC })).toThrow(/btpUrl/);
  });

  it('resolveConfig builds a ToonClientConfig with defaults', () => {
    const cfg = resolveConfig({
      mnemonic: MNEMONIC,
      btpUrl: 'ws://apex.test:3000/btp',
    });
    expect(cfg.httpPort).toBe(8787);
    expect(cfg.relayUrl).toBe('ws://localhost:7100');
    expect(cfg.destination).toBe('g.townhouse.town');
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
        destination: 'g.townhouse.town',
        peerId: 'town',
        chain: 'evm' as const,
        chainKey: 'evm:base:84532',
        chainId: 84532,
        settlementAddress: '0xevm',
      },
      solana: {
        destination: 'g.townhouse.town',
        peerId: 'town',
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
      apexChildPeers: ['dvm', 'mill'],
    });
    expect(withChildren.apexChildPeers).toEqual(['dvm', 'mill']);

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
