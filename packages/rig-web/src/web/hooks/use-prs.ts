import { useMemo } from 'react';
import { useRigConfig } from './use-rig-config.js';
import { useRelay } from './use-relay.js';
import { npubToHex } from '../npub.js';
import { parsePR, resolvePRStatus } from '../nip34-parsers.js';
import { buildPRListFilter, buildStatusFilter } from '../relay-client.js';
import type { PRMetadata, NostrFilter } from '../nip34-parsers.js';

interface UsePRsResult {
  prs: PRMetadata[];
  loading: boolean;
  error: Error | null;
}

export function usePRs(
  owner: string,
  repoId: string,
  maintainers: string[] = []
): UsePRsResult {
  const { relayUrl } = useRigConfig();

  const ownerHex = useMemo(() => {
    try {
      return owner.startsWith('npub1') ? npubToHex(owner) : owner;
    } catch {
      return null;
    }
  }, [owner]);

  // Authorized status authors (#287): owner ∪ declared maintainers. Status
  // events from anyone else are ignored for state resolution.
  const authorized = useMemo(() => {
    const set = new Set<string>(maintainers.map((m) => m.toLowerCase()));
    if (ownerHex) set.add(ownerHex.toLowerCase());
    return set;
  }, [ownerHex, maintainers]);

  const prFilter = useMemo<NostrFilter | null>(() => {
    if (!ownerHex) return null;
    return buildPRListFilter(ownerHex, repoId);
  }, [ownerHex, repoId]);

  const {
    events: prEvents,
    loading: prsLoading,
    error: prsError,
  } = useRelay(relayUrl, prFilter);

  const statusFilter = useMemo<NostrFilter | null>(() => {
    if (prEvents.length === 0) return null;
    const ids = prEvents.filter((e) => e.kind === 1617).map((e) => e.id);
    if (ids.length === 0) return null;
    return buildStatusFilter(ids);
  }, [prEvents]);

  const { events: statusEvents, loading: statusLoading } = useRelay(
    relayUrl,
    statusFilter
  );

  const prs = useMemo(() => {
    const parsed: PRMetadata[] = [];
    for (const ev of prEvents) {
      const pr = parsePR(ev);
      if (pr) {
        pr.status = resolvePRStatus(pr.eventId, statusEvents, authorized);
        parsed.push(pr);
      }
    }
    return parsed.sort((a, b) => b.createdAt - a.createdAt);
  }, [prEvents, statusEvents, authorized]);

  return {
    prs,
    loading: prsLoading || statusLoading,
    error: prsError,
  };
}
