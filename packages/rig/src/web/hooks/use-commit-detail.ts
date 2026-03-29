import { useState, useEffect } from 'react';
import { resolveGitSha, fetchArweaveObject } from '../arweave-client.js';
import { seedFromRefs } from '@/lib/seed-cache';
import { parseGitCommit, parseGitTree } from '../git-objects.js';
import { diffTrees } from '../tree-diff.js';
import type { GitCommit } from '../git-objects.js';
import type { TreeDiffEntry } from '../tree-diff.js';
import type { RepoRefs } from '../nip34-parsers.js';

interface UseCommitDetailResult {
  commit: GitCommit | null;
  changedFiles: TreeDiffEntry[];
  loading: boolean;
  error: Error | null;
}

export function useCommitDetail(
  sha: string | null,
  repoId: string,
  refs: RepoRefs | null,
): UseCommitDetailResult {
  const [commit, setCommit] = useState<GitCommit | null>(null);
  const [changedFiles, setChangedFiles] = useState<TreeDiffEntry[]>([]);
  const [loading, setLoading] = useState(!!sha);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!sha) {
      setCommit(null);
      setChangedFiles([]);
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
      // 1. Fetch + parse this commit
      const txId = await resolveGitSha(sha, repoId);
      if (!txId) throw new Error(`Cannot resolve commit ${sha.slice(0, 7)}`);
      const data = await fetchArweaveObject(txId);
      if (!data) throw new Error(`Cannot fetch commit ${sha.slice(0, 7)}`);
      const parsed = parseGitCommit(data);
      if (!parsed || cancelled) return;

      setCommit(parsed);

      // 2. Fetch current tree
      const treeTxId = await resolveGitSha(parsed.treeSha, repoId);
      if (!treeTxId || cancelled) return;
      const treeData = await fetchArweaveObject(treeTxId);
      if (!treeData || cancelled) return;
      const newEntries = parseGitTree(treeData);

      // 3. Fetch parent tree (if exists)
      const parentSha = parsed.parentShas[0];
      let oldEntries: ReturnType<typeof parseGitTree> = [];
      if (parentSha) {
        const parentTxId = await resolveGitSha(parentSha, repoId);
        if (parentTxId) {
          const parentData = await fetchArweaveObject(parentTxId);
          if (parentData) {
            const parentCommit = parseGitCommit(parentData);
            if (parentCommit) {
              const parentTreeTxId = await resolveGitSha(parentCommit.treeSha, repoId);
              if (parentTreeTxId) {
                const parentTreeData = await fetchArweaveObject(parentTreeTxId);
                if (parentTreeData) {
                  oldEntries = parseGitTree(parentTreeData);
                }
              }
            }
          }
        }
      }

      if (cancelled) return;

      // 4. Diff trees
      const diff = diffTrees(oldEntries, newEntries);
      setChangedFiles(diff);
      setLoading(false);
    })().catch((err: unknown) => {
      if (!cancelled) {
        setError(err instanceof Error ? err : new Error(String(err)));
        setLoading(false);
      }
    });

    return () => { cancelled = true; };
  }, [sha, repoId, refs]);

  return { commit, changedFiles, loading, error };
}

/**
 * Hook for lazy-loading a file diff when a collapsible section is expanded.
 */
export function useFileDiff(
  oldSha: string | undefined,
  newSha: string | undefined,
  repoId: string,
  enabled: boolean,
) {
  const [diff, setDiff] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled || (!oldSha && !newSha)) return;

    let cancelled = false;
    setLoading(true);

    (async () => {
      const { computeUnifiedDiff } = await import('../unified-diff.js');

      let oldText = '';
      let newText = '';

      if (oldSha) {
        const txId = await resolveGitSha(oldSha, repoId);
        if (txId) {
          const data = await fetchArweaveObject(txId);
          if (data) oldText = new TextDecoder().decode(data);
        }
      }

      if (newSha) {
        const txId = await resolveGitSha(newSha, repoId);
        if (txId) {
          const data = await fetchArweaveObject(txId);
          if (data) newText = new TextDecoder().decode(data);
        }
      }

      if (cancelled) return;

      const hunks = computeUnifiedDiff(oldText, newText);
      // Serialize hunks to unified diff text
      const lines: string[] = [];
      for (const hunk of hunks) {
        lines.push(`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`);
        for (const line of hunk.lines) {
          const prefix = line.type === 'add' ? '+' : line.type === 'delete' ? '-' : ' ';
          lines.push(`${prefix}${line.content}`);
        }
      }

      if (!cancelled) {
        setDiff(lines.join('\n'));
        setLoading(false);
      }
    })().catch(() => {
      if (!cancelled) setLoading(false);
    });

    return () => { cancelled = true; };
  }, [oldSha, newSha, repoId, enabled]);

  return { diff, loading };
}
