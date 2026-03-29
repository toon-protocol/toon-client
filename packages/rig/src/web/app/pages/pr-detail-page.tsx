import { useMemo, useState } from 'react';
import { useParams, useOutletContext } from 'react-router';
import type { RepoContext } from '@/app/repo-layout';
import { usePRs } from '@/hooks/use-prs';
import { useComments } from '@/hooks/use-comments';
import { useCommitDetail } from '@/hooks/use-commit-detail';
import { CommentThread } from '@/components/comment-thread';
import { DiffView } from '@/components/diff-view';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export function PRDetailPage() {
  const { id = '' } = useParams();
  const { metadata, refs, owner } = useOutletContext<RepoContext>();
  const { prs, loading: prsLoading } = usePRs(owner, metadata.repoId);

  const pr = useMemo(() => {
    return prs.find((p) => p.eventId === id) ?? null;
  }, [prs, id]);

  const eventIds = useMemo(() => (pr ? [pr.eventId] : []), [pr]);
  const { comments, loading: commentsLoading } = useComments(eventIds);

  // Use the latest commit SHA for diff view
  const latestCommitSha = pr?.commitShas[pr.commitShas.length - 1] ?? null;
  const { commit, changedFiles, loading: diffLoading } = useCommitDetail(
    latestCommitSha,
    metadata.repoId,
    refs,
  );

  const [tab, setTab] = useState('conversation');

  if (prsLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-3/4" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (!pr) {
    return <div className="text-muted-foreground">Pull request not found.</div>;
  }

  const statusColor: Record<string, string> = {
    open: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
    applied: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200',
    closed: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
    draft: 'bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200',
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h2 className="text-xl font-semibold">{pr.title}</h2>
        <Badge className={statusColor[pr.status] ?? ''}>
          {pr.status === 'applied' ? 'Merged' : pr.status}
        </Badge>
      </div>
      <p className="text-xs text-muted-foreground">
        → {pr.baseBranch}
      </p>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="conversation">Conversation</TabsTrigger>
          <TabsTrigger value="files">
            Files Changed
            {changedFiles.length > 0 && (
              <Badge variant="secondary" className="ml-1 text-[10px]">
                {changedFiles.length}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="conversation">
          {commentsLoading ? (
            <div className="space-y-4">
              {Array.from({ length: 3 }, (_, i) => (
                <Skeleton key={i} className="h-24 w-full" />
              ))}
            </div>
          ) : (
            <CommentThread
              originalContent={pr.content}
              originalAuthor={pr.authorPubkey}
              originalCreatedAt={pr.createdAt}
              comments={comments}
            />
          )}
        </TabsContent>

        <TabsContent value="files">
          {diffLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }, (_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : (
            <DiffView files={changedFiles} repoId={metadata.repoId} />
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
