import { useState, useMemo, useEffect } from 'react';
import { useOutletContext, Link } from 'react-router';
import type { RepoContext } from '@/app/repo-layout';
import { usePRs } from '@/hooks/use-prs';
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

const STATUS_BADGE: Record<string, { variant: 'default' | 'secondary' | 'destructive' | 'outline'; label: string }> = {
  open: { variant: 'default', label: 'Open' },
  applied: { variant: 'secondary', label: 'Merged' },
  closed: { variant: 'destructive', label: 'Closed' },
  draft: { variant: 'outline', label: 'Draft' },
};

export function PRListPage() {
  const { metadata, owner, repo } = useOutletContext<RepoContext>();
  const { prs, loading, error } = usePRs(owner, metadata.repoId);
  const { getDisplayName, requestProfiles } = useProfileCache();
  const [filter, setFilter] = useState<'open' | 'closed'>('open');

  useEffect(() => {
    if (prs.length > 0) {
      requestProfiles(prs.map((p) => p.authorPubkey));
    }
  }, [prs, requestProfiles]);

  const openCount = useMemo(() => prs.filter((p) => p.status === 'open' || p.status === 'draft').length, [prs]);
  const closedCount = useMemo(() => prs.filter((p) => p.status === 'closed' || p.status === 'applied').length, [prs]);
  const filtered = useMemo(() => {
    if (filter === 'open') return prs.filter((p) => p.status === 'open' || p.status === 'draft');
    return prs.filter((p) => p.status === 'closed' || p.status === 'applied');
  }, [prs, filter]);

  if (error) {
    return <div className="text-destructive-foreground">Failed to load pull requests: {error.message}</div>;
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
          No {filter === 'open' ? 'open' : 'closed'} pull requests found.
        </div>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableBody>
              {filtered.map((pr) => {
                const badge = STATUS_BADGE[pr.status] ?? STATUS_BADGE['open']!;
                return (
                  <TableRow key={pr.eventId}>
                    <TableCell className="w-16 py-2 pl-3 pr-0">
                      <Badge variant={badge.variant} className="text-[10px]">
                        {badge.label}
                      </Badge>
                    </TableCell>
                    <TableCell className="py-2">
                      <div>
                        <Link
                          to={`/${owner}/${repo}/pulls/${pr.eventId}`}
                          className="font-medium hover:text-primary hover:underline"
                        >
                          {pr.title}
                        </Link>
                        <span className="ml-2 text-xs text-muted-foreground">
                          → {pr.baseBranch}
                        </span>
                      </div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        opened {formatRelativeDate(pr.createdAt)} by {getDisplayName(pr.authorPubkey)}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
