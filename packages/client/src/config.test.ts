import { describe, it, expect } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import {
  validateConfig,
  applyDefaults,
  buildSettlementInfo,
  applyNetworkPresets,
  getNetworkStatus,
  proxyIlpEndpoint,
} from './config.js';
import { ValidationError } from './errors.js';
import type { ToonClientConfig } from './types.js';

describe('validateConfig', () => {
  // Helper to create minimal valid config
  const createValidConfig = (
    overrides: Partial<ToonClientConfig> = {}
  ): ToonClientConfig => {
    const secretKey = generateSecretKey();
    const pubkey = getPublicKey(secretKey);
    return {
      connectorUrl: 'http://localhost:8080',
      secretKey,
      ilpInfo: {
        pubkey,
        ilpAddress: 'g.test.address',
        btpEndpoint: 'ws://localhost:3000',
        assetCode: 'USD',
        assetScale: 6,
      },
      toonEncoder: (_event) => new Uint8Array(0),
      toonDecoder: (_bytes) => ({
        id: '',
        pubkey: '',
        created_at: 0,
        kind: 1,
        tags: [],
        content: '',
        sig: '',
      }),
      ...overrides,
    };
  };

  describe('embedded mode rejection (AC: 3)', () => {
    it('should throw error when connector is provided', () => {
      const config = createValidConfig({ connector: {} as unknown });

      expect(() => validateConfig(config)).toThrow(ValidationError);
      expect(() => validateConfig(config)).toThrow(
        'Embedded mode not yet implemented'
      );
    });

    it('should throw error with explicit message for embedded mode', () => {
      const config = createValidConfig({
        connector: { some: 'value' } as unknown,
      });

      expect(() => validateConfig(config)).toThrow(
        'Embedded mode not yet implemented in ToonClient. Use connectorUrl for HTTP mode.'
      );
    });
  });

  describe('connectorUrl validation (AC: 4)', () => {
    it('should throw error when neither connectorUrl nor proxyUrl is set', () => {
      const config = createValidConfig({ connectorUrl: undefined });

      expect(() => validateConfig(config)).toThrow(ValidationError);
      expect(() => validateConfig(config)).toThrow(
        'connectorUrl (or proxyUrl) is required'
      );
    });

    it('should throw error with example when no HTTP edge is set', () => {
      const config = createValidConfig({ connectorUrl: undefined });

      expect(() => validateConfig(config)).toThrow(
        'connectorUrl (or proxyUrl) is required for HTTP mode. Example: "http://localhost:8080"'
      );
    });

    it('should accept a proxyUrl in place of connectorUrl', () => {
      const config = createValidConfig({
        connectorUrl: undefined,
        proxyUrl: 'https://proxy.devnet.toonprotocol.dev',
      });
      expect(() => validateConfig(config)).not.toThrow();
    });

    it('should reject a non-HTTP proxyUrl / faucetUrl', () => {
      expect(() =>
        validateConfig(
          createValidConfig({ proxyUrl: 'ws://proxy.example' })
        )
      ).toThrow('Invalid proxyUrl');
      expect(() =>
        validateConfig(createValidConfig({ faucetUrl: 'not-a-url' }))
      ).toThrow('Invalid faucetUrl');
    });

    it('should accept valid HTTP connectorUrl', () => {
      const config = createValidConfig({
        connectorUrl: 'http://localhost:8080',
      });

      expect(() => validateConfig(config)).not.toThrow();
    });

    it('should accept valid HTTPS connectorUrl', () => {
      const config = createValidConfig({
        connectorUrl: 'https://connector.example.com',
      });

      expect(() => validateConfig(config)).not.toThrow();
    });

    it('should throw error for non-HTTP/HTTPS URL', () => {
      const config = createValidConfig({ connectorUrl: 'ws://localhost:8080' });

      expect(() => validateConfig(config)).toThrow(ValidationError);
      expect(() => validateConfig(config)).toThrow(
        'must be a valid HTTP/HTTPS URL'
      );
    });

    it('should throw error for invalid URL format', () => {
      const config = createValidConfig({ connectorUrl: 'not-a-url' });

      expect(() => validateConfig(config)).toThrow(ValidationError);
      expect(() => validateConfig(config)).toThrow(
        'must be a valid HTTP/HTTPS URL'
      );
    });
  });

  describe('secretKey validation', () => {
    it('should accept config when secretKey is omitted (auto-generated)', () => {
      const config = createValidConfig({ secretKey: undefined });

      expect(() => validateConfig(config)).not.toThrow();
    });

    it('should throw error when secretKey is not 32 bytes', () => {
      const config = createValidConfig({ secretKey: new Uint8Array(16) });

      expect(() => validateConfig(config)).toThrow(ValidationError);
      expect(() => validateConfig(config)).toThrow(
        'secretKey must be 32 bytes'
      );
    });

    it('should accept 32-byte secretKey', () => {
      const secretKey = generateSecretKey();
      const pubkey = getPublicKey(secretKey);
      const config = createValidConfig({
        secretKey,
        ilpInfo: {
          pubkey,
          ilpAddress: 'g.test',
          btpEndpoint: 'ws://test',
          assetCode: 'USD',
          assetScale: 6,
        },
      });

      expect(() => validateConfig(config)).not.toThrow();
    });
  });

  describe('ilpInfo validation', () => {
    it('should throw error when ilpInfo is missing', () => {
      const config = createValidConfig({ ilpInfo: undefined as any });

      expect(() => validateConfig(config)).toThrow(ValidationError);
      expect(() => validateConfig(config)).toThrow(
        'ilpInfo.ilpAddress is required'
      );
    });

    it('should throw error when ilpInfo.ilpAddress is missing', () => {
      const secretKey = generateSecretKey();
      const pubkey = getPublicKey(secretKey);
      const config = createValidConfig({
        secretKey,
        ilpInfo: {
          ilpAddress: '',
          btpEndpoint: 'ws://test',
          pubkey,
          assetCode: 'USD',
          assetScale: 6,
        },
      });

      expect(() => validateConfig(config)).toThrow(ValidationError);
      expect(() => validateConfig(config)).toThrow(
        'ilpInfo.ilpAddress is required'
      );
    });

    it('should accept valid ilpInfo', () => {
      const secretKey = generateSecretKey();
      const pubkey = getPublicKey(secretKey);
      const config = createValidConfig({
        secretKey,
        ilpInfo: {
          pubkey,
          ilpAddress: 'g.test.address',
          btpEndpoint: 'ws://localhost:3000',
          assetCode: 'USD',
          assetScale: 6,
        },
      });

      expect(() => validateConfig(config)).not.toThrow();
    });
  });

  describe('TOON encoder/decoder validation', () => {
    it('should throw error when toonEncoder is missing', () => {
      const config = createValidConfig({ toonEncoder: undefined as any });

      expect(() => validateConfig(config)).toThrow(ValidationError);
      expect(() => validateConfig(config)).toThrow(
        'toonEncoder function is required'
      );
    });

    it('should throw error when toonEncoder is not a function', () => {
      const config = createValidConfig({
        toonEncoder: 'not-a-function' as any,
      });

      expect(() => validateConfig(config)).toThrow(ValidationError);
      expect(() => validateConfig(config)).toThrow(
        'toonEncoder function is required'
      );
    });

    it('should throw error when toonDecoder is missing', () => {
      const config = createValidConfig({ toonDecoder: undefined as any });

      expect(() => validateConfig(config)).toThrow(ValidationError);
      expect(() => validateConfig(config)).toThrow(
        'toonDecoder function is required'
      );
    });

    it('should throw error when toonDecoder is not a function', () => {
      const config = createValidConfig({
        toonDecoder: 'not-a-function' as any,
      });

      expect(() => validateConfig(config)).toThrow(ValidationError);
      expect(() => validateConfig(config)).toThrow(
        'toonDecoder function is required'
      );
    });

    it('should accept valid toonEncoder and toonDecoder', () => {
      const config = createValidConfig({
        toonEncoder: (_event) => new Uint8Array(0),
        toonDecoder: (_bytes) => ({
          id: '',
          pubkey: '',
          created_at: 0,
          kind: 1,
          tags: [],
          content: '',
          sig: '',
        }),
      });

      expect(() => validateConfig(config)).not.toThrow();
    });
  });

  describe('evmPrivateKey validation', () => {
    it('should accept valid hex string with 0x prefix', () => {
      const config = createValidConfig({
        evmPrivateKey: '0x' + 'ab'.repeat(32),
      });

      expect(() => validateConfig(config)).not.toThrow();
    });

    it('should accept valid hex string without 0x prefix', () => {
      const config = createValidConfig({
        evmPrivateKey: 'cd'.repeat(32),
      });

      expect(() => validateConfig(config)).not.toThrow();
    });

    it('should accept valid Uint8Array', () => {
      const config = createValidConfig({
        evmPrivateKey: new Uint8Array(32),
      });

      expect(() => validateConfig(config)).not.toThrow();
    });

    it('should throw error for invalid hex string', () => {
      const config = createValidConfig({
        evmPrivateKey: '0xnothex',
      });

      expect(() => validateConfig(config)).toThrow(ValidationError);
      expect(() => validateConfig(config)).toThrow('32-byte hex string');
    });

    it('should throw error for wrong length Uint8Array', () => {
      const config = createValidConfig({
        evmPrivateKey: new Uint8Array(16),
      });

      expect(() => validateConfig(config)).toThrow(ValidationError);
      expect(() => validateConfig(config)).toThrow(
        'evmPrivateKey must be 32 bytes'
      );
    });
  });

  describe('btpUrl validation', () => {
    it('should accept valid WS URL', () => {
      const config = createValidConfig({ btpUrl: 'ws://localhost:3000' });
      expect(() => validateConfig(config)).not.toThrow();
    });

    it('should accept valid WSS URL', () => {
      const config = createValidConfig({ btpUrl: 'wss://secure.example.com' });
      expect(() => validateConfig(config)).not.toThrow();
    });

    it('should throw error for non-WebSocket URL', () => {
      const config = createValidConfig({ btpUrl: 'http://localhost:3000' });
      expect(() => validateConfig(config)).toThrow(ValidationError);
      expect(() => validateConfig(config)).toThrow(
        'must be a valid WebSocket URL'
      );
    });
  });

  describe('chainRpcUrls validation', () => {
    it('should throw when chainRpcUrls key is not in supportedChains', () => {
      const config = createValidConfig({
        supportedChains: ['evm:anvil:31337'],
        chainRpcUrls: { 'evm:mainnet:1': 'http://localhost:8545' },
      });

      expect(() => validateConfig(config)).toThrow(ValidationError);
      expect(() => validateConfig(config)).toThrow('not in supportedChains');
    });

    it('should accept when chainRpcUrls keys match supportedChains', () => {
      const config = createValidConfig({
        supportedChains: ['evm:anvil:31337'],
        chainRpcUrls: { 'evm:anvil:31337': 'http://localhost:8545' },
      });

      expect(() => validateConfig(config)).not.toThrow();
    });
  });
});

