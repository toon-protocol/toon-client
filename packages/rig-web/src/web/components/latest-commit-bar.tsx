import { useEffect } from 'react';
import { Link } from 'react-router';
import { History } from 'lucide-react';
import { useCommitLog } from '@/hooks/use-commit-log';
import { useProfileCache } from '@/hooks/use-profile-cache';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { parseAuthorIdent } from '../git-objects.js';
import { formatRelativeDate } from '../date-utils.js';
import type { RepoRefs } from '../nip34-parsers.js';

/**
 * Same depth CommitLogPage walks by default — reusing the cap keeps the
 * "N commits" count here consistent with what /commits shows, instead of
 * inventing a different budget for this compact header.
 */
const COMMIT_LOG_DEPTH = 50;

interface LatestCommitBarProps {
  /** SHA of the current ref's tip commit; null while it's still resolving. */
  commitSha: string | null;
  repoId: string;
  refs: RepoRefs | null;
  owner: string;
  repo: string;
  /** Short ref name (e.g. "main") for the "N commits" history link. */
  refForUrl: string;
}

/**
 * GitHub-style "latest commit" strip that headers the file-list card: author
 * avatar + name + commit message + short sha on the left, a "N commits"
 * history link on the right.
 *
 * Reuses `useCommitLog` — the same hook CommitLogPage walks for the full
 * history — so both the tip commit's metadata and the count are real data,
 * not fabricated. When the walk hits its depth cap the count reads "N+"
 * rather than implying an exact total; when the tip commit can't be resolved
 * at all (fresh repo, missing Arweave object, relay hiccup) this renders just
 * the history link instead of guessing at an author or message.
 */
export function LatestCommitBar({
  commitSha,
  repoId,
  refs,
  owner,
  repo,
  refForUrl,
}: LatestCommitBarProps) {
  const { entries, loading, hasMore } = useCommitLog(commitSha, repoId, refs, COMMIT_LOG_DEPTH);
  const { getDisplayName, requestProfiles } = useProfileCache();

  const tip = entries[0];
  const author = tip ? parseAuthorIdent(tip.commit.author) : null;
  const authorPubkey =
    author?.email && /^[0-9a-f]{64}$/i.test(author.email) ? author.email : null;

  useEffect(() => {
    if (authorPubkey) requestProfiles([authorPubkey]);
  }, [authorPubkey, requestProfiles]);

  if (loading || !commitSha) {
    return (
      <div className="flex items-center gap-3 rounded-t-md border-b bg-muted/40 px-4 py-2.5">
        <Skeleton className="h-5 w-full max-w-sm" />
      </div>
    );
  }

  const commitsPath = `/${owner}/${repo}/commits/${refForUrl}`;
  const countLabel =
    entries.length === 0
      ? 'Commits'
      : `${entries.length}${hasMore ? '+' : ''} commit${
          entries.length === 1 && !hasMore ? '' : 's'
        }`;

  const historyLink = (
    <Link
      to={commitsPath}
      className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground hover:text-primary hover:underline"
    >
      <History aria-hidden="true" className="h-3.5 w-3.5" />
      {countLabel}
    </Link>
  );

  if (!tip) {
    // Tip commit couldn't be resolved — don't fabricate an author/message,
    // just offer the honest browse-history affordance.
    return (
      <div className="flex items-center justify-end rounded-t-md border-b bg-muted/40 px-4 py-2.5">
        {historyLink}
      </div>
    );
  }

  const message = tip.commit.message.split('\n')[0] ?? '';
  const initials = (author?.name ?? '?').slice(0, 2).toUpperCase();
  const displayName = authorPubkey ? getDisplayName(authorPubkey) : (author?.name ?? 'Unknown');
  const relDate = author?.timestamp ? formatRelativeDate(author.timestamp) : null;
  const commitPath = `/${owner}/${repo}/commit/${tip.sha}`;

  return (
    <div className="flex items-center justify-between gap-3 rounded-t-md border-b bg-muted/40 px-4 py-2.5 text-sm">
      <div className="flex min-w-0 items-center gap-2">
        <Avatar className="h-5 w-5 shrink-0">
          <AvatarFallback className="text-[10px]">{initials}</AvatarFallback>
        </Avatar>
        <span className="shrink-0 font-medium">{displayName}</span>
        <Link
          to={commitPath}
          className="min-w-0 truncate text-foreground hover:text-primary hover:underline"
          title={message}
        >
          {message}
        </Link>
        {relDate && (
          <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
            {relDate}
          </span>
        )}
        <Link
          to={commitPath}
          className="shrink-0 font-mono text-xs text-muted-foreground hover:text-primary hover:underline"
        >
          {tip.sha.slice(0, 7)}
        </Link>
      </div>
      {historyLink}
    </div>
  );
}
