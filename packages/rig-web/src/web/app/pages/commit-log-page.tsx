import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useOutletContext, Link } from 'react-router';
import { Check, Copy, Code } from 'lucide-react';
import type { RepoContext } from '@/app/repo-layout';
import { useCommitLog } from '@/hooks/use-commit-log';
import { useProfileCache } from '@/hooks/use-profile-cache';
import { parseAuthorIdent, type AuthorIdent } from '../../git-objects.js';
import { formatRelativeDate } from '../../date-utils.js';
import { resolveDefaultRef } from '../../ref-resolver.js';
import { resolveRefSha } from '@/lib/ref-utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import type { CommitLogEntry } from '../../commit-walker.js';

/**
 * Best-effort synchronous copy via the legacy `document.execCommand('copy')`
 * over a hidden textarea, same fallback used by `clone-instructions.tsx` — the
 * async Clipboard API rejects when the page is embedded without the
 * `clipboard-write` permission policy. Returns whether the copy succeeded.
 */
function legacyCopy(value: string): boolean {
  if (typeof document === 'undefined') return false;
  const ta = document.createElement('textarea');
  ta.value = value;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.left = '0';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, value.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  return ok;
}

/**
 * Author identity is a `Name <email> ts tz` line; on TOON the "email" slot
 * carries the author's hex pubkey when the commit came from a Nostr identity.
 * Resolve a profile display name for that case, else fall back to the raw
 * git author name (never fabricate a name that isn't in the data).
 */
function resolveAuthorName(
  author: AuthorIdent | null,
  getDisplayName: (pubkey: string) => string
): string | null {
  if (!author) return null;
  if (author.email.length === 64 && /^[0-9a-f]+$/.test(author.email)) {
    return getDisplayName(author.email);
  }
  return author.name;
}

interface CommitRowProps {
  entry: CommitLogEntry;
  owner: string;
  repo: string;
  authorName: string | null;
  relDate: string;
  copied: boolean;
  onCopySha: (sha: string) => void;
}

