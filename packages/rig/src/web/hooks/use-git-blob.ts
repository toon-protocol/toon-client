import { useState, useEffect } from 'react';
import { resolveGitSha, fetchArweaveObject } from '../arweave-client.js';
import { seedFromRefs } from '@/lib/seed-cache';
import type { RepoRefs } from '../nip34-parsers.js';

interface UseGitBlobResult {
  data: Uint8Array | null;
  loading: boolean;
  error: Error | null;
}

export function useGitBlob(
  sha: string | null,
  repoId: string,
  refs: RepoRefs | null,
): UseGitBlobResult {
  const [data, setData] = useState<Uint8Array | null>(null);
  const [loading, setLoading] = useState(!!sha);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!sha) {
      setData(null);
      setLoading(false);
      return;
    }

    if (refs?.arweaveMap.size) {
      seedFromRefs(refs, repoId);
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      const txId = await resolveGitSha(sha, repoId);
      if (!txId) throw new Error(`Could not resolve SHA ${sha.slice(0, 7)}`);
      const blob = await fetchArweaveObject(txId);
      if (!blob) throw new Error(`Could not fetch blob ${sha.slice(0, 7)}`);
      if (!cancelled) {
        setData(blob);
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

  return { data, loading, error };
}
