import { useMemo } from 'react';
import { useRigConfig } from './use-rig-config.js';
import { useRelay } from './use-relay.js';
import { parseComment } from '../nip34-parsers.js';
import { buildCommentFilter } from '../relay-client.js';
import type { CommentMetadata, NostrFilter } from '../nip34-parsers.js';

interface UseCommentsResult {
  comments: CommentMetadata[];
  loading: boolean;
  error: Error | null;
}

export function useComments(eventIds: string[]): UseCommentsResult {
  const { relayUrl } = useRigConfig();

  const filter = useMemo<NostrFilter | null>(() => {
    if (eventIds.length === 0) return null;
    return buildCommentFilter(eventIds);
  }, [eventIds]);

  const { events, loading, error } = useRelay(relayUrl, filter);

  const comments = useMemo(() => {
    const parsed: CommentMetadata[] = [];
    for (const ev of events) {
      const comment = parseComment(ev);
      if (comment) parsed.push(comment);
    }
    return parsed.sort((a, b) => a.createdAt - b.createdAt);
  }, [events]);

  return { comments, loading, error };
}
