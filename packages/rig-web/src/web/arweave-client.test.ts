// @vitest-environment jsdom
// Test IDs: 8.2-UNIT-006
// AC covered: #8, #9, #10

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  fetchArweaveObject,
  resolveGitSha,
  clearShaCache,
  seedShaCache,
  ARWEAVE_GATEWAYS,
} from './arweave-client.js';

// ============================================================================
// Mock setup
// ============================================================================

const originalFetch = globalThis.fetch;

function mockFetch(
  impl: (url: string, init?: RequestInit) => Promise<Response>
): void {
  globalThis.fetch = vi.fn(impl) as typeof fetch;
}

// ============================================================================
// Tests
// ============================================================================

describe('Arweave Client - fetchArweaveObject', () => {
  beforeEach(() => {
    clearShaCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // 8.2-UNIT-006: Constructs correct URL from tx ID
  // AC: #8
  // ---------------------------------------------------------------------------

  it('[P1] constructs correct URL and returns Uint8Array on success', async () => {
    // Arrange — valid 43-char base64url Arweave tx ID
    const txId = 'abcdefghijklmnopqrstuvwxyz01234567890ABCDEF';
    const responseData = new Uint8Array([1, 2, 3, 4]);
    mockFetch(async (url: string) => {
      if (url === `${ARWEAVE_GATEWAYS[0]}/${txId}`) {
        return new Response(responseData, { status: 200 });
      }
      return new Response(null, { status: 404 });
    });

    // Act
    const result = await fetchArweaveObject(txId);

    // Assert
    expect(result).toEqual(responseData);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      `${ARWEAVE_GATEWAYS[0]}/${txId}`,
      expect.objectContaining({ signal: expect.anything() })
    );
  });

  it('[P1] returns null on 404', async () => {
    const txId = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ01234567890abcdef';
    mockFetch(async () => new Response(null, { status: 404 }));

    const result = await fetchArweaveObject(txId);

    expect(result).toBeNull();
  });

  it('[P1] returns null for invalid txId format', async () => {
    mockFetch(async () => new Response(new Uint8Array([1]), { status: 200 }));

    // Too short
    expect(await fetchArweaveObject('short')).toBeNull();
    // Contains invalid characters
    expect(
      await fetchArweaveObject('abc!@#$%^&*()+={}[]|;:<>,./?\'"abc1234')
    ).toBeNull();
    // Empty
    expect(await fetchArweaveObject('')).toBeNull();
    // fetch should never have been called
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // AC: #9 - Gateway fallback
  // ---------------------------------------------------------------------------

  it('[P1] falls back to secondary gateway on primary failure', async () => {
    const txId = 'fallbackTxId01234567890abcdefghijklmnopqrst';
    const responseData = new Uint8Array([5, 6, 7]);
    let callCount = 0;
    mockFetch(async (url: string) => {
      callCount++;
      if (url.startsWith(ARWEAVE_GATEWAYS[0]!)) {
        return new Response(null, { status: 500 });
      }
      if (url.startsWith(ARWEAVE_GATEWAYS[1]!)) {
        return new Response(responseData, { status: 200 });
      }
      return new Response(null, { status: 404 });
    });

    const result = await fetchArweaveObject(txId);

    expect(result).toEqual(responseData);
    expect(callCount).toBe(2);
  });

  it('[P1] returns null when all gateways fail', async () => {
    const txId = 'allFailTxId012345678901234567890abcdefghijk';
    mockFetch(async () => new Response(null, { status: 500 }));

    const result = await fetchArweaveObject(txId);

    expect(result).toBeNull();
  });
});

describe('Arweave Client - resolveGitSha', () => {
  beforeEach(() => {
    clearShaCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('[P1] resolves SHA to txId via GraphQL', async () => {
    const sha = 'abc123' + 'de'.repeat(17);
    const repo = 'test-repo';
    const txId = 'ArWeAvEtX456ArWeAvEtX456ArWeAvEtX456ArWeAvE'; // valid 43-char base64url

    mockFetch(async () => {
      return new Response(
        JSON.stringify({
          data: {
            transactions: {
              edges: [{ node: { id: txId } }],
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const result = await resolveGitSha(sha, repo);

    expect(result).toBe(txId);
  });

  // ---------------------------------------------------------------------------
  // Cache hit test
  // ---------------------------------------------------------------------------

  it('[P1] cache hit: second call does not trigger a second fetch', async () => {
    const sha = 'ca'.repeat(20);
    const repo = 'cached-repo';
    const txId = 'CaCaCaCaCaCaCaCaCaCaCaCaCaCaCaCaCaCaCaCaCaC'; // valid 43-char base64url

    mockFetch(async () => {
      return new Response(
        JSON.stringify({
          data: { transactions: { edges: [{ node: { id: txId } }] } },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    // First call — triggers fetch
    const result1 = await resolveGitSha(sha, repo);
    expect(result1).toBe(txId);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    // Second call — should use cache
    const result2 = await resolveGitSha(sha, repo);
    expect(result2).toBe(txId);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1); // Still 1
  });

  // ---------------------------------------------------------------------------
  // Malformed GraphQL response
  // ---------------------------------------------------------------------------

  it('[P1] returns null on malformed GraphQL response (missing edges)', async () => {
    mockFetch(async () => {
      return new Response(JSON.stringify({ data: { transactions: {} } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const result = await resolveGitSha('ba'.repeat(20), 'bad-repo');

    expect(result).toBeNull();
  });

  it('[P2] returns null on empty edges array', async () => {
    mockFetch(async () => {
      return new Response(
        JSON.stringify({
          data: { transactions: { edges: [] } },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const result = await resolveGitSha('ee'.repeat(20), 'empty-repo');

    expect(result).toBeNull();
  });

  it('[P2] returns null on network error', async () => {
    mockFetch(async () => {
      throw new Error('Network failure');
    });

    const result = await resolveGitSha('ef'.repeat(20), 'error-repo');

    expect(result).toBeNull();
  });

  it('[P1] returns null for invalid SHA format (non-hex or wrong length)', async () => {
    mockFetch(async () => {
      return new Response(
        JSON.stringify({
          data: {
            transactions: { edges: [{ node: { id: 'should-not-reach' } }] },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    // Too short
    expect(await resolveGitSha('abc123', 'repo')).toBeNull();
    // Non-hex characters
    expect(await resolveGitSha('zz'.repeat(20), 'repo')).toBeNull();
    // Empty
    expect(await resolveGitSha('', 'repo')).toBeNull();
    // fetch should never have been called
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('[P1] sends correct GraphQL query with Git-SHA and Repo tags', async () => {
    const sha = 'ab'.repeat(20);
    const repo = 'my-test-repo';

    mockFetch(async (_url: string, init?: RequestInit) => {
      // Verify the request body contains the correct query
      const body = JSON.parse(init?.body as string) as { query: string };
      expect(body.query).toContain('Git-SHA');
      expect(body.query).toContain('Repo');
      expect(body.query).toContain(repo);

      return new Response(
        JSON.stringify({
          data: {
            transactions: {
              edges: [
                { node: { id: 'TxVeRiFiEdTxVeRiFiEdTxVeRiFiEdTxVeRiFiEdTxV' } },
              ],
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const result = await resolveGitSha(sha, repo);
    expect(result).toBe('TxVeRiFiEdTxVeRiFiEdTxVeRiFiEdTxVeRiFiEdTxV');
  });

  it('[P0] sanitizes inputs to prevent GraphQL injection', async () => {
    // A malicious repo name attempting to break out of the GraphQL string
    const sha = 'ab'.repeat(20);
    const maliciousRepo = '"]}) { edges { node { id } } } #';
    let capturedQuery = '';

    mockFetch(async (_url: string, init?: RequestInit) => {
      capturedQuery = (JSON.parse(init?.body as string) as { query: string })
        .query;

      return new Response(
        JSON.stringify({
          data: {
            transactions: {
              edges: [
                { node: { id: 'SafeSafeSafeSafeSafeSafeSafeSafeSafeSafeSaf' } },
              ],
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const result = await resolveGitSha(sha, maliciousRepo);
    expect(result).toBe('SafeSafeSafeSafeSafeSafeSafeSafeSafeSafeSaf');
    // The sanitized query should strip double-quotes from user input.
    // The malicious input '"]}) {...' should become ']}) {...' (no injected quote).
    // Verify the Repo value does NOT contain a double-quote character that could
    // close the GraphQL string and inject new query structure.
    const repoMatch = capturedQuery.match(/Repo.*?values:\s*\["([^"]*)"\]/s);
    expect(repoMatch).not.toBeNull();
    // The captured repo value should not contain any double-quote characters
    expect(repoMatch![1]).not.toContain('"');
    // The original malicious double-quote was stripped
    expect(repoMatch![1]).toContain(']}) { edges { node { id } } } #');
  });
});

// ============================================================================
// Story 8.6: Bug Fix Validation Tests
// ============================================================================

describe('Arweave Client - 8.6-UNIT-003: AR.IO as primary gateway', () => {
  it('[P1] ARWEAVE_GATEWAYS has ar-io.dev as primary (index 0)', () => {
    // AC #3: AR.IO gateways index Turbo/Irys bundles immediately
    expect(ARWEAVE_GATEWAYS[0]).toBe('https://ar-io.dev');
  });

  it('[P1] ARWEAVE_GATEWAYS has arweave.net as second fallback', () => {
    expect(ARWEAVE_GATEWAYS[1]).toBe('https://arweave.net');
  });

  it('[P1] ARWEAVE_GATEWAYS has permagate.io as third fallback', () => {
    expect(ARWEAVE_GATEWAYS[2]).toBe('https://permagate.io');
  });

  it('[P1] ARWEAVE_GATEWAYS has exactly 3 entries', () => {
    expect(ARWEAVE_GATEWAYS.length).toBe(3);
  });
});

describe('Arweave Client - 8.6-UNIT-005: seedShaCache pre-populates cache', () => {
  beforeEach(() => {
    clearShaCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('[P1] seedShaCache allows resolveGitSha to return txId without fetch', async () => {
    // AC #5: Pre-seeded cache bypasses GraphQL resolution
    const sha = 'ab'.repeat(20);
    const repo = 'seeded-repo';
    const txId = 'SeEdSeEdSeEdSeEdSeEdSeEdSeEdSeEdSeEdSeEdSeE'; // valid 43-char base64url

    // Seed the cache with the mapping (using "sha:repo" key format)
    seedShaCache(new Map([[`${sha}:${repo}`, txId]]));

    // Mock fetch to track calls — should NOT be called
    mockFetch(async () => {
      throw new Error('fetch should not be called when cache is seeded');
    });

    const result = await resolveGitSha(sha, repo);

    expect(result).toBe(txId);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('[P1] seedShaCache accepts Array<[string, string]> format', async () => {
    const sha = 'cd'.repeat(20);
    const repo = 'array-repo';
    const txId = 'ArRaYArRaYArRaYArRaYArRaYArRaYArRaYArRaYArR'; // valid 43-char base64url

    seedShaCache([[`${sha}:${repo}`, txId]]);

    mockFetch(async () => {
      throw new Error('fetch should not be called');
    });

    const result = await resolveGitSha(sha, repo);

    expect(result).toBe(txId);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('[P2] seedShaCache does not affect unrelated cache keys', async () => {
    const sha = 'ef'.repeat(20);
    const otherTxId = 'OtHeRoThErOtHeRoThErOtHeRoThErOtHeRoThErOtH'; // valid 43-char
    const graphqlTxId = 'GrApHqLgRaPhQlGrApHqLgRaPhQlGrApHqLgRaPhQlX'; // valid 43-char
    seedShaCache(new Map([['other-key:other-repo', otherTxId]]));

    mockFetch(async () => {
      return new Response(
        JSON.stringify({
          data: { transactions: { edges: [{ node: { id: graphqlTxId } }] } },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const result = await resolveGitSha(sha, 'unrelated-repo');

    // Should hit GraphQL, not the cache
    expect(result).toBe(graphqlTxId);
    expect(globalThis.fetch).toHaveBeenCalled();
  });
});
