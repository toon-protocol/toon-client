import { describe, it, expect, vi } from 'vitest';
import { HttpConnectorAdmin } from './HttpConnectorAdmin.js';
import {
  ValidationError,
  NetworkError,
  UnauthorizedError,
  PeerNotFoundError,
  PeerAlreadyExistsError,
  ConnectorError,
} from '../errors.js';

// Type for mocked fetch function
type MockFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

describe('HttpConnectorAdmin', () => {
  const mockPeerConfig = {
    id: 'nostr-abc123',
    url: 'btp+ws://alice.example.com:3000',
    authToken: 'secret-token-abc123',
    routes: [{ prefix: 'g.crosstown.alice', priority: 1 }],
    settlement: {
      preference: 'raiden',
      evmAddress: '0x1234567890abcdef',
      tokenNetworkAddress: '0xabcdef1234567890',
      chainId: 84532,
    },
  };

  describe('constructor', () => {
    it('should remove trailing slash from adminUrl', () => {
      const mockFetch = vi.fn();
      const admin = new HttpConnectorAdmin({
        adminUrl: 'http://localhost:8081/',
        httpClient: mockFetch as unknown as MockFetch,
      });

      expect(admin).toBeDefined();
    });

    it('should use default timeout if not provided', () => {
      const admin = new HttpConnectorAdmin({
        adminUrl: 'http://localhost:8081',
      });

      expect(admin).toBeDefined();
    });
  });

  describe('addPeer', () => {
    it('should add peer successfully (201 Created)', async () => {
      // Arrange
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
      });

      const admin = new HttpConnectorAdmin({
        adminUrl: 'http://localhost:8081',
        httpClient: mockFetch as unknown as MockFetch,
      });

      // Act
      await admin.addPeer(mockPeerConfig);

      // Assert - URL should have btp+ prefix stripped
      const expectedConfig = {
        ...mockPeerConfig,
        url: 'ws://alice.example.com:3000', // btp+ prefix stripped
      };
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8081/admin/peers',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(expectedConfig),
        })
      );
    });

    it('should add peer with minimal config (no routes/settlement)', async () => {
      // Arrange
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
      });

      const admin = new HttpConnectorAdmin({
        adminUrl: 'http://localhost:8081',
        httpClient: mockFetch as unknown as MockFetch,
      });

      const minimalConfig = {
        id: 'nostr-xyz',
        url: 'btp+wss://bob.example.com:3000',
        authToken: 'token-xyz',
      };

      // Act
      await admin.addPeer(minimalConfig);

      // Assert - URL should have btp+ prefix stripped
      const expectedConfig = {
        ...minimalConfig,
        url: 'wss://bob.example.com:3000', // btp+ prefix stripped
      };
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8081/admin/peers',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify(expectedConfig),
        })
      );
    });

    it('should throw PeerAlreadyExistsError on duplicate peer (409 Conflict)', async () => {
      // Arrange
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        statusText: 'Conflict',
        text: vi.fn().mockResolvedValue('Peer already exists'),
      });

      const admin = new HttpConnectorAdmin({
        adminUrl: 'http://localhost:8081',
        httpClient: mockFetch as unknown as MockFetch,
      });

      // Act & Assert
      await expect(admin.addPeer(mockPeerConfig)).rejects.toThrow(PeerAlreadyExistsError);
      await expect(admin.addPeer(mockPeerConfig)).rejects.toThrow(
        /Peer already exists.*nostr-abc123/
      );
    });

    it('should throw ValidationError on invalid id (empty string)', async () => {
      const mockFetch = vi.fn();
      const admin = new HttpConnectorAdmin({
        adminUrl: 'http://localhost:8081',
        httpClient: mockFetch as unknown as MockFetch,
      });

      await expect(
        admin.addPeer({ ...mockPeerConfig, id: '' })
      ).rejects.toThrow(ValidationError);

      await expect(
        admin.addPeer({ ...mockPeerConfig, id: '   ' })
      ).rejects.toThrow(ValidationError);

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should throw ValidationError on invalid url (empty string)', async () => {
      const mockFetch = vi.fn();
      const admin = new HttpConnectorAdmin({
        adminUrl: 'http://localhost:8081',
        httpClient: mockFetch as unknown as MockFetch,
      });

      await expect(
        admin.addPeer({ ...mockPeerConfig, url: '' })
      ).rejects.toThrow(ValidationError);

      await expect(
        admin.addPeer({ ...mockPeerConfig, url: '   ' })
      ).rejects.toThrow(ValidationError);

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should throw ValidationError on invalid url (wrong format)', async () => {
      const mockFetch = vi.fn();
      const admin = new HttpConnectorAdmin({
        adminUrl: 'http://localhost:8081',
        httpClient: mockFetch as unknown as MockFetch,
      });

      // http:// is invalid (not a WebSocket protocol)
      await expect(
        admin.addPeer({ ...mockPeerConfig, url: 'http://example.com' })
      ).rejects.toThrow(ValidationError);

      // ftp:// is invalid
      await expect(
        admin.addPeer({ ...mockPeerConfig, url: 'ftp://example.com' })
      ).rejects.toThrow(ValidationError);

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should accept valid BTP URLs (btp+ws://, btp+wss://, ws://, wss://)', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
      });

      const admin = new HttpConnectorAdmin({
        adminUrl: 'http://localhost:8081',
        httpClient: mockFetch as unknown as MockFetch,
      });

      // Accept URLs with btp+ prefix
      await admin.addPeer({ ...mockPeerConfig, url: 'btp+ws://example.com:3000' });
      await admin.addPeer({ ...mockPeerConfig, url: 'btp+wss://example.com:3000' });

      // Also accept plain WebSocket URLs (without btp+ prefix)
      await admin.addPeer({ ...mockPeerConfig, url: 'ws://example.com:3000' });
      await admin.addPeer({ ...mockPeerConfig, url: 'wss://example.com:3000' });

      expect(mockFetch).toHaveBeenCalledTimes(4);
    });

    it('should throw ValidationError on invalid authToken type', async () => {
      const mockFetch = vi.fn();
      const admin = new HttpConnectorAdmin({
        adminUrl: 'http://localhost:8081',
        httpClient: mockFetch as unknown as MockFetch,
      });

      // authToken can be empty string (for no auth), but must be a string
      await expect(
        admin.addPeer({ ...mockPeerConfig, authToken: undefined as any })
      ).rejects.toThrow(ValidationError);

      await expect(
        admin.addPeer({ ...mockPeerConfig, authToken: null as any })
      ).rejects.toThrow(ValidationError);

      await expect(
        admin.addPeer({ ...mockPeerConfig, authToken: 123 as any })
      ).rejects.toThrow(ValidationError);

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should throw ValidationError on invalid routes (not an array)', async () => {
      const mockFetch = vi.fn();
      const admin = new HttpConnectorAdmin({
        adminUrl: 'http://localhost:8081',
        httpClient: mockFetch as unknown as MockFetch,
      });

      await expect(
        admin.addPeer({ ...mockPeerConfig, routes: 'invalid' as unknown as MockFetch })
      ).rejects.toThrow(ValidationError);

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should throw ValidationError on invalid route prefix', async () => {
      const mockFetch = vi.fn();
      const admin = new HttpConnectorAdmin({
        adminUrl: 'http://localhost:8081',
        httpClient: mockFetch as unknown as MockFetch,
      });

      await expect(
        admin.addPeer({ ...mockPeerConfig, routes: [{ prefix: '' }] })
      ).rejects.toThrow(ValidationError);

      await expect(
        admin.addPeer({ ...mockPeerConfig, routes: [{ prefix: '   ' }] })
      ).rejects.toThrow(ValidationError);

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should throw ValidationError on invalid route priority', async () => {
      const mockFetch = vi.fn();
      const admin = new HttpConnectorAdmin({
        adminUrl: 'http://localhost:8081',
        httpClient: mockFetch as unknown as MockFetch,
      });

      await expect(
        admin.addPeer({ ...mockPeerConfig, routes: [{ prefix: 'g.test', priority: 'high' as unknown as MockFetch }] })
      ).rejects.toThrow(ValidationError);

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should throw ValidationError on invalid settlement (not an object)', async () => {
      const mockFetch = vi.fn();
      const admin = new HttpConnectorAdmin({
        adminUrl: 'http://localhost:8081',
        httpClient: mockFetch as unknown as MockFetch,
      });

      await expect(
        admin.addPeer({ ...mockPeerConfig, settlement: 'invalid' as unknown as MockFetch })
      ).rejects.toThrow(ValidationError);

      await expect(
        admin.addPeer({ ...mockPeerConfig, settlement: null as unknown as MockFetch })
      ).rejects.toThrow(ValidationError);

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should throw ValidationError on missing settlement preference', async () => {
      const mockFetch = vi.fn();
      const admin = new HttpConnectorAdmin({
        adminUrl: 'http://localhost:8081',
        httpClient: mockFetch as unknown as MockFetch,
      });

      await expect(
        admin.addPeer({ ...mockPeerConfig, settlement: {} as unknown as MockFetch })
      ).rejects.toThrow(ValidationError);

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should throw NetworkError on connection refused', async () => {
      // Arrange
      const networkError = new Error('fetch failed');
      Object.assign(networkError, { message: 'ECONNREFUSED' });

      const mockFetch = vi.fn().mockRejectedValue(networkError);

      const admin = new HttpConnectorAdmin({
        adminUrl: 'http://localhost:8081',
        maxRetries: 0,  // Disable retries for faster test
        httpClient: mockFetch as unknown as MockFetch,
      });

      // Act & Assert
      await expect(admin.addPeer(mockPeerConfig)).rejects.toThrow(NetworkError);
      await expect(admin.addPeer(mockPeerConfig)).rejects.toThrow(/Failed to connect/);
    });

    it('should throw NetworkError on timeout', async () => {
      // Arrange
      const timeoutError = new Error('Timeout');
      Object.assign(timeoutError, { name: 'AbortError' });

      const mockFetch = vi.fn().mockRejectedValue(timeoutError);

      const admin = new HttpConnectorAdmin({
        adminUrl: 'http://localhost:8081',
        timeout: 5000,
        maxRetries: 0,  // Disable retries for faster test
        httpClient: mockFetch as unknown as MockFetch,
      });

      // Act & Assert
      await expect(admin.addPeer(mockPeerConfig)).rejects.toThrow(NetworkError);
      await expect(admin.addPeer(mockPeerConfig)).rejects.toThrow(/timed out after 5000ms/);
    });

    it('should throw UnauthorizedError on 401', async () => {
      // Arrange
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: vi.fn().mockResolvedValue('Invalid credentials'),
      });

      const admin = new HttpConnectorAdmin({
        adminUrl: 'http://localhost:8081',
        httpClient: mockFetch as unknown as MockFetch,
      });

      // Act & Assert
      await expect(admin.addPeer(mockPeerConfig)).rejects.toThrow(UnauthorizedError);
      await expect(admin.addPeer(mockPeerConfig)).rejects.toThrow(/authentication failed/);
    });

    it('should throw ConnectorError on 5xx server error', async () => {
      // Arrange
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: vi.fn().mockResolvedValue('Database connection failed'),
      });

      const admin = new HttpConnectorAdmin({
        adminUrl: 'http://localhost:8081',
        httpClient: mockFetch as unknown as MockFetch,
      });

      // Act & Assert
      await expect(admin.addPeer(mockPeerConfig)).rejects.toThrow(ConnectorError);
      await expect(admin.addPeer(mockPeerConfig)).rejects.toThrow(/500/);
    });

    it('should normalize adminUrl with trailing slash', async () => {
      // Arrange
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
      });

      const admin = new HttpConnectorAdmin({
        adminUrl: 'http://localhost:8081/',
        httpClient: mockFetch as unknown as MockFetch,
      });

      // Act
      await admin.addPeer(mockPeerConfig);

      // Assert
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8081/admin/peers',
        expect.anything()
      );
    });
  });

  describe('removePeer', () => {
    it('should remove peer successfully (204 No Content)', async () => {
      // Arrange
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 204,
      });

      const admin = new HttpConnectorAdmin({
        adminUrl: 'http://localhost:8081',
        httpClient: mockFetch as unknown as MockFetch,
      });

      // Act
      await admin.removePeer('nostr-abc123');

      // Assert
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8081/admin/peers/nostr-abc123',
        expect.objectContaining({
          method: 'DELETE',
        })
      );
    });

    it('should URL-encode peerId', async () => {
      // Arrange
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 204,
      });

      const admin = new HttpConnectorAdmin({
        adminUrl: 'http://localhost:8081',
        httpClient: mockFetch as unknown as MockFetch,
      });

      // Act
      await admin.removePeer('nostr/peer@example.com');

      // Assert
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8081/admin/peers/nostr%2Fpeer%40example.com',
        expect.anything()
      );
    });

    it('should throw PeerNotFoundError on 404', async () => {
      // Arrange
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: vi.fn().mockResolvedValue('Peer does not exist'),
      });

      const admin = new HttpConnectorAdmin({
        adminUrl: 'http://localhost:8081',
        httpClient: mockFetch as unknown as MockFetch,
      });

      // Act & Assert
      await expect(admin.removePeer('nostr-unknown')).rejects.toThrow(PeerNotFoundError);
      await expect(admin.removePeer('nostr-unknown')).rejects.toThrow(/nostr-unknown/);
    });

    it('should throw ValidationError on empty peerId', async () => {
      const mockFetch = vi.fn();
      const admin = new HttpConnectorAdmin({
        adminUrl: 'http://localhost:8081',
        httpClient: mockFetch as unknown as MockFetch,
      });

      await expect(admin.removePeer('')).rejects.toThrow(ValidationError);
      await expect(admin.removePeer('   ')).rejects.toThrow(ValidationError);

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should throw NetworkError on connection refused', async () => {
      // Arrange
      const networkError = new Error('fetch failed');
      Object.assign(networkError, { message: 'ECONNREFUSED' });

      const mockFetch = vi.fn().mockRejectedValue(networkError);

      const admin = new HttpConnectorAdmin({
        adminUrl: 'http://localhost:8081',
        maxRetries: 0,  // Disable retries for faster test
        httpClient: mockFetch as unknown as MockFetch,
      });

      // Act & Assert
      await expect(admin.removePeer('nostr-abc123')).rejects.toThrow(NetworkError);
      await expect(admin.removePeer('nostr-abc123')).rejects.toThrow(/Failed to connect/);
    });

    it('should throw NetworkError on timeout', async () => {
      // Arrange
      const timeoutError = new Error('Timeout');
      Object.assign(timeoutError, { name: 'AbortError' });

      const mockFetch = vi.fn().mockRejectedValue(timeoutError);

      const admin = new HttpConnectorAdmin({
        adminUrl: 'http://localhost:8081',
        timeout: 5000,
        maxRetries: 0,  // Disable retries for faster test
        httpClient: mockFetch as unknown as MockFetch,
      });

      // Act & Assert
      await expect(admin.removePeer('nostr-abc123')).rejects.toThrow(NetworkError);
      await expect(admin.removePeer('nostr-abc123')).rejects.toThrow(/timed out after 5000ms/);
    });

    it('should throw UnauthorizedError on 401', async () => {
      // Arrange
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: vi.fn().mockResolvedValue('Invalid credentials'),
      });

      const admin = new HttpConnectorAdmin({
        adminUrl: 'http://localhost:8081',
        httpClient: mockFetch as unknown as MockFetch,
      });

      // Act & Assert
      await expect(admin.removePeer('nostr-abc123')).rejects.toThrow(UnauthorizedError);
      await expect(admin.removePeer('nostr-abc123')).rejects.toThrow(/authentication failed/);
    });

    it('should throw ConnectorError on 5xx server error', async () => {
      // Arrange
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        text: vi.fn().mockResolvedValue('Connector is shutting down'),
      });

      const admin = new HttpConnectorAdmin({
        adminUrl: 'http://localhost:8081',
        httpClient: mockFetch as unknown as MockFetch,
      });

      // Act & Assert
      await expect(admin.removePeer('nostr-abc123')).rejects.toThrow(ConnectorError);
      await expect(admin.removePeer('nostr-abc123')).rejects.toThrow(/503/);
    });

    it('should normalize adminUrl with trailing slash', async () => {
      // Arrange
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 204,
      });

      const admin = new HttpConnectorAdmin({
        adminUrl: 'http://localhost:8081/',
        httpClient: mockFetch as unknown as MockFetch,
      });

      // Act
      await admin.removePeer('nostr-abc123');

      // Assert
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8081/admin/peers/nostr-abc123',
        expect.anything()
      );
    });
  });

  describe('retry logic', () => {
    it('should retry addPeer on network error and eventually succeed', async () => {
      // Arrange
      const networkError = new Error('ECONNREFUSED');
      const mockFetch = vi
        .fn()
        .mockRejectedValueOnce(networkError)  // Fail first attempt
        .mockRejectedValueOnce(networkError)  // Fail second attempt
        .mockResolvedValue({ ok: true, status: 201 });  // Succeed third attempt

      const admin = new HttpConnectorAdmin({
        adminUrl: 'http://localhost:8081',
        maxRetries: 3,
        retryDelay: 10,  // Short delay for fast tests
        httpClient: mockFetch as unknown as MockFetch,
      });

      // Act
      await admin.addPeer(mockPeerConfig);

      // Assert
      expect(mockFetch).toHaveBeenCalledTimes(3);  // 2 failures + 1 success
    });

    it('should retry removePeer on network error and eventually succeed', async () => {
      // Arrange
      const networkError = new Error('ETIMEDOUT');
      const mockFetch = vi
        .fn()
        .mockRejectedValueOnce(networkError)  // Fail first attempt
        .mockResolvedValue({ ok: true, status: 204 });  // Succeed second attempt

      const admin = new HttpConnectorAdmin({
        adminUrl: 'http://localhost:8081',
        maxRetries: 3,
        retryDelay: 10,
        httpClient: mockFetch as unknown as MockFetch,
      });

      // Act
      await admin.removePeer('nostr-abc123');

      // Assert
      expect(mockFetch).toHaveBeenCalledTimes(2);  // 1 failure + 1 success
    });

    it('should NOT retry on validation errors', async () => {
      const mockFetch = vi.fn();
      const admin = new HttpConnectorAdmin({
        adminUrl: 'http://localhost:8081',
        maxRetries: 3,
        httpClient: mockFetch as unknown as MockFetch,
      });

      // Act & Assert
      await expect(admin.addPeer({ ...mockPeerConfig, id: '' })).rejects.toThrow(ValidationError);

      // Should fail immediately without calling fetch
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should NOT retry on 4xx errors', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        statusText: 'Conflict',
        text: vi.fn().mockResolvedValue('Peer exists'),
      });

      const admin = new HttpConnectorAdmin({
        adminUrl: 'http://localhost:8081',
        maxRetries: 3,
        retryDelay: 10,
        httpClient: mockFetch as unknown as MockFetch,
      });

      // Act & Assert
      await expect(admin.addPeer(mockPeerConfig)).rejects.toThrow();

      // Should only attempt once (no retry on 4xx)
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should NOT retry on 5xx errors', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: vi.fn().mockResolvedValue('Server error'),
      });

      const admin = new HttpConnectorAdmin({
        adminUrl: 'http://localhost:8081',
        maxRetries: 3,
        retryDelay: 10,
        httpClient: mockFetch as unknown as MockFetch,
      });

      // Act & Assert
      await expect(admin.addPeer(mockPeerConfig)).rejects.toThrow();

      // Should only attempt once (no retry on 5xx)
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should use exponential backoff for retries', async () => {
      // This test verifies the retry utility is called correctly
      // Actual exponential backoff timing is tested in retry.test.ts
      const networkError = new Error('ECONNREFUSED');
      const mockFetch = vi
        .fn()
        .mockRejectedValueOnce(networkError)
        .mockRejectedValueOnce(networkError)
        .mockResolvedValue({ ok: true, status: 201 });

      const admin = new HttpConnectorAdmin({
        adminUrl: 'http://localhost:8081',
        maxRetries: 3,
        retryDelay: 100,
        httpClient: mockFetch as unknown as MockFetch,
      });

      const startTime = Date.now();
      await admin.addPeer(mockPeerConfig);
      const duration = Date.now() - startTime;

      // Should have some delay between retries (exponential backoff: 100ms, 200ms)
      // Total delay should be at least 300ms (100 + 200)
      expect(duration).toBeGreaterThanOrEqual(250);  // Allow for timing variance
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });
  });

  describe('bulk operations', () => {
    describe('addPeers', () => {
      it('should add multiple peers in parallel', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
          ok: true,
          status: 201,
        });

        const admin = new HttpConnectorAdmin({
          adminUrl: 'http://localhost:8081',
          maxRetries: 0,
          httpClient: mockFetch as unknown as MockFetch,
        });

        const peers = [
          { id: 'peer1', url: 'btp+ws://peer1.com:3000', authToken: 'token1' },
          { id: 'peer2', url: 'btp+ws://peer2.com:3000', authToken: 'token2' },
          { id: 'peer3', url: 'btp+ws://peer3.com:3000', authToken: 'token3' },
        ];

        // Act
        const results = await admin.addPeers(peers);

        // Assert
        expect(results).toHaveLength(3);
        expect(results.every((r) => r.success)).toBe(true);
        expect(mockFetch).toHaveBeenCalledTimes(3);
        expect(results[0].peerId).toBe('peer1');
        expect(results[1].peerId).toBe('peer2');
        expect(results[2].peerId).toBe('peer3');
      });

      it('should handle partial failures in bulk add', async () => {
        const mockFetch = vi
          .fn()
          .mockResolvedValueOnce({ ok: true, status: 201 })  // peer1 succeeds
          .mockResolvedValueOnce({  // peer2 fails (conflict)
            ok: false,
            status: 409,
            statusText: 'Conflict',
            text: vi.fn().mockResolvedValue('Peer exists'),
          })
          .mockResolvedValueOnce({ ok: true, status: 201 });  // peer3 succeeds

        const admin = new HttpConnectorAdmin({
          adminUrl: 'http://localhost:8081',
          maxRetries: 0,
          httpClient: mockFetch as unknown as MockFetch,
        });

        const peers = [
          { id: 'peer1', url: 'btp+ws://peer1.com:3000', authToken: 'token1' },
          { id: 'peer2', url: 'btp+ws://peer2.com:3000', authToken: 'token2' },
          { id: 'peer3', url: 'btp+ws://peer3.com:3000', authToken: 'token3' },
        ];

        // Act
        const results = await admin.addPeers(peers);

        // Assert
        expect(results).toHaveLength(3);
        expect(results[0]).toMatchObject({ peerId: 'peer1', success: true });
        expect(results[1]).toMatchObject({ peerId: 'peer2', success: false });
        expect(results[1].error).toBeDefined();
        expect(results[2]).toMatchObject({ peerId: 'peer3', success: true });
      });

      it('should return all failures if all peers fail', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
          text: vi.fn().mockResolvedValue('Server error'),
        });

        const admin = new HttpConnectorAdmin({
          adminUrl: 'http://localhost:8081',
          maxRetries: 0,
          httpClient: mockFetch as unknown as MockFetch,
        });

        const peers = [
          { id: 'peer1', url: 'btp+ws://peer1.com:3000', authToken: 'token1' },
          { id: 'peer2', url: 'btp+ws://peer2.com:3000', authToken: 'token2' },
        ];

        // Act
        const results = await admin.addPeers(peers);

        // Assert
        expect(results).toHaveLength(2);
        expect(results.every((r) => !r.success)).toBe(true);
        expect(results.every((r) => r.error !== undefined)).toBe(true);
      });

      it('should handle empty array', async () => {
        const admin = new HttpConnectorAdmin({
          adminUrl: 'http://localhost:8081',
        });

        const results = await admin.addPeers([]);

        expect(results).toEqual([]);
      });
    });

    describe('removePeers', () => {
      it('should remove multiple peers in parallel', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
          ok: true,
          status: 204,
        });

        const admin = new HttpConnectorAdmin({
          adminUrl: 'http://localhost:8081',
          maxRetries: 0,
          httpClient: mockFetch as unknown as MockFetch,
        });

        const peerIds = ['peer1', 'peer2', 'peer3'];

        // Act
        const results = await admin.removePeers(peerIds);

        // Assert
        expect(results).toHaveLength(3);
        expect(results.every((r) => r.success)).toBe(true);
        expect(mockFetch).toHaveBeenCalledTimes(3);
        expect(results.map((r) => r.peerId)).toEqual(peerIds);
      });

      it('should handle partial failures in bulk remove', async () => {
        const mockFetch = vi
          .fn()
          .mockResolvedValueOnce({ ok: true, status: 204 })  // peer1 succeeds
          .mockResolvedValueOnce({  // peer2 fails (not found)
            ok: false,
            status: 404,
            statusText: 'Not Found',
            text: vi.fn().mockResolvedValue('Peer not found'),
          })
          .mockResolvedValueOnce({ ok: true, status: 204 });  // peer3 succeeds

        const admin = new HttpConnectorAdmin({
          adminUrl: 'http://localhost:8081',
          maxRetries: 0,
          httpClient: mockFetch as unknown as MockFetch,
        });

        const peerIds = ['peer1', 'peer2', 'peer3'];

        // Act
        const results = await admin.removePeers(peerIds);

        // Assert
        expect(results).toHaveLength(3);
        expect(results[0]).toMatchObject({ peerId: 'peer1', success: true });
        expect(results[1]).toMatchObject({ peerId: 'peer2', success: false });
        expect(results[1].error).toBeDefined();
        expect(results[2]).toMatchObject({ peerId: 'peer3', success: true });
      });

      it('should handle empty array', async () => {
        const admin = new HttpConnectorAdmin({
          adminUrl: 'http://localhost:8081',
        });

        const results = await admin.removePeers([]);

        expect(results).toEqual([]);
      });
    });

    it('should execute bulk operations concurrently (not sequentially)', async () => {
      const delays: number[] = [];
      const mockFetch = vi.fn().mockImplementation(async () => {
        const start = Date.now();
        await new Promise((resolve) => setTimeout(resolve, 50));
        delays.push(Date.now() - start);
        return { ok: true, status: 201 };
      });

      const admin = new HttpConnectorAdmin({
        adminUrl: 'http://localhost:8081',
        maxRetries: 0,
        httpClient: mockFetch as unknown as MockFetch,
      });

      const peers = [
        { id: 'peer1', url: 'btp+ws://peer1.com:3000', authToken: 'token1' },
        { id: 'peer2', url: 'btp+ws://peer2.com:3000', authToken: 'token2' },
        { id: 'peer3', url: 'btp+ws://peer3.com:3000', authToken: 'token3' },
      ];

      const startTime = Date.now();
      await admin.addPeers(peers);
      const totalDuration = Date.now() - startTime;

      // If sequential: would take ~150ms (3 * 50ms)
      // If parallel: should take ~50-70ms (all run concurrently)
      expect(totalDuration).toBeLessThan(100);
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });
  });
});
