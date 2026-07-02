import { useMemo } from 'react';
import { useParams, useOutletContext } from 'react-router';
import type { RepoContext } from '@/app/repo-layout';
import { useIssues } from '@/hooks/use-issues';
import { useComments } from '@/hooks/use-comments';
import { CommentThread } from '@/components/comment-thread';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';

export function IssueDetailPage() {
  const { id = '' } = useParams();
  const { metadata, owner } = useOutletContext<RepoContext>();
  const { issues, loading: issuesLoading } = useIssues(owner, metadata.repoId);

  const issue = useMemo(() => {
    return issues.find((i) => i.eventId === id) ?? null;
  }, [issues, id]);

  const eventIds = useMemo(() => (issue ? [issue.eventId] : []), [issue]);
  const { comments, loading: commentsLoading } = useComments(eventIds);

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

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h2 className="text-xl font-semibold">{issue.title}</h2>
        <Badge variant={issue.status === 'open' ? 'default' : 'secondary'}>
          {issue.status}
        </Badge>
      </div>

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
  );
}
