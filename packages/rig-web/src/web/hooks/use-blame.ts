import { useState, useEffect } from 'react';
import { computeBlame, isBlameError } from '../blame.js';
import { seedFromRefs } from '@/lib/seed-cache';
import type { BlameResult, BlameError } from '../blame.js';
import type { RepoRefs } from '../nip34-parsers.js';

interface UseBlameResult {
  result: BlameResult | null;
  blameError: BlameError | null;
  loading: boolean;
  error: Error | null;
}

export function useBlame(
  filePath: string | null,
  startSha: string | null,
  repoId: string,
  refs: RepoRefs | null,
  maxDepth = 50
): UseBlameResult {
  const [result, setResult] = useState<BlameResult | null>(null);
  const [blameError, setBlameError] = useState<BlameError | null>(null);
  const [loading, setLoading] = useState(!!filePath && !!startSha);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!filePath || !startSha) {
      setResult(null);
      setLoading(false);
      return;
    }

    if (refs?.arweaveMap.size) {
      seedFromRefs(refs, repoId);
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setBlameError(null);

    computeBlame(filePath, startSha, repoId, maxDepth)
      .then((res) => {
        if (cancelled) return;
        if (res === null) {
          setBlameError({ reason: 'not-found' });
        } else if (isBlameError(res)) {
          setBlameError(res);
        } else {
          setResult(res);
        }
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [filePath, startSha, repoId, refs, maxDepth]);

  return { result, blameError, loading, error };
}
