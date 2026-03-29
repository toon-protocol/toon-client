import { seedShaCache } from '../arweave-client.js';
import type { RepoRefs } from '../nip34-parsers.js';

/**
 * Seed the Arweave SHA→txId cache from a RepoRefs arweaveMap.
 *
 * The arweaveMap has bare SHA keys, but resolveGitSha() uses "sha:repoId"
 * as cache keys. This helper reformats the keys before seeding.
 */
export function seedFromRefs(refs: RepoRefs, repoId: string): void {
  if (refs.arweaveMap.size === 0) return;
  const reformatted: [string, string][] = [];
  for (const [sha, txId] of refs.arweaveMap) {
    reformatted.push([`${sha}:${repoId}`, txId]);
  }
  seedShaCache(reformatted);
}
