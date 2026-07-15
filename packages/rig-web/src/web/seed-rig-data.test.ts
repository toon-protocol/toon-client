// Structural guard: rig data seeding into the Arweave SHA cache.
// Ensures seedFromRefs correctly reformats sha→txId mappings so that
// resolveGitSha() can satisfy lookups from relay events without a GraphQL round-trip.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { seedFromRefs } from './lib/seed-cache.js';
import {
  clearShaCache,
  resolveGitSha,
} from './arweave-client.js';
import type { RepoRefs } from './nip34-parsers.js';

const SHA1 = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const TX1 = 'A'.repeat(43);
const TX2 = 'B'.repeat(43);
const REPO_ID = 'owner/my-repo';

function makeRefs(arweaveEntries: [string, string][]): RepoRefs {
  return {
    repoId: REPO_ID,
    refs: new Map(),
    arweaveMap: new Map(arweaveEntries),
  };
}

// On a cache MISS, resolveGitSha() falls through to a real
// `fetch('https://arweave.net/graphql')` bounded only by AbortSignal.timeout.
// Left unstubbed that is a live network request whose failure is not guaranteed
// to land inside vitest's 5s test timeout — the source of this file's flake.
// Stub fetch so every miss resolves deterministically (empty GraphQL result →
// null) and instantly, with zero network dependence. Seeded (cache-hit) tests
// never reach fetch, so this does not mask their behaviour.
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  clearShaCache();
  fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ data: { transactions: { edges: [] } } }),
  }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('seedFromRefs - no-op behaviour', () => {
  it('[P0] does not throw when arweaveMap is empty', () => {
    const refs = makeRefs([]);
    expect(() => seedFromRefs(refs, REPO_ID)).not.toThrow();
  });

  it('[P1] leaves cache empty when arweaveMap is empty', async () => {
    seedFromRefs(makeRefs([]), REPO_ID);
    // An empty arweaveMap seeds nothing, so this SHA is a genuine cache miss:
    // resolveGitSha falls through to the (stubbed) GraphQL fetch, which returns
    // no edges → null. Asserting fetch was reached proves the cache was cold
    // rather than silently short-circuited.
    const result = await resolveGitSha(SHA1, REPO_ID);
    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('seedFromRefs - cache population', () => {
  it('[P0] seeded SHA resolves from cache without a network call', async () => {
    seedFromRefs(makeRefs([[SHA1, TX1]]), REPO_ID);
    const result = await resolveGitSha(SHA1, REPO_ID);
    expect(result).toBe(TX1);
  });

  it('[P0] multiple SHAs are all seeded', async () => {
    seedFromRefs(makeRefs([[SHA1, TX1], [SHA2, TX2]]), REPO_ID);
    expect(await resolveGitSha(SHA1, REPO_ID)).toBe(TX1);
    expect(await resolveGitSha(SHA2, REPO_ID)).toBe(TX2);
  });

  it('[P1] seeded entry is scoped to the given repoId', async () => {
    seedFromRefs(makeRefs([[SHA1, TX1]]), REPO_ID);
    // Same SHA under a different repo must not resolve from cache.
    const other = await resolveGitSha(SHA1, 'other/repo');
    expect(other).toBeNull();
  });

  it('[P1] cache key includes both sha and repoId', async () => {
    const repoA = 'owner/repo-a';
    const repoB = 'owner/repo-b';
    seedFromRefs(makeRefs([[SHA1, TX1]]), repoA);
    seedFromRefs(makeRefs([[SHA1, TX2]]), repoB);
    expect(await resolveGitSha(SHA1, repoA)).toBe(TX1);
    expect(await resolveGitSha(SHA1, repoB)).toBe(TX2);
  });
});

describe('seedFromRefs - re-seeding', () => {
  it('[P2] later seed overwrites an earlier value for the same sha', async () => {
    seedFromRefs(makeRefs([[SHA1, TX1]]), REPO_ID);
    seedFromRefs(makeRefs([[SHA1, TX2]]), REPO_ID);
    expect(await resolveGitSha(SHA1, REPO_ID)).toBe(TX2);
  });
});
