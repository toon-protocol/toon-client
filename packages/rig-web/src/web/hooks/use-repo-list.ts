import { useMemo } from 'react';
import { useRigConfig } from './use-rig-config.js';
import { useRelay } from './use-relay.js';
import { parseRepoAnnouncement } from '../nip34-parsers.js';
import { npubToHex } from '../npub.js';
import type { RepoMetadata, NostrFilter } from '../nip34-parsers.js';

/**
 * A repo announcement plus the `created_at` of its kind:30617 event —
 * `parseRepoAnnouncement` drops the timestamp, but the raw event carries it, so
 * we thread it through here for the list's honest "Updated {relative}" line
 * (when the metadata was last (re)published; there is no separate push clock in
 * the announcement).
 */
export type RepoListEntry = RepoMetadata & { announcedAt: number };

interface UseRepoListResult {
  repos: RepoListEntry[];
  loading: boolean;
  error: Error | null;
}

export function useRepoList(): UseRepoListResult {
  const { relayUrl, owner } = useRigConfig();

  const filter = useMemo<NostrFilter>(() => {
    const f: NostrFilter = { kinds: [30617] };
    if (owner) {
      try {
        const hex = owner.startsWith('npub1') ? npubToHex(owner) : owner;
        f.authors = [hex];
      } catch {
        // Invalid owner — show all repos
      }
    }
    return f;
  }, [owner]);

  const { events, loading, error } = useRelay(relayUrl, filter);

  const repos = useMemo(() => {
    const parsed: RepoListEntry[] = [];
    for (const ev of events) {
      const repo = parseRepoAnnouncement(ev);
      if (repo) parsed.push({ ...repo, announcedAt: ev.created_at });
    }
    // Newest announcement first — GitHub's default "Last pushed" ordering.
    parsed.sort((a, b) => b.announcedAt - a.announcedAt);
    return parsed;
  }, [events]);

  return { repos, loading, error };
}
