import { useMemo } from 'react';
import { useRigConfig } from './use-rig-config.js';
import { useRelay } from './use-relay.js';
import { npubToHex } from '../npub.js';
import { parseIssue, resolveIssueStatus } from '../nip34-parsers.js';
import {
  buildIssueListFilter,
  buildIssueCloseFilter,
} from '../relay-client.js';
import type { IssueMetadata, NostrFilter } from '../nip34-parsers.js';

interface UseIssuesResult {
  issues: IssueMetadata[];
  loading: boolean;
  error: Error | null;
}

export function useIssues(owner: string, repoId: string): UseIssuesResult {
  const { relayUrl } = useRigConfig();

  const ownerHex = useMemo(() => {
    try {
      return owner.startsWith('npub1') ? npubToHex(owner) : owner;
    } catch {
      return null;
    }
  }, [owner]);

  const issueFilter = useMemo<NostrFilter | null>(() => {
    if (!ownerHex) return null;
    return buildIssueListFilter(ownerHex, repoId);
  }, [ownerHex, repoId]);

  const {
    events: issueEvents,
    loading: issuesLoading,
    error: issuesError,
  } = useRelay(relayUrl, issueFilter);

  // Fetch close events for all issue IDs
  const closeFilter = useMemo<NostrFilter | null>(() => {
    if (issueEvents.length === 0) return null;
    const ids = issueEvents.filter((e) => e.kind === 1621).map((e) => e.id);
    if (ids.length === 0) return null;
    return buildIssueCloseFilter(ids);
  }, [issueEvents]);

  const { events: closeEvents, loading: closeLoading } = useRelay(
    relayUrl,
    closeFilter
  );

  const issues = useMemo(() => {
    const parsed: IssueMetadata[] = [];
    for (const ev of issueEvents) {
      const issue = parseIssue(ev);
      if (issue) {
        // Override hardcoded 'open' status with resolved status
        issue.status = resolveIssueStatus(issue.eventId, closeEvents);
        parsed.push(issue);
      }
    }
    // Sort by created_at descending (newest first)
    return parsed.sort((a, b) => b.createdAt - a.createdAt);
  }, [issueEvents, closeEvents]);

  return {
    issues,
    loading: issuesLoading || closeLoading,
    error: issuesError,
  };
}