describe('applyDefaults', () => {
  const createMinimalConfig = (): ToonClientConfig => {
    const secretKey = generateSecretKey();
    const pubkey = getPublicKey(secretKey);
    return {
      connectorUrl: 'http://localhost:8080',
      secretKey,
      ilpInfo: {
        pubkey,
        ilpAddress: 'g.test.address',
        btpEndpoint: 'ws://localhost:3000',
        assetCode: 'USD',
        assetScale: 6,
      },
      toonEncoder: (_event) => new Uint8Array(0),
      toonDecoder: (_bytes) => ({
        id: '',
        pubkey: '',
        created_at: 0,
        kind: 1,
        tags: [],
        content: '',
        sig: '',
      }),
    };
  };

  it('should auto-generate secretKey when omitted', () => {
    const config = createMinimalConfig();
    delete (config as any).secretKey;
    config.secretKey = undefined;
    const result = applyDefaults(config);

    expect(result.secretKey).toBeDefined();
    expect(result.secretKey).toHaveLength(32);
  });

  it('should preserve provided secretKey', () => {
    const config = createMinimalConfig();
    const originalKey = config.secretKey;
    const result = applyDefaults(config);

    expect(result.secretKey).toBe(originalKey);
  });

  it('should derive btpUrl from connectorUrl when not provided', () => {
    const config = createMinimalConfig();
    const result = applyDefaults(config);

    expect(result.btpUrl).toBe('ws://localhost:3000');
  });

  it('should preserve custom btpUrl', () => {
    const config = createMinimalConfig();
    config.btpUrl = 'ws://custom:5000';
    const result = applyDefaults(config);

    expect(result.btpUrl).toBe('ws://custom:5000');
  });

  it('should derive wss btpUrl from https connectorUrl', () => {
    const config = createMinimalConfig();
    config.connectorUrl = 'https://connector.example.com:8080';
    const result = applyDefaults(config);

    expect(result.btpUrl).toBe('wss://connector.example.com:3000');
  });

  it('should apply default relayUrl', () => {
    const config = createMinimalConfig();
    const result = applyDefaults(config);

    expect(result.relayUrl).toBe('wss://relay-ws.devnet.toonprotocol.dev');
  });

  it('should preserve custom relayUrl', () => {
    const config = createMinimalConfig();
    config.relayUrl = 'ws://custom:7777';
    const result = applyDefaults(config);

    expect(result.relayUrl).toBe('ws://custom:7777');
  });

  it('should apply default queryTimeout', () => {
    const config = createMinimalConfig();
    const result = applyDefaults(config);

    expect(result.queryTimeout).toBe(30000);
  });

  it('should preserve custom queryTimeout', () => {
    const config = createMinimalConfig();
    config.queryTimeout = 60000;
    const result = applyDefaults(config);

    expect(result.queryTimeout).toBe(60000);
  });

  it('should apply default maxRetries', () => {
    const config = createMinimalConfig();
    const result = applyDefaults(config);

    expect(result.maxRetries).toBe(3);
  });

  it('should preserve custom maxRetries', () => {
    const config = createMinimalConfig();
    config.maxRetries = 5;
    const result = applyDefaults(config);

    expect(result.maxRetries).toBe(5);
  });

  it('should apply default retryDelay', () => {
    const config = createMinimalConfig();
    const result = applyDefaults(config);

    expect(result.retryDelay).toBe(1000);
  });

  it('should preserve custom retryDelay', () => {
    const config = createMinimalConfig();
    config.retryDelay = 2000;
    const result = applyDefaults(config);

    expect(result.retryDelay).toBe(2000);
  });

  it('should preserve all required fields', () => {
    const config = createMinimalConfig();
    const result = applyDefaults(config);

    expect(result.connectorUrl).toBe(config.connectorUrl);
    expect(result.secretKey).toBe(config.secretKey);
    expect(result.ilpInfo).toBe(config.ilpInfo);
    expect(result.toonEncoder).toBe(config.toonEncoder);
    expect(result.toonDecoder).toBe(config.toonDecoder);
  });

  it('should derive evmPrivateKey from secretKey when not provided', () => {
    const config = createMinimalConfig();
    const result = applyDefaults(config);

    // evmPrivateKey should be the same Uint8Array as secretKey
    expect(result.evmPrivateKey).toBe(config.secretKey);
  });

  it('should preserve explicit evmPrivateKey when provided', () => {
    const config = createMinimalConfig();
    const explicitKey = '0x' + 'ab'.repeat(32);
    config.evmPrivateKey = explicitKey;
    const result = applyDefaults(config);

    expect(result.evmPrivateKey).toBe(explicitKey);
  });

  it('should derive evmPrivateKey from auto-generated secretKey when both omitted', () => {
    const config = createMinimalConfig();
    config.secretKey = undefined;
    const result = applyDefaults(config);

    // Both should be auto-generated, and evmPrivateKey should be the same key
    expect(result.secretKey).toHaveLength(32);
    expect(result.evmPrivateKey).toBe(result.secretKey);
  });

  describe('connector-proxy (devnet) derivation', () => {
    const proxyConfig = (proxyUrl: string): ToonClientConfig => {
      const c = createMinimalConfig();
      delete (c as { connectorUrl?: string }).connectorUrl;
      return { ...c, proxyUrl, destinationAddress: 'g.proxy' };
    };

    it('derives connectorHttpEndpoint (POST /ilp) from proxyUrl', () => {
      const result = applyDefaults(
        proxyConfig('https://proxy.devnet.toonprotocol.dev')
      );
      expect(result.connectorHttpEndpoint).toBe(
        'https://proxy.devnet.toonprotocol.dev/ilp'
      );
    });

    it('does NOT auto-derive a btpUrl when an HTTP/proxy transport is set', () => {
      const result = applyDefaults(
        proxyConfig('https://proxy.devnet.toonprotocol.dev')
      );
      expect(result.btpUrl).toBeUndefined();
    });

    it('satisfies connectorUrl from the proxy base when connectorUrl is unset', () => {
      const result = applyDefaults(
        proxyConfig('https://proxy.devnet.toonprotocol.dev/')
      );
      expect(result.connectorUrl).toBe(
        'https://proxy.devnet.toonprotocol.dev'
      );
    });

    it('lets an explicit connectorHttpEndpoint win over proxyUrl derivation', () => {
      const result = applyDefaults({
        ...proxyConfig('https://proxy.devnet.toonprotocol.dev'),
        connectorHttpEndpoint: 'https://explicit.example/ilp',
      });
      expect(result.connectorHttpEndpoint).toBe('https://explicit.example/ilp');
    });
  });
});

