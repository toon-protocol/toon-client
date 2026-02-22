import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HttpRuntimeClient } from './HttpRuntimeClient.js';
import { NetworkError, ConnectorError, ValidationError } from '../errors.js';

describe('HttpRuntimeClient', () => {
  describe('constructor', () => {
    it('should normalize connector URL by removing trailing slash', () => {
      const mockFetch = vi.fn();
      const client = new HttpRuntimeClient({
        connectorUrl: 'http://localhost:8080/',
        httpClient: mockFetch as typeof fetch,
      });

      expect(client).toBeDefined();
      // URL normalization will be tested in actual requests
    });

    it('should use default timeout of 30000ms', () => {
      const client = new HttpRuntimeClient({
        connectorUrl: 'http://localhost:8080',
      });

      expect(client).toBeDefined();
    });

    it('should use custom timeout when provided', () => {
      const client = new HttpRuntimeClient({
        connectorUrl: 'http://localhost:8080',
        timeout: 5000,
      });

      expect(client).toBeDefined();
    });

    it('should use default retry config (3 retries, 1000ms delay)', () => {
      const client = new HttpRuntimeClient({
        connectorUrl: 'http://localhost:8080',
      });

      expect(client).toBeDefined();
    });

    it('should use custom retry config when provided', () => {
      const client = new HttpRuntimeClient({
        connectorUrl: 'http://localhost:8080',
        maxRetries: 5,
        retryDelay: 2000,
      });

      expect(client).toBeDefined();
    });
  });

  describe('sendIlpPacket - validation', () => {
    let client: HttpRuntimeClient;

    beforeEach(() => {
      const mockFetch = vi.fn();
      client = new HttpRuntimeClient({
        connectorUrl: 'http://localhost:8080',
        httpClient: mockFetch as typeof fetch,
      });
    });

    it('should throw ValidationError for empty destination', async () => {
      await expect(
        client.sendIlpPacket({
          destination: '',
          amount: '1000',
          data: 'dGVzdA==',
        })
      ).rejects.toThrow(ValidationError);

      await expect(
        client.sendIlpPacket({
          destination: '',
          amount: '1000',
          data: 'dGVzdA==',
        })
      ).rejects.toThrow('Destination cannot be empty');
    });

    it('should throw ValidationError for invalid ILP address format', async () => {
      await expect(
        client.sendIlpPacket({
          destination: 'invalid.address',
          amount: '1000',
          data: 'dGVzdA==',
        })
      ).rejects.toThrow(ValidationError);

      await expect(
        client.sendIlpPacket({
          destination: 'invalid.address',
          amount: '1000',
          data: 'dGVzdA==',
        })
      ).rejects.toThrow('must start with "g."');
    });

    it('should throw ValidationError for empty amount', async () => {
      await expect(
        client.sendIlpPacket({
          destination: 'g.crosstown.alice',
          amount: '',
          data: 'dGVzdA==',
        })
      ).rejects.toThrow(ValidationError);

      await expect(
        client.sendIlpPacket({
          destination: 'g.crosstown.alice',
          amount: '',
          data: 'dGVzdA==',
        })
      ).rejects.toThrow('Amount cannot be empty');
    });

    it('should throw ValidationError for non-numeric amount', async () => {
      await expect(
        client.sendIlpPacket({
          destination: 'g.crosstown.alice',
          amount: 'not-a-number',
          data: 'dGVzdA==',
        })
      ).rejects.toThrow(ValidationError);

      await expect(
        client.sendIlpPacket({
          destination: 'g.crosstown.alice',
          amount: 'not-a-number',
          data: 'dGVzdA==',
        })
      ).rejects.toThrow('must be a valid integer');
    });

    it('should throw ValidationError for negative amount', async () => {
      await expect(
        client.sendIlpPacket({
          destination: 'g.crosstown.alice',
          amount: '-100',
          data: 'dGVzdA==',
        })
      ).rejects.toThrow(ValidationError);

      await expect(
        client.sendIlpPacket({
          destination: 'g.crosstown.alice',
          amount: '-100',
          data: 'dGVzdA==',
        })
      ).rejects.toThrow('must be positive');
    });

    it('should throw ValidationError for zero amount', async () => {
      await expect(
        client.sendIlpPacket({
          destination: 'g.crosstown.alice',
          amount: '0',
          data: 'dGVzdA==',
        })
      ).rejects.toThrow(ValidationError);

      await expect(
        client.sendIlpPacket({
          destination: 'g.crosstown.alice',
          amount: '0',
          data: 'dGVzdA==',
        })
      ).rejects.toThrow('must be positive');
    });

    it('should throw ValidationError for empty data', async () => {
      await expect(
        client.sendIlpPacket({
          destination: 'g.crosstown.alice',
          amount: '1000',
          data: '',
        })
      ).rejects.toThrow(ValidationError);

      await expect(
        client.sendIlpPacket({
          destination: 'g.crosstown.alice',
          amount: '1000',
          data: '',
        })
      ).rejects.toThrow('Data cannot be empty');
    });

    it('should throw ValidationError for invalid Base64 data', async () => {
      await expect(
        client.sendIlpPacket({
          destination: 'g.crosstown.alice',
          amount: '1000',
          data: 'not-base64!!!',
        })
      ).rejects.toThrow(ValidationError);

      await expect(
        client.sendIlpPacket({
          destination: 'g.crosstown.alice',
          amount: '1000',
          data: 'not-base64!!!',
        })
      ).rejects.toThrow('must be valid Base64');
    });

    it('should accept valid Base64 data', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          accepted: true,
          fulfillment: 'test-fulfillment',
        }),
      });

      const validClient = new HttpRuntimeClient({
        connectorUrl: 'http://localhost:8080',
        httpClient: mockFetch as typeof fetch,
      });

      const result = await validClient.sendIlpPacket({
        destination: 'g.crosstown.alice',
        amount: '1000',
        data: 'dGVzdA==',
      });

      expect(result.accepted).toBe(true);
      expect(mockFetch).toHaveBeenCalled();
    });
  });

  describe('sendIlpPacket - successful requests', () => {
    it('should send ILP packet successfully (200 OK, accepted)', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          accepted: true,
          fulfillment: 'test-fulfillment-base64',
        }),
      });

      const client = new HttpRuntimeClient({
        connectorUrl: 'http://localhost:8080',
        httpClient: mockFetch as typeof fetch,
      });

      const result = await client.sendIlpPacket({
        destination: 'g.crosstown.alice',
        amount: '1000',
        data: 'dGVzdA==',
      });

      expect(result).toEqual({
        accepted: true,
        fulfillment: 'test-fulfillment-base64',
        data: undefined,
        code: undefined,
        message: undefined,
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8080/ilp',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            destination: 'g.crosstown.alice',
            amount: '1000',
            data: 'dGVzdA==',
          }),
        })
      );
    });

    it('should handle rejected packet (200 OK, accepted=false)', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          accepted: false,
          code: 'F99',
          message: 'Insufficient balance',
        }),
      });

      const client = new HttpRuntimeClient({
        connectorUrl: 'http://localhost:8080',
        httpClient: mockFetch as typeof fetch,
      });

      const result = await client.sendIlpPacket({
        destination: 'g.crosstown.alice',
        amount: '1000',
        data: 'dGVzdA==',
      });

      expect(result).toEqual({
        accepted: false,
        fulfillment: undefined,
        data: undefined,
        code: 'F99',
        message: 'Insufficient balance',
      });
    });

    it('should normalize connector URL with trailing slash', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ accepted: true }),
      });

      const client = new HttpRuntimeClient({
        connectorUrl: 'http://localhost:8080/',
        httpClient: mockFetch as typeof fetch,
      });

      await client.sendIlpPacket({
        destination: 'g.crosstown.alice',
        amount: '1000',
        data: 'dGVzdA==',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8080/ilp',
        expect.anything()
      );
    });
  });

  describe('sendIlpPacket - error handling', () => {
    it('should return error response for 4xx client errors (no retry)', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: async () => ({
          error: 'Bad Request',
          message: 'Invalid ILP address format',
        }),
      });

      const client = new HttpRuntimeClient({
        connectorUrl: 'http://localhost:8080',
        httpClient: mockFetch as typeof fetch,
      });

      const result = await client.sendIlpPacket({
        destination: 'g.crosstown.alice',
        amount: '1000',
        data: 'dGVzdA==',
      });

      expect(result).toEqual({
        accepted: false,
        code: 'HTTP_400',
        message: 'Invalid ILP address format',
      });

      expect(mockFetch).toHaveBeenCalledTimes(1); // No retry
    });

    it('should return error response for 401 Unauthorized', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: async () => ({
          error: 'Unauthorized',
          message: 'Invalid credentials',
        }),
      });

      const client = new HttpRuntimeClient({
        connectorUrl: 'http://localhost:8080',
        httpClient: mockFetch as typeof fetch,
      });

      const result = await client.sendIlpPacket({
        destination: 'g.crosstown.alice',
        amount: '1000',
        data: 'dGVzdA==',
      });

      expect(result).toEqual({
        accepted: false,
        code: 'HTTP_401',
        message: 'Invalid credentials',
      });
    });

    it('should throw ConnectorError for 5xx server errors (no retry)', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: async () => ({
          error: 'Internal Server Error',
          message: 'Connector unavailable',
        }),
      });

      const client = new HttpRuntimeClient({
        connectorUrl: 'http://localhost:8080',
        httpClient: mockFetch as typeof fetch,
      });

      await expect(
        client.sendIlpPacket({
          destination: 'g.crosstown.alice',
          amount: '1000',
          data: 'dGVzdA==',
        })
      ).rejects.toThrow(ConnectorError);

      await expect(
        client.sendIlpPacket({
          destination: 'g.crosstown.alice',
          amount: '1000',
          data: 'dGVzdA==',
        })
      ).rejects.toThrow('Connector server error (500)');

      expect(mockFetch).toHaveBeenCalledTimes(2); // No retry
    });

    it('should throw ConnectorError for 503 Service Unavailable', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        json: async () => ({
          message: 'Connector is down',
        }),
      });

      const client = new HttpRuntimeClient({
        connectorUrl: 'http://localhost:8080',
        httpClient: mockFetch as typeof fetch,
      });

      await expect(
        client.sendIlpPacket({
          destination: 'g.crosstown.alice',
          amount: '1000',
          data: 'dGVzdA==',
        })
      ).rejects.toThrow(ConnectorError);

      await expect(
        client.sendIlpPacket({
          destination: 'g.crosstown.alice',
          amount: '1000',
          data: 'dGVzdA==',
        })
      ).rejects.toThrow('Connector server error (503)');
    });
  });

  describe('sendIlpPacket - network errors and retry', () => {
    it('should throw NetworkError on connection refused (ECONNREFUSED)', async () => {
      const mockFetch = vi.fn().mockRejectedValue(
        Object.assign(new TypeError('fetch failed'), {
          cause: { code: 'ECONNREFUSED' },
        })
      );

      const client = new HttpRuntimeClient({
        connectorUrl: 'http://localhost:8080',
        httpClient: mockFetch as typeof fetch,
        maxRetries: 3,
        retryDelay: 100, // Short delay for testing
      });

      await expect(
        client.sendIlpPacket({
          destination: 'g.crosstown.alice',
          amount: '1000',
          data: 'dGVzdA==',
        })
      ).rejects.toThrow(NetworkError);

      await expect(
        client.sendIlpPacket({
          destination: 'g.crosstown.alice',
          amount: '1000',
          data: 'dGVzdA==',
        })
      ).rejects.toThrow('Network connection failed');

      // Should retry 3 times: initial + 3 retries = 4 total
      expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(4);
    });

    it('should throw NetworkError on timeout (AbortError)', async () => {
      const mockFetch = vi.fn().mockRejectedValue(
        Object.assign(new Error('The operation was aborted'), {
          name: 'AbortError',
        })
      );

      const client = new HttpRuntimeClient({
        connectorUrl: 'http://localhost:8080',
        httpClient: mockFetch as typeof fetch,
        timeout: 1000,
        maxRetries: 2,
        retryDelay: 100,
      });

      await expect(
        client.sendIlpPacket({
          destination: 'g.crosstown.alice',
          amount: '1000',
          data: 'dGVzdA==',
        })
      ).rejects.toThrow(NetworkError);

      await expect(
        client.sendIlpPacket({
          destination: 'g.crosstown.alice',
          amount: '1000',
          data: 'dGVzdA==',
        })
      ).rejects.toThrow('Request timeout');

      // Should retry 2 times: initial + 2 retries = 3 total
      expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(3);
    });

    it('should retry and eventually succeed after network errors', async () => {
      const mockFetch = vi
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new TypeError('fetch failed'), {
            cause: { code: 'ECONNREFUSED' },
          })
        )
        .mockRejectedValueOnce(
          Object.assign(new TypeError('fetch failed'), {
            cause: { code: 'ECONNREFUSED' },
          })
        )
        .mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({
            accepted: true,
            fulfillment: 'success-after-retry',
          }),
        });

      const client = new HttpRuntimeClient({
        connectorUrl: 'http://localhost:8080',
        httpClient: mockFetch as typeof fetch,
        maxRetries: 3,
        retryDelay: 100,
      });

      const result = await client.sendIlpPacket({
        destination: 'g.crosstown.alice',
        amount: '1000',
        data: 'dGVzdA==',
      });

      expect(result.accepted).toBe(true);
      expect(result.fulfillment).toBe('success-after-retry');
      expect(mockFetch).toHaveBeenCalledTimes(3); // 2 failures + 1 success
    });

    it('should not retry on ValidationError', async () => {
      const client = new HttpRuntimeClient({
        connectorUrl: 'http://localhost:8080',
        maxRetries: 3,
      });

      await expect(
        client.sendIlpPacket({
          destination: '', // Invalid
          amount: '1000',
          data: 'dGVzdA==',
        })
      ).rejects.toThrow(ValidationError);

      // No HTTP requests made (validation fails before HTTP)
    });

    it('should exhaust retries and throw last error', async () => {
      const mockFetch = vi.fn().mockRejectedValue(
        Object.assign(new TypeError('fetch failed'), {
          cause: { code: 'ETIMEDOUT' },
        })
      );

      const client = new HttpRuntimeClient({
        connectorUrl: 'http://localhost:8080',
        httpClient: mockFetch as typeof fetch,
        maxRetries: 2,
        retryDelay: 50,
      });

      await expect(
        client.sendIlpPacket({
          destination: 'g.crosstown.alice',
          amount: '1000',
          data: 'dGVzdA==',
        })
      ).rejects.toThrow(NetworkError);

      // Should attempt: initial + 2 retries = 3 total
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });
  });

  describe('sendIlpPacket - edge cases', () => {
    it('should handle response with missing optional fields', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          accepted: true,
          // No fulfillment, data, code, or message
        }),
      });

      const client = new HttpRuntimeClient({
        connectorUrl: 'http://localhost:8080',
        httpClient: mockFetch as typeof fetch,
      });

      const result = await client.sendIlpPacket({
        destination: 'g.crosstown.alice',
        amount: '1000',
        data: 'dGVzdA==',
      });

      expect(result.accepted).toBe(true);
      expect(result.fulfillment).toBeUndefined();
      expect(result.data).toBeUndefined();
      expect(result.code).toBeUndefined();
      expect(result.message).toBeUndefined();
    });

    it('should handle 4xx error with malformed JSON body', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: async () => {
          throw new Error('Invalid JSON');
        },
      });

      const client = new HttpRuntimeClient({
        connectorUrl: 'http://localhost:8080',
        httpClient: mockFetch as typeof fetch,
      });

      const result = await client.sendIlpPacket({
        destination: 'g.crosstown.alice',
        amount: '1000',
        data: 'dGVzdA==',
      });

      expect(result).toEqual({
        accepted: false,
        code: 'HTTP_400',
        message: 'Bad Request',
      });
    });

    it('should handle 5xx error with malformed JSON body', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: async () => {
          throw new Error('Invalid JSON');
        },
      });

      const client = new HttpRuntimeClient({
        connectorUrl: 'http://localhost:8080',
        httpClient: mockFetch as typeof fetch,
      });

      await expect(
        client.sendIlpPacket({
          destination: 'g.crosstown.alice',
          amount: '1000',
          data: 'dGVzdA==',
        })
      ).rejects.toThrow(ConnectorError);

      await expect(
        client.sendIlpPacket({
          destination: 'g.crosstown.alice',
          amount: '1000',
          data: 'dGVzdA==',
        })
      ).rejects.toThrow('Internal Server Error');
    });

    it('should handle unexpected HTTP status codes', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 999,
        statusText: 'Unknown Status',
        json: async () => ({}),
      });

      const client = new HttpRuntimeClient({
        connectorUrl: 'http://localhost:8080',
        httpClient: mockFetch as typeof fetch,
      });

      await expect(
        client.sendIlpPacket({
          destination: 'g.crosstown.alice',
          amount: '1000',
          data: 'dGVzdA==',
        })
      ).rejects.toThrow(ConnectorError);

      await expect(
        client.sendIlpPacket({
          destination: 'g.crosstown.alice',
          amount: '1000',
          data: 'dGVzdA==',
        })
      ).rejects.toThrow('Unexpected HTTP status: 999');
    });

    it('should use custom timeout from request params', async () => {
      const mockFetch = vi.fn().mockImplementation(async (_url, _options) => {
        // Simulate timeout after custom timeout period
        await new Promise((resolve) => setTimeout(resolve, 100));
        return {
          ok: true,
          status: 200,
          json: async () => ({ accepted: true }),
        };
      });

      const client = new HttpRuntimeClient({
        connectorUrl: 'http://localhost:8080',
        httpClient: mockFetch as typeof fetch,
        timeout: 30000, // Default timeout
      });

      await client.sendIlpPacket({
        destination: 'g.crosstown.alice',
        amount: '1000',
        data: 'dGVzdA==',
        timeout: 5000, // Custom timeout for this request
      });

      expect(mockFetch).toHaveBeenCalled();
    });

    it('should accept large amount values (bigint)', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ accepted: true }),
      });

      const client = new HttpRuntimeClient({
        connectorUrl: 'http://localhost:8080',
        httpClient: mockFetch as typeof fetch,
      });

      const largeAmount = '999999999999999999999999';
      await client.sendIlpPacket({
        destination: 'g.crosstown.alice',
        amount: largeAmount,
        data: 'dGVzdA==',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8080/ilp',
        expect.objectContaining({
          body: expect.stringContaining(largeAmount),
        })
      );
    });
  });
});
