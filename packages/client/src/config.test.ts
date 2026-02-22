import { describe, it, expect } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { validateConfig, applyDefaults } from './config.js';
import { ValidationError } from './errors.js';
import type { CrosstownClientConfig } from './types.js';

describe('validateConfig', () => {
  // Helper to create minimal valid config
  const createValidConfig = (overrides: Partial<CrosstownClientConfig> = {}): CrosstownClientConfig => {
    const secretKey = generateSecretKey();
    const pubkey = getPublicKey(secretKey);
    return {
      connectorUrl: 'http://localhost:8080',
      secretKey,
      ilpInfo: {
        pubkey,
        ilpAddress: 'g.test.address',
        btpEndpoint: 'ws://localhost:3000',
      },
      toonEncoder: (event) => new Uint8Array(0),
      toonDecoder: (bytes) => ({
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
      expect(() => validateConfig(config)).toThrow('Embedded mode not yet implemented');
    });

    it('should throw error with explicit message for embedded mode', () => {
      const config = createValidConfig({ connector: { some: 'value' } as unknown });

      expect(() => validateConfig(config)).toThrow(
        'Embedded mode not yet implemented in CrosstownClient. Use connectorUrl for HTTP mode.'
      );
    });
  });

  describe('connectorUrl validation (AC: 4)', () => {
    it('should throw error when connectorUrl is missing', () => {
      const config = createValidConfig({ connectorUrl: undefined });

      expect(() => validateConfig(config)).toThrow(ValidationError);
      expect(() => validateConfig(config)).toThrow('connectorUrl is required');
    });

    it('should throw error with example when connectorUrl is missing', () => {
      const config = createValidConfig({ connectorUrl: undefined });

      expect(() => validateConfig(config)).toThrow(
        'connectorUrl is required for HTTP mode. Example: "http://localhost:8080"'
      );
    });

    it('should accept valid HTTP connectorUrl', () => {
      const config = createValidConfig({ connectorUrl: 'http://localhost:8080' });

      expect(() => validateConfig(config)).not.toThrow();
    });

    it('should accept valid HTTPS connectorUrl', () => {
      const config = createValidConfig({ connectorUrl: 'https://connector.example.com' });

      expect(() => validateConfig(config)).not.toThrow();
    });

    it('should throw error for non-HTTP/HTTPS URL', () => {
      const config = createValidConfig({ connectorUrl: 'ws://localhost:8080' });

      expect(() => validateConfig(config)).toThrow(ValidationError);
      expect(() => validateConfig(config)).toThrow('must be a valid HTTP/HTTPS URL');
    });

    it('should throw error for invalid URL format', () => {
      const config = createValidConfig({ connectorUrl: 'not-a-url' });

      expect(() => validateConfig(config)).toThrow(ValidationError);
      expect(() => validateConfig(config)).toThrow('must be a valid HTTP/HTTPS URL');
    });
  });

  describe('secretKey validation', () => {
    it('should throw error when secretKey is missing', () => {
      const config = createValidConfig({ secretKey: undefined as any });

      expect(() => validateConfig(config)).toThrow(ValidationError);
      expect(() => validateConfig(config)).toThrow('secretKey must be 32 bytes');
    });

    it('should throw error when secretKey is not 32 bytes', () => {
      const config = createValidConfig({ secretKey: new Uint8Array(16) });

      expect(() => validateConfig(config)).toThrow(ValidationError);
      expect(() => validateConfig(config)).toThrow('secretKey must be 32 bytes');
    });

    it('should accept 32-byte secretKey', () => {
      const secretKey = generateSecretKey();
      const pubkey = getPublicKey(secretKey);
      const config = createValidConfig({ secretKey, ilpInfo: { pubkey, ilpAddress: 'g.test', btpEndpoint: 'ws://test' } });

      expect(() => validateConfig(config)).not.toThrow();
    });
  });

  describe('ilpInfo validation', () => {
    it('should throw error when ilpInfo is missing', () => {
      const config = createValidConfig({ ilpInfo: undefined as any });

      expect(() => validateConfig(config)).toThrow(ValidationError);
      expect(() => validateConfig(config)).toThrow('ilpInfo.ilpAddress is required');
    });

    it('should throw error when ilpInfo.ilpAddress is missing', () => {
      const secretKey = generateSecretKey();
      const pubkey = getPublicKey(secretKey);
      const config = createValidConfig({
        secretKey,
        ilpInfo: { ilpAddress: '', btpEndpoint: 'ws://test', pubkey },
      });

      expect(() => validateConfig(config)).toThrow(ValidationError);
      expect(() => validateConfig(config)).toThrow('ilpInfo.ilpAddress is required');
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
        },
      });

      expect(() => validateConfig(config)).not.toThrow();
    });
  });

  describe('TOON encoder/decoder validation', () => {
    it('should throw error when toonEncoder is missing', () => {
      const config = createValidConfig({ toonEncoder: undefined as any });

      expect(() => validateConfig(config)).toThrow(ValidationError);
      expect(() => validateConfig(config)).toThrow('toonEncoder function is required');
    });

    it('should throw error when toonEncoder is not a function', () => {
      const config = createValidConfig({ toonEncoder: 'not-a-function' as any });

      expect(() => validateConfig(config)).toThrow(ValidationError);
      expect(() => validateConfig(config)).toThrow('toonEncoder function is required');
    });

    it('should throw error when toonDecoder is missing', () => {
      const config = createValidConfig({ toonDecoder: undefined as any });

      expect(() => validateConfig(config)).toThrow(ValidationError);
      expect(() => validateConfig(config)).toThrow('toonDecoder function is required');
    });

    it('should throw error when toonDecoder is not a function', () => {
      const config = createValidConfig({ toonDecoder: 'not-a-function' as any });

      expect(() => validateConfig(config)).toThrow(ValidationError);
      expect(() => validateConfig(config)).toThrow('toonDecoder function is required');
    });

    it('should accept valid toonEncoder and toonDecoder', () => {
      const config = createValidConfig({
        toonEncoder: (event) => new Uint8Array(0),
        toonDecoder: (bytes) => ({
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
});

describe('applyDefaults', () => {
  const createMinimalConfig = (): CrosstownClientConfig => {
    const secretKey = generateSecretKey();
    const pubkey = getPublicKey(secretKey);
    return {
      connectorUrl: 'http://localhost:8080',
      secretKey,
      ilpInfo: {
        pubkey,
        ilpAddress: 'g.test.address',
        btpEndpoint: 'ws://localhost:3000',
      },
      toonEncoder: (event) => new Uint8Array(0),
      toonDecoder: (bytes) => ({
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

  it('should apply default relayUrl', () => {
    const config = createMinimalConfig();
    const result = applyDefaults(config);

    expect(result.relayUrl).toBe('ws://localhost:7100');
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
});
