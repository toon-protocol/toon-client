import { useMemo, useState, useEffect, useRef } from 'react';
import { useOutletContext } from 'react-router';
import type { RepoContext } from '@/app/repo-layout';
import { useGitTree } from '@/hooks/use-git-tree';
import { useGitBlob } from '@/hooks/use-git-blob';
import { resolveDefaultRef } from '../../ref-resolver.js';
import { parseGitCommit } from '../../git-objects.js';
import { resolveGitSha, fetchArweaveObject } from '../../arweave-client.js';
import { seedFromRefs } from '@/lib/seed-cache';
import { shortRefName } from '@/lib/ref-utils';
import { useResolveImages } from '@/hooks/use-resolve-images';
import { renderMarkdown } from '../../markdown-renderer.js';
import { FileTree } from '@/components/file-tree';

async function resolveCommitTree(
  commitSha: string,
  repoId: string,
): Promise<string | null> {
  const txId = await resolveGitSha(commitSha, repoId);
  if (!txId) return null;
  const data = await fetchArweaveObject(txId);
  if (!data) return null;
  const commit = parseGitCommit(data);
  return commit?.treeSha ?? null;
}

export function RepoHomePage() {
  const { metadata, refs, owner, repo } = useOutletContext<RepoContext>();
  const [currentRef, setCurrentRef] = useState<string | null>(null);
  const [treeSha, setTreeSha] = useState<string | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [docTab, setDocTab] = useState<'readme' | 'license'>('readme');
  const branchSwitchIdRef = useRef(0);

  useEffect(() => {
    if (!refs) return;
    if (refs.arweaveMap.size) seedFromRefs(refs, metadata.repoId);

    const resolved = resolveDefaultRef(metadata, refs);
    if (!resolved) return;

    setCurrentRef(shortRefName(resolved.refName));
    setResolveError(null);

    let cancelled = false;
    const switchId = ++branchSwitchIdRef.current;

    resolveCommitTree(resolved.commitSha, metadata.repoId)
      .then((sha) => {
        if (!cancelled && branchSwitchIdRef.current === switchId) {
          if (sha) setTreeSha(sha);
          else setResolveError('Could not resolve commit tree');
        }
      })
      .catch((err: unknown) => {
        if (!cancelled && branchSwitchIdRef.current === switchId) {
          setResolveError(err instanceof Error ? err.message : 'Failed to load tree');
        }
      });

    return () => { cancelled = true; };
  }, [refs, metadata]);

  const { entries, loading: treeLoading } = useGitTree(treeSha, metadata.repoId, refs);

  // Find README and LICENSE blob SHAs
  const readmeSha = useMemo(() => {
    const readme = entries.find((e) => /^readme(\.(md|txt|rst))?$/i.test(e.name));
    return readme?.sha ?? null;
  }, [entries]);

  const licenseSha = useMemo(() => {
    const license = entries.find((e) => /^license(\.(md|txt))?$/i.test(e.name));
    return license?.sha ?? null;
  }, [entries]);

  const _readmeFilename = useMemo(() => {
    return entries.find((e) => /^readme(\.(md|txt|rst))?$/i.test(e.name))?.name ?? 'README.md';
  }, [entries]);

  const licenseFilename = useMemo(() => {
    return entries.find((e) => /^license(\.(md|txt))?$/i.test(e.name))?.name ?? 'LICENSE';
  }, [entries]);

  const { data: readmeData } = useGitBlob(readmeSha, metadata.repoId, refs);
  const { data: licenseData } = useGitBlob(licenseSha, metadata.repoId, refs);

  const refForUrl = currentRef ?? metadata.defaultBranch;

  const readmeHtml = useMemo(() => {
    if (!readmeData) return null;
    const text = new TextDecoder().decode(readmeData);
    return renderMarkdown(text, {
      resolveRelativePath: (path) => `#/${owner}/${repo}/blob/${refForUrl}/${path}`,
    });
  }, [readmeData, owner, repo, refForUrl]);

  const licenseHtml = useMemo(() => {
    if (!licenseData) return null;
    const text = new TextDecoder().decode(licenseData);
    if (licenseFilename.endsWith('.md')) {
      return renderMarkdown(text);
    }
    // Plain text license — wrap in pre
    const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<pre style="white-space:pre-wrap;word-break:break-word;font-size:0.8125rem;line-height:1.6">${escaped}</pre>`;
  }, [licenseData, licenseFilename]);

  const resolvedReadmeHtml = useResolveImages(readmeHtml, treeSha, metadata.repoId, refs);

  const basePath = `/${owner}/${repo}/tree/${refForUrl}`;
  const blobPath = `/${owner}/${repo}/blob/${refForUrl}`;

  const hasReadme = !!readmeSha;
  const hasLicense = !!licenseSha;

  return (
    <div className="space-y-4">
      {resolveError && (
        <div className="text-sm text-destructive-foreground">{resolveError}</div>
      )}

      <FileTree
        entries={entries}
        loading={treeLoading || !treeSha}
        basePath={basePath}
        blobPath={blobPath}
      />

      {/* README / LICENSE — GitHub-style underline tabs */}
      {(hasReadme || hasLicense) && (
        <div className="rounded-md border">
          <div className="flex items-center border-b px-4">
            {hasReadme && (
              <button
                onClick={() => setDocTab('readme')}
                className={`flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm font-semibold ${
                  docTab === 'readme'
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                <svg className="h-4 w-4" viewBox="0 0 16 16" fill="currentColor"><path d="M0 1.75A.75.75 0 01.75 1h4.253c1.227 0 2.317.59 3 1.501A3.744 3.744 0 0111.006 1h4.245a.75.75 0 01.75.75v10.5a.75.75 0 01-.75.75h-4.507a2.25 2.25 0 00-1.591.659l-.622.621a.75.75 0 01-1.06 0l-.622-.621A2.25 2.25 0 005.258 13H.75a.75.75 0 01-.75-.75zm7.251 10.324l.004-5.073-.002-2.253A2.25 2.25 0 005.003 2.5H1.5v9h3.757a3.75 3.75 0 011.994.574zM8.755 4.75l-.004 7.322a3.752 3.752 0 011.992-.572H14.5v-9h-3.495a2.25 2.25 0 00-2.25 2.25z"/></svg>
                README
              </button>
            )}
            {hasLicense && (
              <button
                onClick={() => setDocTab('license')}
                className={`flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm font-semibold ${
                  docTab === 'license'
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                <svg className="h-4 w-4" viewBox="0 0 16 16" fill="currentColor"><path d="M8.75.75V2h.985c.304 0 .603.08.867.231l1.29.736c.038.022.08.033.124.033h2.234a.75.75 0 010 1.5h-.427l2.111 4.692a.75.75 0 01-.154.838l-.53-.53.529.531-.001.002-.002.002-.006.006-.006.005-.01.01a3.2 3.2 0 01-.395.358 5.4 5.4 0 01-1.597.933c-.652.256-1.449.413-2.383.413s-1.731-.157-2.384-.413a5.4 5.4 0 01-1.597-.933 3.2 3.2 0 01-.395-.358l-.01-.01-.006-.005-.004-.004-.004-.004a.75.75 0 01-.154-.838L8.349 4.5h-.427a.75.75 0 010-1.5h2.234a.25.25 0 00.124-.033l1.29-.736A.75.75 0 0112.437 2h.985V.75a.75.75 0 011.5 0zm2.945 8.477a.753.753 0 01-.218.163c-.259.105-.59.192-.975.258a7.4 7.4 0 01-1.252.098c-.358 0-.723-.033-1.069-.08L8.5 9.5l.681.167zm-4.726-4.5h2.222l-1.152 2.56z"/></svg>
                {licenseFilename}
              </button>
            )}
          </div>
          <div className="p-6">
            <div
              className="prose max-w-none dark:prose-invert"
              dangerouslySetInnerHTML={{
                __html: (docTab === 'license' ? licenseHtml : resolvedReadmeHtml) ?? '',
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
