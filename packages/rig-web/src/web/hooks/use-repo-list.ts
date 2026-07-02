import { useMemo } from 'react';
import { useRigConfig } from './use-rig-config.js';
import { useRelay } from './use-relay.js';
import { parseRepoAnnouncement } from '../nip34-parsers.js';
import { npubToHex } from '../npub.js';
import type { RepoMetadata, NostrFilter } from '../nip34-parsers.js';

interface UseRepoListResult {
  repos: RepoMetadata[];
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
    const parsed: RepoMetadata[] = [];
    for (const ev of events) {
      const repo = parseRepoAnnouncement(ev);
      if (repo) parsed.push(repo);
    }
    return parsed;
  }, [events]);

  return { repos, loading, error };
}
