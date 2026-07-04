import { useState, useMemo, useEffect } from 'react';
import { useOutletContext, Link } from 'react-router';
import { Search, Plus } from 'lucide-react';
import type { RepoContext } from '@/app/repo-layout';
import { useIssues } from '@/hooks/use-issues';
import { useProfileCache } from '@/hooks/use-profile-cache';
import { formatRelativeDate } from '../../date-utils.js';
import { OpenCloseToggle } from '@/components/open-close-toggle';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Table,
  TableBody,
  TableCell,
  TableRow,
} from '@/components/ui/table';

/**
 * Where "how do I use the rig CLI?" is documented (mirrors CloneInstructions).
 */
const RIG_CLI_DOCS_URL =
  'https://github.com/toon-protocol/toon-client/tree/main/packages/rig#readme';

/**
 * "New issue" affordance: rig has no web creation form (issues are filed with
 * `rig issue create`, a paid write signed from the caller's own identity), so
 * this is a hand-off popover rather than a fake form.
 */
function NewIssuePopover() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="success" size="sm" className="gap-1.5">
          <Plus aria-hidden="true" className="h-3.5 w-3.5" />
          New issue
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[26rem] max-w-[calc(100vw-2rem)] p-4" align="end">
        <div className="space-y-3">
          <div className="space-y-1">
            <h3 className="text-sm font-semibold">Issues are filed with the rig CLI</h3>
            <p className="text-xs text-muted-foreground">
              There's no web form — filing an issue (kind:1621) is a paid write signed
              from your own identity, from your terminal.
            </p>
          </div>
          <pre className="overflow-x-auto rounded-md border bg-muted/50 p-3 font-mono text-xs leading-relaxed">
            {'rig issue create --title "<title>" --body "<description>"'}
          </pre>
          <p className="text-xs text-muted-foreground">
            See the{' '}
            <a
              href={RIG_CLI_DOCS_URL}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2 hover:text-foreground"
            >
              rig CLI docs
            </a>
            .
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function IssueListPage() {
  const { metadata, owner, repo } = useOutletContext<RepoContext>();
  const { issues, unparseable, loading, error } = useIssues(owner, metadata.repoId, metadata.maintainers);
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
      <div className="flex items-center gap-3">
        <div className="relative min-w-0 flex-1">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <input
            type="text"
            readOnly
            value={`is:${filter}`}
            aria-label="Issue filter (use the Open/Closed toggle below to change it)"
            title="Full-text filtering isn't available yet — use the Open/Closed toggle below."
            className="h-9 w-full rounded-md border bg-background pl-8 pr-3 text-sm text-muted-foreground shadow-xs outline-none"
          />
        </div>
        <NewIssuePopover />
      </div>

      <div className="rounded-md border">
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
          <Table>
            <TableBody>
              {filtered.map((issue) => (
                <TableRow key={issue.eventId}>
                  <TableCell className="w-8 py-3 pl-3 pr-0 align-top">
                    {issue.status === 'open' ? (
                      <svg className="mt-0.5 h-4 w-4 text-success" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                        <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1" fill="none" />
                      </svg>
                    ) : (
                      <svg className="mt-0.5 h-4 w-4 text-purple-600 dark:text-purple-400" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                        <circle cx="8" cy="8" r="5" />
                      </svg>
                    )}
                  </TableCell>
                  <TableCell className="py-3">
                    <div>
                      <Link
                        to={`/${owner}/${repo}/issues/${issue.eventId}`}
                        className="font-semibold hover:text-primary hover:underline"
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
        )}
      </div>

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
