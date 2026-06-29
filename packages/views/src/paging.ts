/**
 * Feed pagination helpers (node-safe, no React).
 *
 * MCP-app hosts discourage in-iframe infinite scroll, so a feed loads more by
 * issuing another FREE `toon_query` for the next page rather than streaming
 * endlessly. NIP-01 pages backward in time with `until`, so the next page is
 * "everything older than the oldest event we already have".
 */

import { type NostrEvent } from './types.js';

/** A NIP-01 filter object (only the time-window fields matter for paging). */
export type NostrFilterLike = Record<string, unknown> & {
  until?: number;
  since?: number;
  limit?: number;
};

/**
 * The filter for the NEXT (older) page of a feed: the base filter with `until`
 * pinned just before the oldest event currently shown. Returns the base filter
 * unchanged when there are no events yet (the first page is the base filter).
 */
export function nextPageFilter(
  events: readonly NostrEvent[],
  baseFilter: NostrFilterLike
): NostrFilterLike {
  if (events.length === 0) return baseFilter;
  const oldest = events.reduce((min, e) => Math.min(min, e.created_at), Infinity);
  // `until` is inclusive in NIP-01, so step one second past the oldest event to
  // avoid re-fetching it as the first item of the next page.
  return { ...baseFilter, until: oldest - 1 };
}

/**
 * Merge a freshly-fetched page into the existing feed: de-dupe by event id and
 * keep newest-first order, so "load more" appends older notes without
 * duplicating any the feed already holds.
 */
export function mergePage(
  existing: readonly NostrEvent[],
  page: readonly NostrEvent[]
): NostrEvent[] {
  const byId = new Map<string, NostrEvent>();
  for (const e of existing) byId.set(e.id, e);
  for (const e of page) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) => b.created_at - a.created_at);
}
