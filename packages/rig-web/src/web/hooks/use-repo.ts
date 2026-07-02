import { useMemo } from 'react';
import { useRigConfig } from './use-rig-config.js';
import { useRelay } from './use-relay.js';
import { npubToHex } from '../npub.js';
import { parseRepoAnnouncement, parseRepoRefs } from '../nip34-parsers.js';
import type { RepoMetadata, RepoRefs, NostrFilter } from '../nip34-parsers.js';

interface UseRepoResult {
  metadata: RepoMetadata | null;
  refs: RepoRefs | null;
  loading: boolean;
  error: Error | null;
}

export function useRepo(owner: string, repo: string): UseRepoResult {
  const { relayUrl } = useRigConfig();

  const ownerHex = useMemo(() => {
    try {
      return owner.startsWith('npub1') ? npubToHex(owner) : owner;
    } catch {
      return null;
    }
  }, [owner]);

  const repoFilter = useMemo<NostrFilter | null>(() => {
    if (!ownerHex) return null;
    return { kinds: [30617], authors: [ownerHex], '#d': [repo] };
  }, [ownerHex, repo]);

  const refsFilter = useMemo<NostrFilter | null>(() => {
    if (!ownerHex) return null;
    return { kinds: [30618], authors: [ownerHex], '#d': [repo] };
  }, [ownerHex, repo]);

  const {
    events: repoEvents,
    loading: repoLoading,
    error: repoError,
  } = useRelay(relayUrl, repoFilter);

  const {
    events: refsEvents,
    loading: refsLoading,
    error: refsError,
  } = useRelay(relayUrl, refsFilter);

  const metadata = useMemo(() => {
    if (repoEvents.length === 0) return null;
    const first = repoEvents[0];
    return first ? (parseRepoAnnouncement(first) ?? null) : null;
  }, [repoEvents]);

  const refs = useMemo(() => {
    if (refsEvents.length === 0) return null;
    const first = refsEvents[0];
    return first ? (parseRepoRefs(first) ?? null) : null;
  }, [refsEvents]);

  return {
    metadata,
    refs,
    loading: repoLoading || refsLoading,
    error: repoError || refsError,
  };
}
