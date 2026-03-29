import { useEffect, useMemo } from 'react';
import { useParams, useOutletContext, Link } from 'react-router';
import type { RepoContext } from '@/app/repo-layout';
import { useCommitLog } from '@/hooks/use-commit-log';
import { useProfileCache } from '@/hooks/use-profile-cache';
import { parseAuthorIdent } from '../../git-objects.js';
import { formatRelativeDate } from '../../date-utils.js';
import { resolveRefSha } from '@/lib/ref-utils';
import { Skeleton } from '@/components/ui/skeleton';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  Table,
  TableBody,
  TableCell,
  TableRow,
} from '@/components/ui/table';

export function CommitLogPage() {
  const { ref = '' } = useParams();
  const { metadata, refs, owner, repo } = useOutletContext<RepoContext>();

  const startSha = useMemo(() => {
    if (!refs) return null;
    return resolveRefSha(ref, refs) ?? null;
  }, [refs, ref]);

  const { entries, loading, error } = useCommitLog(startSha, metadata.repoId, refs);
  const { getDisplayName: _getDisplayName, requestProfiles } = useProfileCache();

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
            <Table>
              <TableBody>
                {commits.map((entry) => {
                  const author = parseAuthorIdent(entry.commit.author);
                  const message = entry.commit.message.split('\n')[0] ?? '';
                  const initials = (author?.name ?? '?').slice(0, 2).toUpperCase();
                  const relDate = author?.timestamp
                    ? formatRelativeDate(author.timestamp)
                    : '';
                  return (
                    <TableRow key={entry.sha}>
                      <TableCell className="w-8 py-2 pl-3 pr-0">
                        <Avatar className="h-6 w-6">
                          <AvatarFallback className="text-[10px]">{initials}</AvatarFallback>
                        </Avatar>
                      </TableCell>
                      <TableCell className="py-2">
                        <Link
                          to={`/${owner}/${repo}/commit/${entry.sha}`}
                          className="line-clamp-1 hover:text-primary hover:underline"
                        >
                          {message}
                        </Link>
                      </TableCell>
                      <TableCell className="py-2 text-right font-mono text-xs text-muted-foreground">
                        <Link
                          to={`/${owner}/${repo}/commit/${entry.sha}`}
                          className="hover:text-primary hover:underline"
                        >
                          {entry.sha.slice(0, 7)}
                        </Link>
                      </TableCell>
                      <TableCell className="py-2 text-right text-xs text-muted-foreground">
                        {relDate}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </div>
      ))}
    </div>
  );
}
