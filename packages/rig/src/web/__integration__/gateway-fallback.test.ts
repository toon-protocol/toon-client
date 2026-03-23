// @vitest-environment jsdom
// Test IDs: 8.2-INT-003
// AC covered: #9 (Gateway fallback integration)

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

import {
  fetchArweaveObject,
  clearShaCache,
  ARWEAVE_GATEWAYS,
} from '../arweave-client.js';

const originalFetch = globalThis.fetch;

describe('Integration: Gateway Fallback', () => {
  beforeEach(() => {
    clearShaCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('[P1] primary gateway 404 -> fallback returns data -> content available', async () => {
    // Arrange — valid 43-char base64url Arweave tx ID
    const txId = 'fallbackIntegrationTx0123456789abcdefghijkl';
    const expectedData = new Uint8Array([10, 20, 30, 40, 50]);

    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.startsWith(ARWEAVE_GATEWAYS[0]!)) {
        return new Response(null, { status: 404 });
      }
      if (urlStr.startsWith(ARWEAVE_GATEWAYS[1]!)) {
        return new Response(expectedData, { status: 200 });
      }
      return new Response(null, { status: 500 });
    }) as typeof fetch;

    // Act
    const result = await fetchArweaveObject(txId);

    // Assert
    expect(result).toEqual(expectedData);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('[P1] all gateways fail -> returns null gracefully', async () => {
    const txId = 'allFailTxIntegration01234567890abcdefghijkl';
    globalThis.fetch = vi.fn(async () => {
      return new Response(null, { status: 500 });
    }) as typeof fetch;

    const result = await fetchArweaveObject(txId);

    expect(result).toBeNull();
  });

  it('[P1] primary gateway network error -> fallback succeeds', async () => {
    const txId = 'networkErrorTx012345678901234567890abcdefgh';
    const expectedData = new Uint8Array([1, 2, 3]);

    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.startsWith(ARWEAVE_GATEWAYS[0]!)) {
        throw new Error('Network error');
      }
      return new Response(expectedData, { status: 200 });
    }) as typeof fetch;

    const result = await fetchArweaveObject(txId);

    expect(result).toEqual(expectedData);
  });
});
