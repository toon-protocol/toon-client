/**
 * Tests for the Git-SHA → Arweave txId resolver.
 *
 * The full behavioral suite lives in rig's `arweave-client.test.ts` (which
 * consumes these functions via re-export); this file covers the core contract
 * so the owning package stays tested if consumers move.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  clearShaCache,
  isValidArweaveTxId,
  resolveGitSha,
  seedShaCache,
  shaCacheKey,
} from './git-sha.js';

const originalFetch = globalThis.fetch;

function mockFetch(
  impl: (url: string, init?: RequestInit) => Promise<Response>
): void {
  globalThis.fetch = vi.fn(impl) as typeof fetch;
}

function graphqlResponse(txId: string): Response {
  return new Response(
    JSON.stringify({
      data: { transactions: { edges: [{ node: { id: txId } }] } },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

describe('git-sha resolver', () => {
  beforeEach(() => {
    clearShaCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('resolves a SHA to a txId via GraphQL and caches the result', async () => {
    const sha = 'ab'.repeat(20);
    const txId = 'ArWeAvEtX456ArWeAvEtX456ArWeAvEtX456ArWeAvE';
    mockFetch(async () => graphqlResponse(txId));

    expect(await resolveGitSha(sha, 'repo-a')).toBe(txId);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    // Second call is served from the cache
    expect(await resolveGitSha(sha, 'repo-a')).toBe(txId);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('sends the Git-SHA + Repo tag query', async () => {
    const sha = 'cd'.repeat(20);
    let capturedQuery = '';
    mockFetch(async (_url, init) => {
      capturedQuery = (JSON.parse(init?.body as string) as { query: string })
        .query;
      return graphqlResponse('TxVeRiFiEdTxVeRiFiEdTxVeRiFiEdTxVeRiFiEdTxV');
    });

    await resolveGitSha(sha, 'my-repo');

    expect(capturedQuery).toContain('Git-SHA');
    expect(capturedQuery).toContain('Repo');
    expect(capturedQuery).toContain(sha);
    expect(capturedQuery).toContain('my-repo');
  });

  it('rejects invalid SHA formats without fetching', async () => {
    mockFetch(async () => graphqlResponse('ShOuLdNoTrEaChShOuLdNoTrEaChShOuLdNoTrEaChS'));

    expect(await resolveGitSha('short', 'repo')).toBeNull();
    expect(await resolveGitSha('zz'.repeat(20), 'repo')).toBeNull();
    expect(await resolveGitSha('', 'repo')).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('strips GraphQL string-breaking characters from the repo value', async () => {
    const sha = 'ef'.repeat(20);
    const maliciousRepo = '"]}) { edges { node { id } } } #';
    let capturedQuery = '';
    mockFetch(async (_url, init) => {
      capturedQuery = (JSON.parse(init?.body as string) as { query: string })
        .query;
      return graphqlResponse('SafeSafeSafeSafeSafeSafeSafeSafeSafeSafeSaf');
    });

    await resolveGitSha(sha, maliciousRepo);

    const repoMatch = capturedQuery.match(/Repo.*?values:\s*\["([^"]*)"\]/s);
    expect(repoMatch).not.toBeNull();
    expect(repoMatch![1]).not.toContain('"');
  });

  it('returns null on malformed / empty GraphQL responses and network errors', async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ data: { transactions: {} } }), {
        status: 200,
      })
    );
    expect(await resolveGitSha('ba'.repeat(20), 'bad-repo')).toBeNull();

    mockFetch(async () => {
      throw new Error('network down');
    });
    expect(await resolveGitSha('bb'.repeat(20), 'err-repo')).toBeNull();
  });

  it('seedShaCache pre-populates so resolveGitSha skips GraphQL', async () => {
    const sha = 'ce'.repeat(20);
    const txId = 'SeEdSeEdSeEdSeEdSeEdSeEdSeEdSeEdSeEdSeEdSeE';
    seedShaCache(new Map([[shaCacheKey(sha, 'seeded-repo'), txId]]));
    mockFetch(async () => {
      throw new Error('fetch should not be called when cache is seeded');
    });

    expect(await resolveGitSha(sha, 'seeded-repo')).toBe(txId);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('shaCacheKey formats as "sha:repo"', () => {
    expect(shaCacheKey('a'.repeat(40), 'r')).toBe(`${'a'.repeat(40)}:r`);
  });

  it('isValidArweaveTxId accepts 43-char base64url only', () => {
    expect(isValidArweaveTxId('abcdefghijklmnopqrstuvwxyz01234567890ABCDEF')).toBe(true);
    expect(isValidArweaveTxId('short')).toBe(false);
    expect(isValidArweaveTxId('!'.repeat(43))).toBe(false);
  });
});
