import { useState, useEffect, useRef } from 'react';
import { queryRelay } from '../relay-client.js';
import type { UnparseableEvent } from '../relay-client.js';
import type { NostrEvent, NostrFilter } from '../nip34-parsers.js';

interface UseRelayResult {
  events: NostrEvent[];
  /** EVENT frames that failed to decode — surfaced, never silently dropped */
  unparseable: UnparseableEvent[];
  loading: boolean;
  error: Error | null;
}

/**
 * Generic hook to query a relay with a filter and return events.
 * Re-fetches when relayUrl or filter reference changes.
 */
export function useRelay(
  relayUrl: string,
  filter: NostrFilter | null
): UseRelayResult {
  const [events, setEvents] = useState<NostrEvent[]>([]);
  const [unparseable, setUnparseable] = useState<UnparseableEvent[]>([]);
  const [loading, setLoading] = useState(!!filter);
  const [error, setError] = useState<Error | null>(null);
  const filterRef = useRef(filter);

  // Only re-fetch if filter JSON actually changed
  const filterJson = filter ? JSON.stringify(filter) : null;

  useEffect(() => {
    if (!filterJson) {
      setEvents([]);
      setUnparseable([]);
      setLoading(false);
      return;
    }

    const parsed = JSON.parse(filterJson) as NostrFilter;
    filterRef.current = parsed;
    setLoading(true);
    setError(null);

    let cancelled = false;
    const failed: UnparseableEvent[] = [];

    queryRelay(relayUrl, parsed, undefined, (u) => failed.push(u))
      .then((result) => {
        if (!cancelled) {
          setEvents(result);
          setUnparseable(failed);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [relayUrl, filterJson]);

  return { events, unparseable, loading, error };
}