describe('proxyIlpEndpoint', () => {
  it('appends /ilp to a bare base URL', () => {
    expect(proxyIlpEndpoint('https://proxy.example')).toBe(
      'https://proxy.example/ilp'
    );
  });
  it('is idempotent when the URL already ends in /ilp', () => {
    expect(proxyIlpEndpoint('https://proxy.example/ilp')).toBe(
      'https://proxy.example/ilp'
    );
  });
  it('strips a trailing slash before appending', () => {
    expect(proxyIlpEndpoint('https://proxy.example/')).toBe(
      'https://proxy.example/ilp'
    );
  });
  it('returns undefined for empty input', () => {
    expect(proxyIlpEndpoint(undefined)).toBeUndefined();
    expect(proxyIlpEndpoint('')).toBeUndefined();
  });
});

describe('buildSettlementInfo', () => {
  const createConfig = (
    overrides: Partial<ToonClientConfig> = {}
  ): ToonClientConfig => ({
    connectorUrl: 'http://localhost:8080',
    ilpInfo: {
      ilpAddress: 'g.test',
      btpEndpoint: 'ws://test',
      pubkey: 'abc',
      assetCode: 'USD',
      assetScale: 6,
    },
    toonEncoder: () => new Uint8Array(0),
    toonDecoder: () => ({
      id: '',
      pubkey: '',
      created_at: 0,
      kind: 1,
      tags: [],
      content: '',
      sig: '',
    }),
    ...overrides,
  });

  it('should return undefined when no settlement config present', () => {
    const config = createConfig();
    expect(buildSettlementInfo(config)).toBeUndefined();
  });

  it('should produce correct ClientSettlementInfo', () => {
    const config = createConfig({
      supportedChains: ['evm:anvil:31337'],
      settlementAddresses: { 'evm:anvil:31337': '0xabc' },
      preferredTokens: { 'evm:anvil:31337': '0xtoken' },
      tokenNetworks: { 'evm:anvil:31337': '0xtokennet' },
    });

    const info = buildSettlementInfo(config);

    expect(info).toBeDefined();
    expect(info!.ilpAddress).toBe('g.test');
    expect(info!.supportedChains).toEqual(['evm:anvil:31337']);
    expect(info!.settlementAddresses).toEqual({ 'evm:anvil:31337': '0xabc' });
    expect(info!.preferredTokens).toEqual({ 'evm:anvil:31337': '0xtoken' });
    expect(info!.tokenNetworks).toEqual({ 'evm:anvil:31337': '0xtokennet' });
  });

  it('should include ilpAddress from config', () => {
    const config = createConfig({
      supportedChains: ['evm:anvil:31337'],
    });

    const info = buildSettlementInfo(config);
    expect(info!.ilpAddress).toBe('g.test');
  });
});

