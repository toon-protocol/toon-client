import { useParams, useOutletContext, Link } from 'react-router';
import type { RepoContext } from '@/app/repo-layout';
import { useCommitDetail } from '@/hooks/use-commit-detail';
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

  const author = parseAuthorIdent(commit.author);
  const _committer = parseAuthorIdent(commit.committer);
  const [title, ...bodyLines] = commit.message.split('\n');
  const body = bodyLines.join('\n').trim();
  const initials = (author?.name ?? '?').slice(0, 2).toUpperCase();

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
          <span className="font-medium">{author?.name ?? 'Unknown'}</span>
          <span className="text-muted-foreground">
            committed {author?.timestamp ? formatRelativeDate(author.timestamp) : ''}
          </span>
        </div>
        <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
          <span>commit <span className="font-mono">{sha.slice(0, 7)}</span></span>
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

      {/* Diff */}
      <DiffView files={changedFiles} repoId={metadata.repoId} />
    </div>
  );
}
