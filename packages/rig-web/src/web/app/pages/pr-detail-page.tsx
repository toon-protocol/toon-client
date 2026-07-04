import { useEffect, useMemo, useState } from 'react';
import { useParams, useOutletContext } from 'react-router';
import type { RepoContext } from '@/app/repo-layout';
import { usePRs } from '@/hooks/use-prs';
import { useComments } from '@/hooks/use-comments';
import { useCommitDetail } from '@/hooks/use-commit-detail';
import { useProfileCache } from '@/hooks/use-profile-cache';
import { CommentThread } from '@/components/comment-thread';
import { DiffView } from '@/components/diff-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { stripPatchHeaders } from '@/lib/patch-format';
import type { PRMetadata } from '../../nip34-parsers.js';

const STATUS_BADGE_CLASS: Record<string, string> = {
  open: 'bg-success text-success-foreground',
  applied: 'bg-purple-600 text-white dark:bg-purple-700',
  closed: 'bg-destructive text-white',
  draft: 'bg-secondary text-secondary-foreground',
};

const STATUS_LABEL: Record<string, string> = {
  open: 'Open',
  applied: 'Merged',
  closed: 'Closed',
  draft: 'Draft',
};

function MergeIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="5" cy="4" r="1.6" fill="currentColor" />
      <circle cx="5" cy="12" r="1.6" fill="currentColor" />
      <circle cx="11" cy="12" r="1.6" fill="currentColor" />
      <path
        d="M5 5.6V10.4M5 8C7 8 8 6 9.4 6"
        stroke="currentColor"
        strokeWidth="1.4"
        fill="none"
        strokeLinecap="round"
      />
      <path d="M11 10.4V8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function ClosedIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="7" fill="currentColor" opacity="0.15" />
      <path
        d="M5.5 5.5l5 5M10.5 5.5l-5 5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function OpenIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="5" cy="4" r="1.6" fill="currentColor" />
      <circle cx="5" cy="12" r="1.6" fill="currentColor" />
      <path d="M5 5.6V10.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path
        d="M11 6a2 2 0 100 4"
        stroke="currentColor"
        strokeWidth="1.4"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** GitHub-style merge/close status box shown below the Conversation thread. */
function MergeStatusBox({ pr }: { pr: PRMetadata }) {
  if (pr.status === 'applied') {
    return (
      <div className="flex items-center gap-3 rounded-md border border-purple-200 bg-purple-50 p-4 dark:border-purple-900 dark:bg-purple-950">
        <MergeIcon className="h-8 w-8 shrink-0 text-purple-600 dark:text-purple-400" />
        <div className="text-sm font-medium text-purple-900 dark:text-purple-200">
          Pull request successfully merged and closed
        </div>
      </div>
    );
  }

  if (pr.status === 'closed') {
    return (
      <div className="flex items-center gap-3 rounded-md border border-destructive/30 bg-destructive/10 p-4">
        <ClosedIcon className="h-8 w-8 shrink-0 text-destructive" />
        <div className="text-sm font-medium text-destructive">
          Closed with unmerged commits
        </div>
      </div>
    );
  }

  // open / draft — informational only; rig-web can't merge from the browser.
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-muted/30 p-4">
      <div className="flex items-center gap-3">
        <OpenIcon className="h-8 w-8 shrink-0 text-success" />
        <div className="text-sm text-muted-foreground">
          Open — merge via <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">rig</code> from
          the maintainer&apos;s machine.
        </div>
      </div>
      <Button
        variant="success"
        size="sm"
        disabled
        title="Rig Web is read-only; merging happens via the rig CLI"
      >
        Merge pull request
      </Button>
    </div>
  );
}

export function PRDetailPage() {
  const { id = '' } = useParams();
  const { metadata, refs, owner } = useOutletContext<RepoContext>();
  const { prs, loading: prsLoading } = usePRs(owner, metadata.repoId, metadata.maintainers);
  const { getDisplayName, requestProfiles } = useProfileCache();

  const pr = useMemo(() => {
    return prs.find((p) => p.eventId === id) ?? null;
  }, [prs, id]);

  useEffect(() => {
    if (pr) requestProfiles([pr.authorPubkey]);
  }, [pr, requestProfiles]);

  const eventIds = useMemo(() => (pr ? [pr.eventId] : []), [pr]);
  const { comments, loading: commentsLoading } = useComments(eventIds);

  // Use the latest commit SHA for diff view
  const latestCommitSha = pr?.commitShas[pr.commitShas.length - 1] ?? null;
  const { commit: _commit, changedFiles, loading: diffLoading } = useCommitDetail(
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

  const authorDisplayName = getDisplayName(pr.authorPubkey);
  const commitCount = pr.commitShas.length;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h2 className="text-xl font-semibold">{pr.title}</h2>
        <Badge className={STATUS_BADGE_CLASS[pr.status] ?? ''}>
          {STATUS_LABEL[pr.status] ?? pr.status}
        </Badge>
      </div>

      <p className="text-sm text-muted-foreground">
        <span className="font-medium text-foreground">{authorDisplayName}</span> wants to merge{' '}
        {commitCount} commit{commitCount !== 1 ? 's' : ''} into{' '}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{pr.baseBranch}</code>
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="text-[10px]">
          {commitCount} commit{commitCount !== 1 ? 's' : ''}
        </Badge>
        {!diffLoading && (
          <Badge variant="outline" className="text-[10px]">
            {changedFiles.length} file{changedFiles.length !== 1 ? 's' : ''} changed
          </Badge>
        )}
      </div>

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

        <TabsContent value="conversation" className="space-y-4">
          {commentsLoading ? (
            <div className="space-y-4">
              {Array.from({ length: 3 }, (_, i) => (
                <Skeleton key={i} className="h-24 w-full" />
              ))}
            </div>
          ) : (
            <>
              <CommentThread
                // The PR body (`description` tag, `rig pr create --body`) is
                // the opening comment when present; otherwise fall back to
                // the raw format-patch text with headers/diffstat/diff
                // stripped out. The full diff still lives in Files Changed.
                originalContent={pr.description ?? stripPatchHeaders(pr.content)}
                originalAuthor={pr.authorPubkey}
                originalCreatedAt={pr.createdAt}
                comments={comments}
              />
              <MergeStatusBox pr={pr} />
            </>
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
