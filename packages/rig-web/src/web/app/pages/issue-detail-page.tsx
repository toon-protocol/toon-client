import { useEffect, useMemo } from 'react';
import { useParams, useOutletContext } from 'react-router';
import type { RepoContext } from '@/app/repo-layout';
import { useIssues } from '@/hooks/use-issues';
import { useComments } from '@/hooks/use-comments';
import { useProfileCache } from '@/hooks/use-profile-cache';
import { CommentThread } from '@/components/comment-thread';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/** Filled GitHub-style issue state pill: green Open, purple Closed. */
function IssueStateBadge({ status }: { status: 'open' | 'closed' }) {
  const isOpen = status === 'open';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium text-white',
        isOpen ? 'bg-success' : 'bg-purple-600 dark:bg-purple-500'
      )}
    >
      <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        {isOpen ? (
          <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" fill="none" />
        ) : (
          <circle cx="8" cy="8" r="5" />
        )}
      </svg>
      {isOpen ? 'Open' : 'Closed'}
    </span>
  );
}

export function IssueDetailPage() {
  const { id = '' } = useParams();
  const { metadata, owner } = useOutletContext<RepoContext>();
  const { issues, loading: issuesLoading } = useIssues(owner, metadata.repoId, metadata.maintainers);
  const { getDisplayName, requestProfiles } = useProfileCache();

  const issue = useMemo(() => {
    return issues.find((i) => i.eventId === id) ?? null;
  }, [issues, id]);

  const eventIds = useMemo(() => (issue ? [issue.eventId] : []), [issue]);
  const { comments, loading: commentsLoading } = useComments(eventIds);

  useEffect(() => {
    if (issue) {
      requestProfiles([issue.authorPubkey]);
    }
  }, [issue, requestProfiles]);

  if (issuesLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-3/4" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (!issue) {
    return <div className="text-muted-foreground">Issue not found.</div>;
  }

  const authorName = getDisplayName(issue.authorPubkey);

  return (
    <div className="space-y-4">
      <div className="space-y-2 border-b pb-4">
        <h2 className="text-2xl font-semibold">
          {issue.title}{' '}
          <span className="font-mono text-lg font-normal text-muted-foreground">
            {issue.eventId.slice(0, 7)}
          </span>
        </h2>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <IssueStateBadge status={issue.status} />
          <span>
            <span className="font-medium text-foreground">{authorName}</span> opened this issue
            {' · '}
            {comments.length} {comments.length === 1 ? 'comment' : 'comments'}
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-6 lg:flex-row">
        <div className="min-w-0 flex-1">
          {commentsLoading ? (
            <div className="space-y-4">
              {Array.from({ length: 3 }, (_, i) => (
                <Skeleton key={i} className="h-24 w-full" />
              ))}
            </div>
          ) : (
            <CommentThread
              originalContent={issue.content}
              originalAuthor={issue.authorPubkey}
              originalCreatedAt={issue.createdAt}
              comments={comments}
            />
          )}
        </div>

        <div className="shrink-0 space-y-4 lg:w-64">
          <div className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Labels
            </h3>
            {issue.labels.length > 0 ? (
              <div className="flex flex-wrap gap-1">
                {issue.labels.map((label) => (
                  <Badge key={label} variant="secondary" className="text-[10px]">
                    {label}
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">No labels</p>
            )}
          </div>

          <div className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Assignees
            </h3>
            <p className="text-xs text-muted-foreground">None yet</p>
          </div>
        </div>
      </div>
    </div>
  );
}
