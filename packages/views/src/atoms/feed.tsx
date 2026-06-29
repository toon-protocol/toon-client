/**
 * Feed atom — a PAGINATED timeline.
 *
 * Claude Desktop (and hosts like it) give the app a fixed-height iframe and
 * SCROLL the overflow rather than growing the iframe to fit content. An
 * append-style "load more" feed therefore always grew into an internal
 * scrollbar. Instead we show one bounded PAGE of notes and REPLACE it with the
 * next/previous page — the rendered height stays roughly constant, so the feed
 * never grows into a scroll. Older pages are fetched on demand via a free
 * paginated `toon_query` (NIP-01 `until`); already-fetched pages page back
 * instantly.
 */

import { type FC, useState } from 'react';
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button.js';
import { type NostrEvent } from '../types.js';
import { mergePage, nextPageFilter, type NostrFilterLike } from '../paging.js';
import { type Atom, type AtomRenderProps } from './types.js';
import { NoteCard } from './social.js';

/** Notes per page — bounded so a page fits the host card without scrolling. */
const PAGE_SIZE = 5;

const FeedList: FC<AtomRenderProps> = (props) => {
  const { events, bind, loadMore } = props;
  // Older pages fetched beyond the bind, merged + de-duped with the bound events.
  const [extra, setExtra] = useState<NostrEvent[]>([]);
  // Index of the current page's first note within `loaded`.
  const [pageStart, setPageStart] = useState(0);
  const [busy, setBusy] = useState(false);
  // Set once an older fetch returns nothing new — the end of the feed.
  const [exhausted, setExhausted] = useState(false);

  const loaded = extra.length ? mergePage(events, extra) : events;
  const baseFilter: NostrFilterLike = (bind?.query as NostrFilterLike | undefined) ?? { kinds: [1] };

  const page = loaded.slice(pageStart, pageStart + PAGE_SIZE);
  const hasNewer = pageStart > 0;
  const hasOlderLoaded = pageStart + PAGE_SIZE < loaded.length;
  const canFetchOlder = Boolean(loadMore) && !exhausted;
  const canOlder = hasOlderLoaded || canFetchOlder;

  const older = async (): Promise<void> => {
    if (busy) return;
    // Page through already-loaded notes first; only hit the network at the end.
    if (hasOlderLoaded) {
      setPageStart((s) => s + PAGE_SIZE);
      return;
    }
    if (!loadMore || exhausted) return;
    setBusy(true);
    try {
      const fetched = await loadMore({ ...nextPageFilter(loaded, baseFilter), limit: PAGE_SIZE });
      const fresh = fetched.filter((e) => !loaded.some((x) => x.id === e.id));
      if (fresh.length === 0) setExhausted(true);
      else {
        setExtra((prev) => mergePage(prev, fresh));
        setPageStart((s) => s + PAGE_SIZE);
      }
    } finally {
      setBusy(false);
    }
  };

  const newer = (): void => setPageStart((s) => Math.max(0, s - PAGE_SIZE));

  if (loaded.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
        No posts yet.
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <NoteCard {...props} events={page} />
      {hasNewer || canOlder ? (
        <footer className="mt-2 flex items-center justify-between gap-2 border-t border-border pt-2">
          <Button variant="outline" size="sm" disabled={!hasNewer} onClick={newer}>
            <ChevronLeft aria-hidden="true" className="size-4" />
            Newer
          </Button>
          <span className="text-xs text-muted-foreground tabular-nums">
            {pageStart + 1}–{pageStart + page.length}
          </span>
          <Button variant="outline" size="sm" disabled={!canOlder || busy} onClick={() => void older()}>
            {busy ? <Loader2 aria-hidden="true" className="size-4 animate-spin" /> : null}
            Older
            <ChevronRight aria-hidden="true" className="size-4" />
          </Button>
        </footer>
      ) : null}
    </div>
  );
};

export const feedAtoms: Atom[] = [{ id: 'feed-list', Component: FeedList }];
