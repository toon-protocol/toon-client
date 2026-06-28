/**
 * Feed atoms — a bounded, scannable timeline slice that respects MCP-app host
 * rules (no in-iframe infinite scroll). It reuses {@link NoteCard}'s rows and
 * adds two affordances:
 *   • "Load more"   — fetches the next (older) page via a FREE paginated
 *     `toon_query`, appending in place (the host-blessed alternative to
 *     infinite scroll).
 *   • "Open timeline" — escalates to the host's fullscreen surface when one is
 *     available, where a real scrolling timeline is legitimate.
 *
 * On a host without the display-mode capability (or the mock bridge) the
 * fullscreen affordance simply doesn't render — the feed stays a finite inline
 * slice. With no `loadMore` seam, only what the bind resolved is shown.
 */

import { type FC, useState } from 'react';
import { ListPlus, Loader2, Maximize2 } from 'lucide-react';
import { Button } from '@/components/ui/button.js';
import { type NostrEvent } from '../types.js';
import { mergePage, nextPageFilter, type NostrFilterLike } from '../paging.js';
import { type Atom, type AtomRenderProps } from './types.js';
import { NoteCard } from './social.js';

/** Notes fetched per "Load more" page (the inline slice stays scannable). */
const PAGE_SIZE = 5;

const FeedList: FC<AtomRenderProps> = (props) => {
  const { events, bind, loadMore, surface } = props;
  // Pages loaded beyond the initial bind, merged + de-duped with the bound events.
  const [extra, setExtra] = useState<NostrEvent[]>([]);
  const [busy, setBusy] = useState(false);
  // Set once a page returns nothing new — we've reached the end of the feed.
  const [exhausted, setExhausted] = useState(false);

  const all = extra.length ? mergePage(events, extra) : events;
  const baseFilter: NostrFilterLike = (bind?.query as NostrFilterLike | undefined) ?? { kinds: [1] };

  const onLoadMore = async (): Promise<void> => {
    if (!loadMore || busy || exhausted) return;
    setBusy(true);
    try {
      const page = await loadMore({ ...nextPageFilter(all, baseFilter), limit: PAGE_SIZE });
      const fresh = page.filter((e) => !all.some((x) => x.id === e.id));
      if (fresh.length === 0) setExhausted(true);
      else setExtra((prev) => mergePage(prev, fresh));
    } finally {
      setBusy(false);
    }
  };

  const canLoadMore = Boolean(loadMore) && !exhausted;
  const canOpenTimeline = Boolean(surface?.canFullscreen) && surface?.mode !== 'fullscreen';

  if (all.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
        No posts yet.
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <NoteCard {...props} events={all} />
      {canLoadMore || canOpenTimeline ? (
        <footer className="mt-2 flex items-center justify-between gap-2">
          {canLoadMore ? (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void onLoadMore()}
            >
              {busy ? (
                <Loader2 aria-hidden="true" className="size-4 animate-spin" />
              ) : (
                <ListPlus aria-hidden="true" className="size-4" />
              )}
              Load more
            </Button>
          ) : (
            <span />
          )}
          {canOpenTimeline ? (
            <Button variant="ghost" size="sm" onClick={() => void surface?.request('fullscreen')}>
              <Maximize2 aria-hidden="true" className="size-4" />
              Open timeline
            </Button>
          ) : null}
        </footer>
      ) : null}
    </div>
  );
};

export const feedAtoms: Atom[] = [{ id: 'feed-list', Component: FeedList }];
