import { useEffect, useMemo } from 'react';
import { useParams, useOutletContext, Link } from 'react-router';
import type { RepoContext } from '@/app/repo-layout';
import { useCommitDetail } from '@/hooks/use-commit-detail';
import { useProfileCache } from '@/hooks/use-profile-cache';
import { parseAuthorIdent } from '../../git-objects.js';
import { formatRelativeDate } from '../../date-utils.js';
import { DiffView } from '@/components/diff-view';
import { Skeleton } from '@/components/ui/skeleton';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Separator } from '@/components/ui/separator';

export function CommitDetailPage() {
  const { sha = '' } = useParams();
  const { metadata, refs, owner, repo } = useOutletContext<RepoContext>();
  const { commit, changedFiles, loading, error } = useCommitDetail(sha, metadata.repoId, refs);
  const { getDisplayName, requestProfiles } = useProfileCache();

  const author = commit ? parseAuthorIdent(commit.author) : null;

  // Request the author's profile so we can show a display name instead of a
  // raw pubkey, same resolution used on the commit log page.
  useEffect(() => {
    if (author?.email && author.email.length === 64 && /^[0-9a-f]+$/.test(author.email)) {
      requestProfiles([author.email]);
    }
  }, [author?.email, requestProfiles]);

  // File-level diffstat: TreeDiffEntry only carries an added/deleted/modified
  // *status* per file, not per-line insertion/deletion counts (those require
  // fetching + diffing every file's blob, which DiffView only does lazily on
  // expand). So the summary reports file counts, not "+N -M" line stats.
  const diffStats = useMemo(() => {
    let added = 0;
    let modified = 0;
    let deleted = 0;
    for (const file of changedFiles) {
      if (file.status === 'added') added++;
      else if (file.status === 'modified') modified++;
      else if (file.status === 'deleted') deleted++;
    }
    return { total: changedFiles.length, added, modified, deleted };
  }, [changedFiles]);

  if (error) {
    return <div className="text-destructive-foreground">Failed to load commit: {error.message}</div>;
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!commit) {
    return <div className="text-muted-foreground">Commit not found.</div>;
  }

  const [title, ...bodyLines] = commit.message.split('\n');
  const body = bodyLines.join('\n').trim();
  const authorName = author
    ? author.email.length === 64 && /^[0-9a-f]+$/.test(author.email)
      ? getDisplayName(author.email)
      : author.name
    : null;
  const initials = (authorName ?? '?').slice(0, 2).toUpperCase();

  return (
    <div className="space-y-6">
      {/* Commit header */}
      <div className="rounded-md border p-4">
        <h2 className="text-lg font-semibold">{title}</h2>
        {body && (
          <pre className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">{body}</pre>
        )}
        <Separator className="my-3" />
        <div className="flex items-center gap-3 text-sm">
          <Avatar className="h-6 w-6">
            <AvatarFallback className="text-[10px]">{initials}</AvatarFallback>
          </Avatar>
          <span className="font-medium">{authorName ?? 'Unknown'}</span>
          <span className="text-muted-foreground">
            committed {author?.timestamp ? formatRelativeDate(author.timestamp) : ''}
          </span>
        </div>
        <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
          <span>
            commit <span className="font-mono">{sha.slice(0, 7)}</span>
          </span>
          {commit.parentShas.map((p, i) => (
            <span key={p}>
              parent{commit.parentShas.length > 1 ? ` ${i + 1}` : ''}{' '}
              <Link
                to={`/${owner}/${repo}/commit/${p}`}
                className="font-mono hover:text-primary hover:underline"
              >
                {p.slice(0, 7)}
              </Link>
            </span>
          ))}
        </div>
      </div>

      {/* Diffstat summary */}
      {diffStats.total > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span className="font-medium text-foreground">
            {diffStats.total} changed file{diffStats.total !== 1 ? 's' : ''}
          </span>
          {diffStats.added > 0 && (
            <span className="text-success">{diffStats.added} added</span>
          )}
          {diffStats.modified > 0 && (
            <span className="text-muted-foreground">{diffStats.modified} modified</span>
          )}
          {diffStats.deleted > 0 && (
            <span className="text-destructive-foreground">{diffStats.deleted} removed</span>
          )}
        </div>
      )}

      {/* Diff */}
      <DiffView files={changedFiles} repoId={metadata.repoId} />
    </div>
  );
}