describe('network targeting (#202)', () => {
  const baseConfig = (
    overrides: Partial<ToonClientConfig> = {}
  ): ToonClientConfig => {
    const secretKey = generateSecretKey();
    const pubkey = getPublicKey(secretKey);
    return {
      connectorUrl: 'http://localhost:8080',
      secretKey,
      ilpInfo: {
        pubkey,
        ilpAddress: 'g.test.address',
        btpEndpoint: 'ws://localhost:3000',
        assetCode: 'USD',
        assetScale: 6,
      },
      toonEncoder: () => new Uint8Array(0),
      toonDecoder: () => ({
        id: '',
        pubkey: '',
        created_at: 0,
        kind: 1,
        tags: [],
        content: '',
        sig: '',
      }),
      ...overrides,
    };
  };

  describe('applyNetworkPresets — tier resolution', () => {
    it('testnet resolves Base Sepolia + current (corrected) TokenNetwork', () => {
      const c = applyNetworkPresets(baseConfig({ network: 'testnet' }));
      const evmId = 'evm:base:84532';
      expect(c.supportedChains).toContain(evmId);
      // core >=3.1.2 bakes the working publicnode RPC (the old sepolia.base.org
      // LB failed openChannel on stale reads).
      expect(c.chainRpcUrls?.[evmId]).toBe(
        'https://base-sepolia-rpc.publicnode.com'
      );
      // Current public Base Sepolia settlement addresses, sourced directly
      // from the @toon-protocol/core base-sepolia preset.
      expect(c.tokenNetworks?.[evmId]).toBe(
        '0x1E95493fEF46707E034b4a1945f25a8C76A1823D'
      );
      expect(c.preferredTokens?.[evmId]).toBe(
        '0x49beE1Bca5d15Fb0963117923403F9498119a9Ce'
      );
    });

    it('devnet emits the current Base Sepolia addresses (no stale 18-decimal token leaks)', () => {
      const c = applyNetworkPresets(baseConfig({ network: 'devnet' }));
      const evmId = 'evm:base:84532';
      expect(c.preferredTokens?.[evmId]).toBe(
        '0x49beE1Bca5d15Fb0963117923403F9498119a9Ce'
      );
      expect(c.tokenNetworks?.[evmId]).toBe(
        '0x1E95493fEF46707E034b4a1945f25a8C76A1823D'
      );
      // The retired 18-decimal mock USDC / old TokenNetwork must NOT leak through.
      expect(c.preferredTokens?.[evmId]).not.toBe(
        '0xac80670b86db1eeb5c18c82e18a6bda98fcb4504'
      );
      expect(c.tokenNetworks?.[evmId]).not.toBe(
        '0x47616F4b9cF4dA25F74FD727Cd85E9CA0C70Ec5C'
      );
    });

    it('devnet resolves the deployed Solana program + Mina zkApp channels', () => {
      const c = applyNetworkPresets(baseConfig({ network: 'devnet' }));
      expect(c.supportedChains).toContain('solana:devnet');
      expect(c.supportedChains).toContain('mina:devnet');
      // Live public Solana devnet payment-channel program, sourced from the
      // @toon-protocol/core (>=3.1.1) devnet preset (corrected: the pre-3.1.1
      // preset carried the retired localhost-validator program EdJxYPD…).
      expect(c.solanaChannel?.programId).toBe(
        '2aEVJ8koKD8LTZrLRSGtAtU7LBt4e7QjjCgf1kzQ7Rip'
      );
      expect(c.solanaChannel?.rpcUrl).toBe('https://api.devnet.solana.com');
      // core >=3.1.2 corrected the Mina preset to the live devnet zkApp + added
      // the token id (the pre-3.1.2 preset carried the retired B62qrH1As4… and
      // no token id).
      expect(c.minaChannel?.zkAppAddress).toBe(
        'B62qmgPhv2Xo6QVEtwjLja8UZJUtu8yapRFAR6gaoGtbM9zE5hG7Tkf'
      );
      expect(c.minaChannel?.zkAppAddress).not.toBe(
        'B62qrH1As4odHiNyKpTZMHaM6tRs6gi5DJ53efZKQBtbaR5CUctbDs6'
      );
      expect(c.minaChannel?.tokenId).toBe(
        '9497120696276615621907376728658022802954262638363646162765282600447713419198'
      );
      expect(c.minaChannel?.networkId).toBe('devnet');
    });

    it('mainnet resolves Base mainnet but no settlement contracts (relay-only)', () => {
      const c = applyNetworkPresets(baseConfig({ network: 'mainnet' }));
      const evmId = 'evm:base:8453';
      expect(c.chainRpcUrls?.[evmId]).toBe('https://mainnet.base.org');
      expect(c.tokenNetworks?.[evmId]).toBeUndefined();
      expect(c.solanaChannel).toBeUndefined();
      expect(c.minaChannel).toBeUndefined();
    });
  });

  describe('explicit overrides win over the preset', () => {
    it('explicit chainRpcUrls / tokenNetworks override the preset value', () => {
      const evmId = 'evm:base:84532';
      const c = applyNetworkPresets(
        baseConfig({
          network: 'testnet',
          chainRpcUrls: { [evmId]: 'https://my-rpc.example' },
          tokenNetworks: { [evmId]: '0xOVERRIDE' },
        })
      );
      expect(c.chainRpcUrls?.[evmId]).toBe('https://my-rpc.example');
      expect(c.tokenNetworks?.[evmId]).toBe('0xOVERRIDE');
      // Untouched preset fields still present (corrected USDC, not the stale one).
      expect(c.preferredTokens?.[evmId]).toBe(
        '0x49beE1Bca5d15Fb0963117923403F9498119a9Ce'
      );
    });

    it('explicit solanaChannel object replaces the preset wholesale', () => {
      const c = applyNetworkPresets(
        baseConfig({
          network: 'devnet',
          solanaChannel: {
            rpcUrl: 'https://custom-sol.example',
            programId: 'CustomProgram111',
          },
        })
      );
      expect(c.solanaChannel?.programId).toBe('CustomProgram111');
      expect(c.solanaChannel?.rpcUrl).toBe('https://custom-sol.example');
    });

    it('explicit supportedChains are unioned with the preset (extras preserved)', () => {
      const c = applyNetworkPresets(
        baseConfig({
          network: 'testnet',
          supportedChains: ['evm:anvil:31337'],
        })
      );
      expect(c.supportedChains).toContain('evm:anvil:31337');
      expect(c.supportedChains).toContain('evm:base:84532');
    });
  });

  describe('custom and unset are the fully-manual path (backward compat)', () => {
    it('network: custom passes config through untouched', () => {
      const input = baseConfig({
        network: 'custom',
        supportedChains: ['evm:base:31337'],
        tokenNetworks: { 'evm:base:31337': '0xTN' },
      });
      const c = applyNetworkPresets(input);
      expect(c).toBe(input); // no copy, no preset merge
      expect(c.chainRpcUrls).toBeUndefined();
    });

    it('unset network passes config through untouched', () => {
      const input = baseConfig({ supportedChains: ['evm:base:31337'] });
      const c = applyNetworkPresets(input);
      expect(c).toBe(input);
    });

    it('applyDefaults with no network leaves settlement fields untouched', () => {
      const resolved = applyDefaults(baseConfig());
      expect(resolved.supportedChains).toBeUndefined();
      expect(resolved.chainRpcUrls).toBeUndefined();
      expect(resolved.tokenNetworks).toBeUndefined();
    });
  });

  describe('applyDefaults + buildSettlementInfo wire the preset through', () => {
    it('applyDefaults(network: testnet) fills the resolved settlement maps', () => {
      const resolved = applyDefaults(baseConfig({ network: 'testnet' }));
      expect(resolved.supportedChains).toContain('evm:base:84532');
      expect(resolved.tokenNetworks?.['evm:base:84532']).toBe(
        '0x1E95493fEF46707E034b4a1945f25a8C76A1823D'
      );
      expect(resolved.network).toBe('testnet');
    });

    it('buildSettlementInfo(network: testnet) produces settlement info from the preset', () => {
      const info = buildSettlementInfo(baseConfig({ network: 'testnet' }));
      expect(info).toBeDefined();
      expect(info!.supportedChains).toContain('evm:base:84532');
      expect(info!.tokenNetworks?.['evm:base:84532']).toBe(
        '0x1E95493fEF46707E034b4a1945f25a8C76A1823D'
      );
    });

    it('buildSettlementInfo(network: custom) with no manual config returns undefined', () => {
      const info = buildSettlementInfo(baseConfig({ network: 'custom' }));
      expect(info).toBeUndefined();
    });
  });

  describe('getNetworkStatus', () => {
    it('reports testnet EVM configured (deployed contracts)', () => {
      const status = getNetworkStatus(baseConfig({ network: 'testnet' }));
      expect(status?.evm).toBe('configured');
    });

    it('reports devnet Solana + Mina configured', () => {
      const status = getNetworkStatus(baseConfig({ network: 'devnet' }));
      expect(status?.solana).toBe('configured');
      expect(status?.mina).toBe('configured');
    });

    it('reports mainnet all unconfigured (no TOON contracts yet)', () => {
      const status = getNetworkStatus(baseConfig({ network: 'mainnet' }));
      expect(status).toEqual({
        evm: 'unconfigured',
        solana: 'unconfigured',
        mina: 'unconfigured',
      });
    });

    it('returns undefined for custom / unset', () => {
      expect(
        getNetworkStatus(baseConfig({ network: 'custom' }))
      ).toBeUndefined();
      expect(getNetworkStatus(baseConfig())).toBeUndefined();
    });
  });
});
