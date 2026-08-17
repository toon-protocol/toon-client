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
  'TOON_CLIENT_STORE_BTP_URL',
  'TOON_CLIENT_KEYSTORE_PASSWORD',
  'TOON_CLIENT_ARWEAVE_GATEWAYS',
  'TOON_CLIENT_PREFER_BTP',
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
    // A read-only daemon still builds a usable ToonClientConfig (relay reads).
    // With NEITHER btpUrl nor proxyUrl configured, nothing can derive a real
    // client edge, so the dummy connectorUrl still satisfies validateConfig
    // here — unlike the BTP-only path (issue #462), nothing would ever dial
    // it, since a read-only client never publishes.
    expect(cfg.toonClientConfig.connectorUrl).toBe('http://127.0.0.1:1');
    expect(cfg.toonClientConfig.btpUrl).toBeUndefined();
    expect(cfg.proxyUrl).toBeUndefined();
    expect(cfg.apex).toBeUndefined();
  });

  it('passes swapDefaults through (#351, controller/rolling dropped in toon-client#598)', () => {
    const swapDefaults = {
      floorBps: 50,
      packetExpiryMs: 5000,
    };
    const cfg = resolveConfig({ mnemonic: MNEMONIC, swapDefaults });
    expect(cfg.swapDefaults).toEqual(swapDefaults);
    // Unconfigured daemons carry no swap defaults (defenses stay opt-in).
    expect(resolveConfig({ mnemonic: MNEMONIC }).swapDefaults).toBeUndefined();
  });

  describe('preferBtpForPaidWrites (issue #565)', () => {
    it('defaults to true whenever a btpUrl is configured', () => {
      const cfg = resolveConfig({
        mnemonic: MNEMONIC,
        btpUrl: 'ws://apex:3000',
      });
      expect(cfg.toonClientConfig.preferBtpForPaidWrites).toBe(true);
    });

    it('is left unset with no btpUrl — there is no socket to prefer', () => {
      const cfg = resolveConfig({
        mnemonic: MNEMONIC,
        proxyUrl: 'https://proxy.test',
      });
      expect(cfg.toonClientConfig.preferBtpForPaidWrites).toBeUndefined();
    });

    it('honors an explicit false in the config file', () => {
      const cfg = resolveConfig({
        mnemonic: MNEMONIC,
        btpUrl: 'ws://apex:3000',
        preferBtpForPaidWrites: false,
      });
      expect(cfg.toonClientConfig.preferBtpForPaidWrites).toBe(false);
    });

    it('TOON_CLIENT_PREFER_BTP env overrides the config file', () => {
      process.env['TOON_CLIENT_PREFER_BTP'] = 'false';
      const cfg = resolveConfig({
        mnemonic: MNEMONIC,
        btpUrl: 'ws://apex:3000',
        preferBtpForPaidWrites: true,
      });
      expect(cfg.toonClientConfig.preferBtpForPaidWrites).toBe(false);
    });
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
    expect((cfg.toonClientConfig as Record<string, unknown>)['proxyUrl']).toBe(
      'https://proxy.devnet.toonprotocol.dev'
    );
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
    expect(a.tokenNetwork).toBe('0xCafac3dD18aC6c6e92c921884f9E4176737C052c');
    expect(a.tokenAddress).toBe('0x5FbDB2315678afecb367f032d93F642f64180aa3');
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
    expect((cfg.toonClientConfig as Record<string, unknown>)['faucetUrl']).toBe(
      'https://env-faucet'
    );
  });

  it('faucetTimeoutMs is unset by default (faucet picks a chain-aware default)', () => {
    const cfg = resolveConfig({ mnemonic: MNEMONIC });
    expect(cfg.faucetTimeoutMs).toBeUndefined();
  });

  it('faucetTimeoutMs comes from the file and is overridden by the env var', () => {
    const fromFile = resolveConfig({
      mnemonic: MNEMONIC,
      faucetTimeoutMs: 90000,
    });
    expect(fromFile.faucetTimeoutMs).toBe(90000);

    process.env['TOON_CLIENT_FAUCET_TIMEOUT_MS'] = '150000';
    const fromEnv = resolveConfig({
      mnemonic: MNEMONIC,
      faucetTimeoutMs: 90000,
    });
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

  it('publishDestination / storeDestination default to the two independent genesis peers when nothing is set (issue #536)', () => {
    // core@3.3.0's genesis seed carries two independent entries — relay
    // (g.toon.relay) and store (g.toon.ario) — with no forwarding between
    // them. A fresh install with no file/env destination must route uploads
    // to the store's OWN address, not derive it from the relay anchor via
    // the retired apex `<base>.relay.store` naming convention.
    const cfg = resolveConfig({
      mnemonic: MNEMONIC,
      btpUrl: 'ws://apex.test:3000/btp',
    });
    expect(cfg.destination).toBe('g.toon.relay');
    expect(cfg.publishDestination).toBe('g.toon.relay');
    expect(cfg.storeDestination).toBe('g.toon.ario');
  });

  it('storeBtpUrl defaults to the genesis STORE peer own BTP endpoint (issue #536 correction)', () => {
    // The relay and store connectors are independent boxes with no forwarding
    // between them: reaching g.toon.ario needs a SECOND uplink connected to
    // the store's own btpEndpoint, not just a renamed destination on the
    // relay's uplink.
    const cfg = resolveConfig({
      mnemonic: MNEMONIC,
      btpUrl: 'ws://apex.test:3000/btp',
    });
    expect(cfg.storeBtpUrl).toBe(
      'wss://proxy.ario.devnet.toonprotocol.dev/ilp/btp'
    );
  });

  it('storeBtpUrl is absent when an explicit destination is configured (custom/legacy topology)', () => {
    const cfg = resolveConfig({
      mnemonic: MNEMONIC,
      proxyUrl: 'https://proxy.devnet.toonprotocol.dev',
      destination: 'g.proxy.relay.store',
    });
    expect(cfg.storeBtpUrl).toBeUndefined();
  });

  it('storeBtpUrl is absent when it matches the default btpUrl (single-connector topology)', () => {
    const cfg = resolveConfig({
      mnemonic: MNEMONIC,
      btpUrl: 'wss://proxy.ario.devnet.toonprotocol.dev/ilp/btp',
    });
    expect(cfg.storeBtpUrl).toBeUndefined();
  });

  it('file storeBtpUrl and TOON_CLIENT_STORE_BTP_URL env override the genesis default', () => {
    const fromFile = resolveConfig({
      mnemonic: MNEMONIC,
      btpUrl: 'ws://apex.test:3000/btp',
      storeBtpUrl: 'ws://custom-store.test/btp',
    });
    expect(fromFile.storeBtpUrl).toBe('ws://custom-store.test/btp');

    process.env['TOON_CLIENT_STORE_BTP_URL'] = 'ws://env-store.test/btp';
    const fromEnv = resolveConfig({
      mnemonic: MNEMONIC,
      btpUrl: 'ws://apex.test:3000/btp',
      storeBtpUrl: 'ws://custom-store.test/btp',
    });
    expect(fromEnv.storeBtpUrl).toBe('ws://env-store.test/btp');
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

  // issue #462: the BTP-only path used to inject an inert
  // `http://127.0.0.1:1` connectorUrl placeholder purely to satisfy
  // ToonClient's validateConfig. Every paid write now dials that origin for
  // `GET /ilp/identity` / `GET /ilp/routes/price` (ADR 0018/0020), so a
  // BTP-only daemon must get a REAL client edge instead — `applyDefaults`
  // (packages/client) derives one from `btpUrl` (connector PR #181 serves
  // ILP-over-HTTP and BTP on the same port).
  it('does NOT inject a dummy connectorUrl on the BTP-only path — no explicit connectorUrl at all', () => {
    const cfg = resolveConfig({
      mnemonic: MNEMONIC,
      btpUrl: 'ws://apex.test:3000/btp',
    });
    expect(cfg.toonClientConfig.connectorUrl).toBeUndefined();
    expect(cfg.toonClientConfig.btpUrl).toBe('ws://apex.test:3000/btp');
    expect(cfg.proxyUrl).toBeUndefined();
  });

  it('resolveConfig builds a ToonClientConfig with defaults', () => {
    const cfg = resolveConfig({
      mnemonic: MNEMONIC,
      btpUrl: 'ws://apex.test:3000/btp',
    });
    expect(cfg.httpPort).toBe(8787);
    // No file/env overrides → defaults come from core's committed genesis peer
    // seed (core ≥2.0.1 ships the live devnet apex; the pre-seed last-resort
    // fallbacks were ws://localhost:7100 / g.proxy).
    // core@3.2.0 re-pointed that seed at the Rust apex, which announces itself
    // as `g.toon`; the retired TypeScript connector was the one called `g.proxy`.
    // core@3.3.0 (issue #536) retired the apex itself: the seed's first entry
    // is now the relay box's own address, `g.toon.relay`.
    expect(cfg.relayUrl).toBe('wss://relay-ws.devnet.toonprotocol.dev');
    expect(cfg.destination).toBe('g.toon.relay');
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

  // issue #550 round 3: `toonClientConfig.relayUrl` used to be pinned to `''`
  // unconditionally (reads route through the daemon's own RelaySubscription,
  // not ToonClient's). But ToonClient.start() ALSO uses `config.relayUrl` to
  // feed its `discoveryTracker` (subscribeToDiscovery) — with it empty, the
  // tracker never discovers a peer for the write destination and every paid
  // write throws TERMINATOR_UNRESOLVED. `toonClientConfig.relayUrl` must
  // carry the daemon's own resolved relay so that feed has something to
  // subscribe to, without disturbing RelaySubscription's separate reads.
  it('feeds the daemon-resolved relay into toonClientConfig.relayUrl (issue #550)', () => {
    const cfg = resolveConfig({
      mnemonic: MNEMONIC,
      btpUrl: 'ws://apex.test:3000/btp',
      relayUrl: 'wss://relay.test',
    });
    expect(cfg.relayUrl).toBe('wss://relay.test');
    expect(cfg.toonClientConfig.relayUrl).toBe('wss://relay.test');
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
      apexChildPeers: ['store', 'swap'],
    });
    expect(withChildren.apexChildPeers).toEqual(['store', 'swap']);

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

  it('threads swapVerifyingContracts through as a SEPARATE map from tokenNetworks (#583)', () => {
    const LEG_A = '0xa79C3b1dbcEA00a6d84735a134395D8eF6D6a478';
    const LEG_B = '0xd329aBf86ceae23F904641F992ca90e3721FeF83';
    const cfg = resolveConfig({
      mnemonic: MNEMONIC,
      tokenNetworks: { 'evm:84532': LEG_A },
      swapVerifyingContracts: { 'evm:84532': LEG_B },
    });
    // The operator override for LEG-B claim verification, distinct end to end:
    // conflating the two is what made a valid live claim look key-mismatched.
    expect(cfg.toonClientConfig.swapVerifyingContracts).toEqual({
      'evm:84532': LEG_B,
    });
    expect(cfg.toonClientConfig.tokenNetworks).toEqual({ 'evm:84532': LEG_A });
  });

  it('leaves swapVerifyingContracts unset when the config file omits it (the normal case: the maker announces it)', () => {
    const cfg = resolveConfig({ mnemonic: MNEMONIC });
    expect(cfg.toonClientConfig.swapVerifyingContracts).toBeUndefined();
  });
});
