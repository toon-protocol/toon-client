// @vitest-environment jsdom
// AC covered: #3

import { describe, it, expect } from 'vitest';

import { resolveDefaultRef } from './ref-resolver.js';
import type { RepoMetadata } from './nip34-parsers.js';

// ============================================================================
// Factories
// ============================================================================

function createRepoMeta(overrides: Partial<RepoMetadata> = {}): RepoMetadata {
  return {
    name: overrides.name ?? 'test-repo',
    description: overrides.description ?? 'A test repo',
    ownerPubkey: overrides.ownerPubkey ?? 'ab'.repeat(32),
    defaultBranch: overrides.defaultBranch ?? 'main',
    eventId: overrides.eventId ?? 'a'.repeat(64),
    cloneUrls: overrides.cloneUrls ?? [],
    webUrls: overrides.webUrls ?? [],
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('Ref Resolver - resolveDefaultRef', () => {
  it('[P1] resolves to default branch when present in refs', () => {
    const meta = createRepoMeta({ defaultBranch: 'main' });
    const refs = {
      repoId: 'test-repo',
      refs: new Map([
        ['main', 'aaa'],
        ['develop', 'bbb'],
      ]),
    };

    const result = resolveDefaultRef(meta, refs);

    expect(result).toEqual({ refName: 'main', commitSha: 'aaa' });
  });

  it('[P1] falls back to HEAD when default branch not in refs', () => {
    const meta = createRepoMeta({ defaultBranch: 'main' });
    const refs = {
      repoId: 'test-repo',
      refs: new Map([
        ['HEAD', 'ccc'],
        ['develop', 'ddd'],
      ]),
    };

    const result = resolveDefaultRef(meta, refs);

    expect(result).toEqual({ refName: 'HEAD', commitSha: 'ccc' });
  });

  it('[P1] falls back to first available ref when neither default branch nor HEAD exist', () => {
    const meta = createRepoMeta({ defaultBranch: 'main' });
    const refs = {
      repoId: 'test-repo',
      refs: new Map([['feature-x', 'eee']]),
    };

    const result = resolveDefaultRef(meta, refs);

    expect(result).toEqual({ refName: 'feature-x', commitSha: 'eee' });
  });

  it('[P1] returns null when refs map is empty', () => {
    const meta = createRepoMeta({ defaultBranch: 'main' });
    const refs = {
      repoId: 'test-repo',
      refs: new Map<string, string>(),
    };

    const result = resolveDefaultRef(meta, refs);

    expect(result).toBeNull();
  });
});
