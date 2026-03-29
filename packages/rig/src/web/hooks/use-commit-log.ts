import { useState, useEffect } from 'react';
import { walkCommitChain } from '../commit-walker.js';
import { seedFromRefs } from '@/lib/seed-cache';
import type { CommitLogEntry } from '../commit-walker.js';
import type { RepoRefs } from '../nip34-parsers.js';

interface UseCommitLogResult {
  entries: CommitLogEntry[];
  loading: boolean;
  hasMore: boolean;
  error: Error | null;
}

export function useCommitLog(
  startSha: string | null,
  repoId: string,
  refs: RepoRefs | null,
  maxDepth = 50,
): UseCommitLogResult {
  const [entries, setEntries] = useState<CommitLogEntry[]>([]);
  const [loading, setLoading] = useState(!!startSha);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!startSha) {
      setEntries([]);
      setLoading(false);
      return;
    }

    if (refs?.arweaveMap.size) {
      seedFromRefs(refs, repoId);
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    walkCommitChain(startSha, repoId, maxDepth)
      .then((result) => {
        if (!cancelled) {
          setEntries(result);
          setHasMore(result.length === maxDepth);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setLoading(false);
        }
      });

    return () => { cancelled = true; };
  }, [startSha, repoId, refs, maxDepth]);

  return { entries, loading, hasMore, error };
}
