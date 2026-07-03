import { useMemo } from 'react';
import { useRigConfig } from './use-rig-config.js';
import { useRelay } from './use-relay.js';
import { npubToHex } from '../npub.js';
import { parseIssue, resolveIssueStatus } from '../nip34-parsers.js';
import {
  buildIssueListFilter,
  buildIssueCloseFilter,
} from '../relay-client.js';
import type { UnparseableEvent } from '../relay-client.js';
import type { IssueMetadata, NostrFilter } from '../nip34-parsers.js';

interface UseIssuesResult {
  issues: IssueMetadata[];
  /** Issue-query EVENT frames that failed to decode (rendered degraded, not dropped) */
  unparseable: UnparseableEvent[];
  loading: boolean;
  error: Error | null;
}

export function useIssues(
  owner: string,
  repoId: string,
  maintainers: string[] = []
): UseIssuesResult {
  const { relayUrl } = useRigConfig();

  const ownerHex = useMemo(() => {
    try {
      return owner.startsWith('npub1') ? npubToHex(owner) : owner;
    } catch {
      return null;
    }
  }, [owner]);

  // Authorized status authors (#287): owner ∪ declared maintainers. A close
  // event (kind:1632) from anyone else does NOT close the issue.
  const authorized = useMemo(() => {
    const set = new Set<string>(maintainers.map((m) => m.toLowerCase()));
    if (ownerHex) set.add(ownerHex.toLowerCase());
    return set;
  }, [ownerHex, maintainers]);

  const issueFilter = useMemo<NostrFilter | null>(() => {
    if (!ownerHex) return null;
    return buildIssueListFilter(ownerHex, repoId);
  }, [ownerHex, repoId]);

  const {
    events: issueEvents,
    unparseable,
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
        issue.status = resolveIssueStatus(issue.eventId, closeEvents, authorized);
        parsed.push(issue);
      }
    }
    // Sort by created_at descending (newest first)
    return parsed.sort((a, b) => b.createdAt - a.createdAt);
  }, [issueEvents, closeEvents, authorized]);

  return {
    issues,
    unparseable,
    loading: issuesLoading || closeLoading,
    error: issuesError,
  };
}
