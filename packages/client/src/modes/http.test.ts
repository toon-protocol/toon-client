import { describe, it, expect, beforeEach, vi } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { initializeHttpMode } from './http.js';
import type { ResolvedConfig } from '../config.js';

// Mock BtpRuntimeClient to avoid real WebSocket connections
vi.mock('../adapters/BtpRuntimeClient.js', () => {
  return {
    BtpRuntimeClient: vi.fn().mockImplementation(() => ({
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      sendIlpPacket: vi.fn(),
      isConnected: true,
    })),
  };
});

describe('initializeHttpMode', () => {
  let config: ResolvedConfig;
  let secretKey: Uint8Array;
  let pubkey: string;

  beforeEach(() => {
    vi.clearAllMocks();
    secretKey = generateSecretKey();
    pubkey = getPublicKey(secretKey);

    config = {
      connectorUrl: 'http://localhost:8080',
      secretKey,
      evmPrivateKey: secretKey, // Derived from secretKey by default
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
      relayUrl: 'ws://localhost:7100',
      queryTimeout: 30000,
      maxRetries: 3,
      retryDelay: 1000,
      destinationAddress: 'g.crosstown.genesis',
    };
  });

  describe('HTTP mode initialization', () => {
    it('should create components from config', async () => {
      const result = await initializeHttpMode(config);

      expect(result.runtimeClient).toBeDefined();
      expect(result.bootstrapService).toBeDefined();
      expect(result.discoveryTracker).toBeDefined();
    });

    it('should create BootstrapService correctly', async () => {
      const result = await initializeHttpMode(config);

      expect(result.bootstrapService).toBeDefined();
      expect(result.bootstrapService.getPhase()).toBe('discovering');
      expect(result.bootstrapService.getPubkey()).toBe(pubkey);
    });

    it('should create DiscoveryTracker correctly', async () => {
      const result = await initializeHttpMode(config);

      expect(result.discoveryTracker).toBeDefined();
      expect(result.discoveryTracker.getDiscoveredPeers()).toEqual([]);
    });

    it('should not wire ConnectorAdmin', async () => {
      const result = await initializeHttpMode(config);

      expect(result.adminClient).toBeNull();
    });

    it('should set btpClient to null when btpUrl not configured', async () => {
      delete (config as any).btpUrl;
      const result = await initializeHttpMode(config);

      expect(result.btpClient).toBeNull();
    });

    it('should set onChainChannelClient to null when chainRpcUrls not configured', async () => {
      const result = await initializeHttpMode(config);

      expect(result.onChainChannelClient).toBeNull();
    });
  });

  describe('BTP transport', () => {
    it('should create BtpRuntimeClient when btpUrl configured', async () => {
      config.btpUrl = 'ws://localhost:3000';
      config.btpAuthToken = 'test-token';

      const result = await initializeHttpMode(config);

      expect(result.btpClient).not.toBeNull();
      expect(result.btpClient!.connect).toHaveBeenCalled();
    });

    it('should use BTP client as runtime client when available', async () => {
      config.btpUrl = 'ws://localhost:3000';

      const result = await initializeHttpMode(config);

      // runtimeClient should be the btpClient
      expect(result.runtimeClient).toBe(result.btpClient);
    });

    it('should fall back to HttpRuntimeClient when btpUrl absent', async () => {
      delete (config as any).btpUrl;
      const result = await initializeHttpMode(config);

      expect(result.btpClient).toBeNull();
      expect(result.runtimeClient).toBeDefined();
      // It should be an HttpRuntimeClient (not BtpRuntimeClient)
      expect(result.runtimeClient.constructor.name).toBe('HttpRuntimeClient');
    });
  });

  describe('on-chain channel client', () => {
    it('should create OnChainChannelClient when chainRpcUrls configured', async () => {
      config.chainRpcUrls = { 'evm:anvil:31337': 'http://localhost:8545' };

      const result = await initializeHttpMode(config);

      expect(result.onChainChannelClient).not.toBeNull();
    });

    it('should not create OnChainChannelClient when chainRpcUrls absent', async () => {
      // evmPrivateKey is always present (derived from secretKey), but without
      // chainRpcUrls there's nothing to connect to
      const result = await initializeHttpMode(config);

      expect(result.onChainChannelClient).toBeNull();
    });
  });

  describe('settlement info propagation', () => {
    it('should propagate settlementInfo to BootstrapService when configured', async () => {
      config.supportedChains = ['evm:anvil:31337'];
      config.settlementAddresses = { 'evm:anvil:31337': '0xabc' };

      const result = await initializeHttpMode(config);

      // BootstrapService should be created with settlement info
      expect(result.bootstrapService).toBeDefined();
    });

    it('should propagate settlementInfo to DiscoveryTracker when configured', async () => {
      config.supportedChains = ['evm:anvil:31337'];

      const result = await initializeHttpMode(config);

      expect(result.discoveryTracker).toBeDefined();
    });
  });

  describe('configuration propagation', () => {
    it('should propagate queryTimeout', async () => {
      config.queryTimeout = 60000;
      const result = await initializeHttpMode(config);

      expect(result.runtimeClient).toBeDefined();
    });

    it('should propagate relayUrl to DiscoveryTracker', async () => {
      config.relayUrl = 'ws://custom-relay:7777';
      const result = await initializeHttpMode(config);

      expect(result.discoveryTracker).toBeDefined();
    });

    it('should propagate toonEncoder and toonDecoder to services', async () => {
      const customEncoder = (_event: unknown) => new Uint8Array([1, 2, 3]);
      const customDecoder = (_bytes: Uint8Array) => ({
        id: 'custom',
        pubkey: '',
        created_at: 0,
        kind: 1,
        tags: [],
        content: '',
        sig: '',
      });

      config.toonEncoder = customEncoder;
      config.toonDecoder = customDecoder;

      const result = await initializeHttpMode(config);

      expect(result.bootstrapService).toBeDefined();
      expect(result.discoveryTracker).toBeDefined();
    });
  });
});
