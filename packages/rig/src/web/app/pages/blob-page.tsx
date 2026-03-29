import { useState, useEffect, useMemo, useCallback, Fragment } from 'react';
import { useParams, useOutletContext, Link } from 'react-router';
import type { RepoContext } from '@/app/repo-layout';
import { resolveGitSha, fetchArweaveObject } from '../../arweave-client.js';
import { seedFromRefs } from '@/lib/seed-cache';
import { resolveRefSha } from '@/lib/ref-utils';
import { parseGitCommit, parseGitTree } from '../../git-objects.js';
import { FileViewer } from '@/components/file-viewer';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';

export function BlobPage() {
  const { ref = '', '*': splat = '' } = useParams();
  const { metadata, refs, owner, repo } = useOutletContext<RepoContext>();
  const pathSegments = useMemo(() => splat.split('/').filter(Boolean), [splat]);
  const filename = pathSegments[pathSegments.length - 1] ?? '';

  const [blobData, setBlobData] = useState<Uint8Array | null>(null);
  const [rootTreeSha, setRootTreeSha] = useState<string | null>(null);
  const [commitSha, setCommitSha] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!refs) return;
    if (refs.arweaveMap.size) seedFromRefs(refs, metadata.repoId);

    let cancelled = false;
    setLoading(true);
    setError(null);
    setBlobData(null);

    (async () => {
      const refCommitSha = resolveRefSha(ref, refs);
      if (!refCommitSha) { setError('Unknown ref'); setLoading(false); return; }
      setCommitSha(refCommitSha);

      const txId = await resolveGitSha(refCommitSha, metadata.repoId);
      if (!txId || cancelled) return;
      const data = await fetchArweaveObject(txId);
      if (!data || cancelled) return;
      const commit = parseGitCommit(data);
      if (!commit || cancelled) return;

      setRootTreeSha(commit.treeSha);

      // Walk path to find blob, fetching each level
      let currentSha = commit.treeSha;
      for (let i = 0; i < pathSegments.length; i++) {
        const segment = pathSegments[i] ?? '';
        const treeTxId = await resolveGitSha(currentSha, metadata.repoId);
        if (!treeTxId || cancelled) return;
        const treeData = await fetchArweaveObject(treeTxId);
        if (!treeData || cancelled) return;
        const entries = parseGitTree(treeData);
        const entry = entries.find((e) => e.name === segment);
        if (!entry || cancelled) return;

        if (i === pathSegments.length - 1) {
          // Last segment — this is the blob. Fetch it directly.
          const blobTxId = await resolveGitSha(entry.sha, metadata.repoId);
          if (!blobTxId) {
            // Try Arweave GraphQL as fallback (for objects not in cache)
            if (!cancelled) { setError(`Could not resolve file ${segment}`); setLoading(false); }
            return;
          }
          const blob = await fetchArweaveObject(blobTxId);
          if (!cancelled) {
            if (blob) {
              setBlobData(blob);
            } else {
              setError(`Could not fetch file ${segment}`);
            }
            setLoading(false);
          }
          return;
        }

        currentSha = entry.sha;
      }

      // Path was empty or didn't reach a blob
      if (!cancelled) { setError('File not found'); setLoading(false); }
    })().catch((err: unknown) => {
      if (!cancelled) {
        setError(err instanceof Error ? err.message : 'Failed to load file');
        setLoading(false);
      }
    });

    return () => { cancelled = true; };
  }, [refs, ref, splat, metadata, pathSegments]);

  // Resolve relative paths in markdown relative to this file's directory
  const baseDir = pathSegments.slice(0, -1).join('/');
  const resolveRelativePath = useCallback(
    (relativePath: string) => {
      // Normalize: join baseDir + relativePath and resolve .. segments
      const parts = baseDir ? baseDir.split('/') : [];
      for (const segment of relativePath.split('/')) {
        if (segment === '..') parts.pop();
        else if (segment !== '.' && segment !== '') parts.push(segment);
      }
      const resolved = parts.join('/');
      return `#/${owner}/${repo}/blob/${ref}/${resolved}`;
    },
    [baseDir, owner, repo, ref],
  );

  return (
    <div className="space-y-4">
      {/* Breadcrumb */}
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link to={`/${owner}/${repo}`}>{metadata.name}</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          {pathSegments.map((segment, i) => {
            const partialPath = pathSegments.slice(0, i + 1).join('/');
            const isLast = i === pathSegments.length - 1;
            return (
              <Fragment key={partialPath}>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  {isLast ? (
                    <span className="font-medium">{segment}</span>
                  ) : (
                    <BreadcrumbLink asChild>
                      <Link to={`/${owner}/${repo}/tree/${ref}/${partialPath}`}>{segment}</Link>
                    </BreadcrumbLink>
                  )}
                </BreadcrumbItem>
              </Fragment>
            );
          })}
        </BreadcrumbList>
      </Breadcrumb>

      {error ? (
        <div className="text-sm text-destructive-foreground">{error}</div>
      ) : loading ? (
        <div className="space-y-2">
          {Array.from({ length: 10 }, (_, i) => (
            <Skeleton key={i} className="h-4 w-full" />
          ))}
        </div>
      ) : blobData ? (
        <FileViewer
          data={blobData}
          filename={filename}
          filePath={splat}
          resolveRelativePath={resolveRelativePath}
          treeSha={rootTreeSha}
          repoId={metadata.repoId}
          refs={refs}
          commitSha={commitSha}
        />
      ) : (
        <div className="text-muted-foreground">File not found.</div>
      )}
    </div>
  );
}
