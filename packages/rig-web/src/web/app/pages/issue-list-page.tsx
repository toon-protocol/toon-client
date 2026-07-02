import { useState, useMemo, useEffect } from 'react';
import { useOutletContext, Link } from 'react-router';
import type { RepoContext } from '@/app/repo-layout';
import { useIssues } from '@/hooks/use-issues';
import { useProfileCache } from '@/hooks/use-profile-cache';
import { formatRelativeDate } from '../../date-utils.js';
import { OpenCloseToggle } from '@/components/open-close-toggle';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableRow,
} from '@/components/ui/table';

export function IssueListPage() {
  const { metadata, owner, repo } = useOutletContext<RepoContext>();
  const { issues, unparseable, loading, error } = useIssues(owner, metadata.repoId);
  const { getDisplayName, requestProfiles } = useProfileCache();
  const [filter, setFilter] = useState<'open' | 'closed'>('open');

  useEffect(() => {
    if (issues.length > 0) {
      requestProfiles(issues.map((i) => i.authorPubkey));
    }
  }, [issues, requestProfiles]);

  const openCount = useMemo(() => issues.filter((i) => i.status === 'open').length, [issues]);
  const closedCount = useMemo(() => issues.filter((i) => i.status === 'closed').length, [issues]);
  const filtered = useMemo(() => issues.filter((i) => i.status === filter), [issues, filter]);

  if (error) {
    return <div className="text-destructive-foreground">Failed to load issues: {error.message}</div>;
  }

  if (loading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-10 w-48" />
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <OpenCloseToggle
        openCount={openCount}
        closedCount={closedCount}
        value={filter}
        onChange={setFilter}
      />

      {filtered.length === 0 ? (
        <div className="py-8 text-center text-muted-foreground">
          No {filter} issues found.
        </div>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableBody>
              {filtered.map((issue) => (
                <TableRow key={issue.eventId}>
                  <TableCell className="w-8 py-2 pl-3 pr-0">
                    {issue.status === 'open' ? (
                      <svg className="h-4 w-4 text-green-600" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                        <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1" fill="none" />
                      </svg>
                    ) : (
                      <svg className="h-4 w-4 text-purple-600" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                        <circle cx="8" cy="8" r="5" />
                      </svg>
                    )}
                  </TableCell>
                  <TableCell className="py-2">
                    <div>
                      <Link
                        to={`/${owner}/${repo}/issues/${issue.eventId}`}
                        className="font-medium hover:text-primary hover:underline"
                      >
                        {issue.title}
                      </Link>
                      {issue.labels.length > 0 && (
                        <span className="ml-2 inline-flex gap-1">
                          {issue.labels.map((label) => (
                            <Badge key={label} variant="secondary" className="text-[10px]">
                              {label}
                            </Badge>
                          ))}
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      opened {formatRelativeDate(issue.createdAt)} by {getDisplayName(issue.authorPubkey)}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Events that failed to decode are shown degraded, never dropped (#276) */}
      {unparseable.length > 0 && (
        <div className="rounded-md border border-dashed">
          {unparseable.map((u, i) => (
            <div
              key={u.id ?? `unparseable-${i}`}
              data-testid="unparseable-event"
              className="border-b p-3 text-sm last:border-b-0"
            >
              <div className="flex items-center gap-2">
                <svg className="h-4 w-4 text-yellow-600" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                  <path d="M8.22 1.754a.25.25 0 00-.44 0L1.698 13.132a.25.25 0 00.22.368h12.164a.25.25 0 00.22-.368L8.22 1.754zm-1.763-.707c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0114.082 15H1.918a1.75 1.75 0 01-1.543-2.575L6.457 1.047zM9 11a1 1 0 11-2 0 1 1 0 012 0zm-.25-5.25a.75.75 0 00-1.5 0v2.5a.75.75 0 001.5 0v-2.5z" />
                </svg>
                <span className="font-medium">Unparseable event</span>
                {u.id && (
                  <code className="font-mono text-xs text-muted-foreground">{u.id.slice(0, 8)}</code>
                )}
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                This event arrived from the relay but could not be decoded ({u.error}).
              </div>
              <details className="mt-1">
                <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                  View raw event
                </summary>
                <pre className="mt-1 overflow-x-auto rounded bg-muted p-2 text-xs">{u.raw}</pre>
              </details>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
