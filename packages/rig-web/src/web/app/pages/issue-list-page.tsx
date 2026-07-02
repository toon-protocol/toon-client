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
  const { issues, loading, error } = useIssues(owner, metadata.repoId);
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
    </div>
  );
}
