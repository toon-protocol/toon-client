import { useMemo } from 'react';
import { useRigConfig } from './use-rig-config.js';
import { useRelay } from './use-relay.js';
import { resolveIssueStatus } from '../nip34-parsers.js';
import type { NostrEvent, NostrFilter } from '../nip34-parsers.js';

/** A repo-list row's minimal shape, as needed to key + authorize its issues. */
interface RepoRef {
  ownerPubkey: string;
  repoId: string;
  maintainers: string[];
}

interface UseRepoIssueCountsResult {
  /** Keyed by `${ownerPubkey}/${repoId}` → number of OPEN issues. */
  counts: Map<string, number>;
  loading: boolean;
}

const HEX64_RE = /^[0-9a-f]{64}$/i;

/**
 * Compute the open-issue count per repository for the repo-list page, in
 * ONE batched relay query pair (issues + status events) rather than one
 * pair per repo — mirrors {@link import('./use-issues.js').useIssues} but
 * generalized across many repos at once.
 */
export function useRepoIssueCounts(
  repos: RepoRef[]
): UseRepoIssueCountsResult {
  const { relayUrl } = useRigConfig();

  // Repos with a well-formed hex owner pubkey, each paired with its repo
  // address a-tag (`30617:<owner>:<repoId>`). Non-hex owners are skipped —
  // they can't be addressed by a-tag and would otherwise poison the batch
  // filter with a malformed value.
  const addressed = useMemo(() => {
    return repos
      .filter((r) => HEX64_RE.test(r.ownerPubkey))
      .map((r) => ({
        ...r,
        aTag: `30617:${r.ownerPubkey}:${r.repoId}`,
        key: `${r.ownerPubkey}/${r.repoId}`,
      }));
  }, [repos]);

  const aTags = useMemo(
    () => addressed.map((r) => r.aTag),
    [addressed]
  );

  const issueFilter = useMemo<NostrFilter | null>(() => {
    if (aTags.length === 0) return null;
    return { kinds: [1621], '#a': aTags, limit: 500 };
  }, [aTags]);

  const { events: issueEvents, loading: issuesLoading } = useRelay(
    relayUrl,
    issueFilter
  );

  // Status events (kind:1630-1633) carry the repo's `#a` tag (NIP-34), so
  // one query — filtered by the same batch of a-tags — covers every repo's
  // close events at once. resolveIssueStatus further narrows to kind:1632
  // events referencing a given issue's id via its `#e` tag, from an
  // authorized author.
  const statusFilter = useMemo<NostrFilter | null>(() => {
    if (aTags.length === 0) return null;
    return { kinds: [1630, 1631, 1632, 1633], '#a': aTags, limit: 1000 };
  }, [aTags]);

  const { events: statusEvents, loading: statusesLoading } = useRelay(
    relayUrl,
    statusFilter
  );

  const counts = useMemo(() => {
    const result = new Map<string, number>();
    if (addressed.length === 0) return result;

    // Authorized status authors per repo: owner ∪ declared maintainers
    // (lowercased), exactly like use-issues.ts.
    const authorizedByKey = new Map<string, Set<string>>();
    for (const repo of addressed) {
      const set = new Set<string>(repo.maintainers.map((m) => m.toLowerCase()));
      set.add(repo.ownerPubkey.toLowerCase());
      authorizedByKey.set(repo.key, set);
      // Every addressed repo gets an entry, even with zero issues, so
      // callers can distinguish "0 open" from "still loading" (a missing
      // key means the repo was never addressable).
      result.set(repo.key, 0);
    }

    // Group issue events by the repo a-tag they were published against.
    const issuesByAtag = new Map<string, NostrEvent[]>();
    for (const ev of issueEvents) {
      const aTag = ev.tags.find((t) => t[0] === 'a')?.[1];
      if (!aTag) continue;
      const bucket = issuesByAtag.get(aTag);
      if (bucket) {
        bucket.push(ev);
      } else {
        issuesByAtag.set(aTag, [ev]);
      }
    }

    for (const repo of addressed) {
      const repoIssues = issuesByAtag.get(repo.aTag);
      if (!repoIssues || repoIssues.length === 0) continue;
      const authorized = authorizedByKey.get(repo.key) ?? new Set<string>();
      let open = 0;
      for (const issue of repoIssues) {
        const status = resolveIssueStatus(issue.id, statusEvents, authorized);
        if (status === 'open') open += 1;
      }
      result.set(repo.key, open);
    }

    return result;
  }, [addressed, issueEvents, statusEvents]);

  return {
    counts,
    loading: issuesLoading || statusesLoading,
  };
}
