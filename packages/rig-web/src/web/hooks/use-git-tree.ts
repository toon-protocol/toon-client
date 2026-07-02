import { useState, useEffect } from 'react';
import { resolveGitSha, fetchArweaveObject } from '../arweave-client.js';
import { seedFromRefs } from '@/lib/seed-cache';
import { parseGitTree } from '../git-objects.js';
import type { TreeEntry } from '../git-objects.js';
import type { RepoRefs } from '../nip34-parsers.js';

interface UseGitTreeResult {
  entries: TreeEntry[];
  loading: boolean;
  error: Error | null;
}

export function useGitTree(
  sha: string | null,
  repoId: string,
  refs: RepoRefs | null
): UseGitTreeResult {
  const [entries, setEntries] = useState<TreeEntry[]>([]);
  const [loading, setLoading] = useState(!!sha);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!sha) {
      setEntries([]);
      setLoading(false);
      return;
    }

    // Seed the arweave cache from refs if available
    if (refs?.arweaveMap.size) {
      seedFromRefs(refs, repoId);
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      const txId = await resolveGitSha(sha, repoId);
      if (!txId) throw new Error(`Could not resolve SHA ${sha.slice(0, 7)}`);
      const data = await fetchArweaveObject(txId);
      if (!data) throw new Error(`Could not fetch object ${sha.slice(0, 7)}`);
      if (!cancelled) {
        setEntries(parseGitTree(data));
        setLoading(false);
      }
    })().catch((err: unknown) => {
      if (!cancelled) {
        setError(err instanceof Error ? err : new Error(String(err)));
        setLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [sha, repoId, refs]);

  return { entries, loading, error };
}
