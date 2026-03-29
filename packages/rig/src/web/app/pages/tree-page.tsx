import { useState, useEffect, useMemo } from 'react';
import { useParams, useOutletContext, Link } from 'react-router';
import type { RepoContext } from '@/app/repo-layout';
import { useGitTree } from '@/hooks/use-git-tree';
import { resolveDefaultRef } from '../../ref-resolver.js';
import { resolveGitSha, fetchArweaveObject } from '../../arweave-client.js';
import { seedFromRefs } from '@/lib/seed-cache';
import { resolveRefSha } from '@/lib/ref-utils';
import { parseGitCommit, parseGitTree } from '../../git-objects.js';
import { FileTree } from '@/components/file-tree';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Fragment } from 'react';

export function TreePage() {
  const { ref = '', '*': splat = '' } = useParams();
  const { metadata, refs, owner, repo } = useOutletContext<RepoContext>();
  const pathSegments = useMemo(() => splat.split('/').filter(Boolean), [splat]);

  const [subtreeSha, setSubtreeSha] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!refs) return;
    if (refs.arweaveMap.size) seedFromRefs(refs, metadata.repoId);

    let cancelled = false;
    setLoading(true);

    (async () => {
      // Resolve ref → commit → root tree
      const commitSha = resolveRefSha(ref, refs) ?? resolveDefaultRef(metadata, refs)?.commitSha;
      if (!commitSha) return;

      const txId = await resolveGitSha(commitSha, metadata.repoId);
      if (!txId || cancelled) return;
      const data = await fetchArweaveObject(txId);
      if (!data || cancelled) return;
      const commit = parseGitCommit(data);
      if (!commit || cancelled) return;

      // Walk path segments to find subtree
      let currentSha = commit.treeSha;
      for (const segment of pathSegments) {
        const treeTxId = await resolveGitSha(currentSha, metadata.repoId);
        if (!treeTxId || cancelled) return;
        const treeData = await fetchArweaveObject(treeTxId);
        if (!treeData || cancelled) return;
        const entries = parseGitTree(treeData);
        const entry = entries.find((e) => e.name === segment);
        if (!entry || cancelled) return;
        currentSha = entry.sha;
      }

      if (!cancelled) {
        setSubtreeSha(currentSha);
        setLoading(false);
      }
    })().catch(() => {
      if (!cancelled) setLoading(false);
    });

    return () => { cancelled = true; };
  }, [refs, ref, splat, metadata, pathSegments]);

  const { entries, loading: treeLoading } = useGitTree(subtreeSha, metadata.repoId, refs);

  const basePath = `/${owner}/${repo}/tree/${ref}${splat ? `/${splat}` : ''}`;
  const blobPath = `/${owner}/${repo}/blob/${ref}${splat ? `/${splat}` : ''}`;

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

      <FileTree
        entries={entries}
        loading={loading || treeLoading}
        basePath={basePath}
        blobPath={blobPath}
      />
    </div>
  );
}