function CommitRow({ entry, owner, repo, authorName, relDate, copied, onCopySha }: CommitRowProps) {
  const message = entry.commit.message.split('\n')[0] ?? '';
  const initials = (authorName ?? '?').slice(0, 2).toUpperCase();
  const shortSha = entry.sha.slice(0, 7);

  return (
    <li className="relative flex items-center gap-3 py-3 pr-4">
      {/* Timeline rail dot for this commit — the connecting line itself is
          drawn once per date group behind the list. */}
      <div className="flex w-9 shrink-0 items-center justify-center self-stretch">
        <span
          aria-hidden="true"
          className="h-2 w-2 rounded-full border border-border bg-background"
        />
      </div>
      <Avatar className="h-8 w-8 shrink-0">
        <AvatarFallback className="text-xs">{initials}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <Link
            to={`/${owner}/${repo}/commit/${entry.sha}`}
            className="line-clamp-1 font-semibold text-foreground hover:text-primary hover:underline"
          >
            {message}
          </Link>
          {entry.commit.parentShas.length > 1 && (
            <Badge variant="outline" className="shrink-0 text-[10px]">
              Merge
            </Badge>
          )}
        </div>
        {authorName && (
          <p className="line-clamp-1 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{authorName}</span>
            {relDate ? ` committed ${relDate}` : ' committed'}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Link
          to={`/${owner}/${repo}/commit/${entry.sha}`}
          className="rounded-md border px-2 py-1 font-mono text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {shortSha}
        </Link>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={copied ? 'Commit SHA copied' : 'Copy the full commit SHA'}
          className="text-muted-foreground hover:text-foreground"
          onClick={() => onCopySha(entry.sha)}
        >
          {copied ? <Check aria-hidden="true" className="text-primary" /> : <Copy aria-hidden="true" />}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          asChild
          aria-label="Browse the repository at this point in history"
          className="text-muted-foreground hover:text-foreground"
        >
          <Link to={`/${owner}/${repo}/tree/${entry.sha}`}>
            <Code aria-hidden="true" />
          </Link>
        </Button>
      </div>
    </li>
  );
}

export function CommitLogPage() {
  const { ref = '' } = useParams();
  const { metadata, refs, owner, repo } = useOutletContext<RepoContext>();

  const startSha = useMemo(() => {
    if (!refs) return null;
    // Bare /commits (no ref in the URL) falls back to the default branch —
    // GitHub-style URLs must not require the branch segment (#277).
    if (!ref) {
      return (
        resolveRefSha(metadata.defaultBranch, refs) ??
        resolveDefaultRef(metadata, refs)?.commitSha ??
        null
      );
    }
    return resolveRefSha(ref, refs) ?? null;
  }, [refs, ref, metadata]);

  const { entries, loading, error } = useCommitLog(startSha, metadata.repoId, refs);
  const { getDisplayName, requestProfiles } = useProfileCache();

  // Request profiles for commit authors
  useEffect(() => {
    if (entries.length === 0) return;
    const pubkeys: string[] = [];
    for (const entry of entries) {
      const author = parseAuthorIdent(entry.commit.author);
      if (author?.email && author.email.length === 64 && /^[0-9a-f]+$/.test(author.email)) {
        pubkeys.push(author.email);
      }
    }
    if (pubkeys.length > 0) requestProfiles(pubkeys);
  }, [entries, requestProfiles]);

  const [copiedSha, setCopiedSha] = useState<string | null>(null);
  const onCopySha = useCallback((sha: string) => {
    const succeed = (): void => setCopiedSha(sha);
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      void navigator.clipboard.writeText(sha).then(succeed, () => {
        if (legacyCopy(sha)) succeed();
      });
      return;
    }
    if (legacyCopy(sha)) succeed();
  }, []);

  useEffect(() => {
    if (!copiedSha) return;
    const t = setTimeout(() => setCopiedSha(null), 1500);
    return () => clearTimeout(t);
  }, [copiedSha]);

  if (error) {
    return <div className="text-destructive-foreground">Failed to load commits: {error.message}</div>;
  }

  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 10 }, (_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    );
  }

  if (entries.length === 0) {
    return <div className="py-8 text-center text-muted-foreground">No commits found.</div>;
  }

  // Group commits by date
  const grouped = new Map<string, typeof entries>();
  for (const entry of entries) {
    const author = parseAuthorIdent(entry.commit.author);
    const date = author?.timestamp
      ? new Date(author.timestamp * 1000).toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
        })
      : 'Unknown date';
    const group = grouped.get(date) ?? [];
    group.push(entry);
    grouped.set(date, group);
  }

  return (
    <div className="space-y-6">
      {[...grouped.entries()].map(([date, commits]) => (
        <div key={date}>
          <h3 className="mb-2 text-sm font-medium text-muted-foreground">{date}</h3>
          <div className="rounded-md border">
            <ul className="relative divide-y">
              {/* Timeline rail: a single connector line running through every
                  commit dot in this date group (mirrors the row rail column's
                  fixed 36px width, so it's centered under each dot below). */}
              <div
                aria-hidden="true"
                className="pointer-events-none absolute bottom-0 left-[18px] top-0 w-px bg-border"
              />
              {commits.map((entry) => {
                const author = parseAuthorIdent(entry.commit.author);
                const authorName = resolveAuthorName(author, getDisplayName);
                const relDate = author?.timestamp ? formatRelativeDate(author.timestamp) : '';
                return (
                  <CommitRow
                    key={entry.sha}
                    entry={entry}
                    owner={owner}
                    repo={repo}
                    authorName={authorName}
                    relDate={relDate}
                    copied={copiedSha === entry.sha}
                    onCopySha={onCopySha}
                  />
                );
              })}
            </ul>
          </div>
        </div>
      ))}
    </div>
  );
}
