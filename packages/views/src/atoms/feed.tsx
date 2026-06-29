/**
 * Feed atoms — a bounded, scannable timeline slice that respects MCP-app host
 * rules (no in-iframe infinite scroll). It reuses {@link NoteCard}'s rows and
 * adds two affordances:
 *   • "Load more"   — reveals more of the feed: first the already-loaded notes
 *     past the inline cap, then the next (older) page via a FREE paginated
 *     `toon_query` (the host-blessed alternative to infinite scroll).
 *   • "Open timeline" — escalates to the host's fullscreen surface when one is
 *     available, where a real scrolling timeline is legitimate.
 *
 * INLINE STAYS BOUNDED. The host caps an inline card's height (~one viewport)
 * and scrolls the overflow, so rendering the whole bound feed inline produces an
 * ugly internal scrollbar. We therefore render at most {@link INLINE_CAP} rows
 * inline and grow on demand; in fullscreen (a real scroll container) we show
 * everything. On a host without fullscreen (or the mock bridge) the escalation
 * affordance simply doesn't render — the feed stays the capped inline slice.
 */

import { type FC, useState } from 'react';
import { ListPlus, Loader2, Maximize2 } from 'lucide-react';
import { Button } from '@/components/ui/button.js';
import { type NostrEvent } from '../types.js';
import { mergePage, nextPageFilter, type NostrFilterLike } from '../paging.js';
import { type Atom, type AtomRenderProps } from './types.js';
import { NoteCard } from './social.js';

/** Notes shown inline before "Load more" (bounded so it fits the host card). */
const INLINE_CAP = 6;
/** Notes revealed/fetched per "Load more" press. */
const PAGE_SIZE = 5;

const FeedList: FC<AtomRenderProps> = (props) => {
  const { events, bind, loadMore, surface } = props;
  // Pages loaded beyond the initial bind, merged + de-duped with the bound events.
  const [extra, setExtra] = useState<NostrEvent[]>([]);
  const [busy, setBusy] = useState(false);
  // Set once a page returns nothing new — we've reached the end of the feed.
  const [exhausted, setExhausted] = useState(false);
  // How many rows to render inline; grows on "Load more". Ignored in fullscreen.
  const [visible, setVisible] = useState(INLINE_CAP);

  const all = extra.length ? mergePage(events, extra) : events;
  const baseFilter: NostrFilterLike = (bind?.query as NostrFilterLike | undefined) ?? { kinds: [1] };

  // Fullscreen is a real scroll container → show everything; inline stays a
  // bounded slice that fits the host card without an internal scrollbar.
  const isFullscreen = surface?.mode === 'fullscreen';
  const shown = isFullscreen ? all : all.slice(0, visible);
  // Already-loaded notes hidden by the inline cap (revealed instantly, no fetch).
  const hasHiddenLoaded = !isFullscreen && visible < all.length;

  const onLoadMore = async (): Promise<void> => {
    if (busy) return;
    // Reveal already-loaded rows first (free + instant), then fetch older pages.
    if (hasHiddenLoaded) {
      setVisible((v) => v + PAGE_SIZE);
      return;
    }
    if (!loadMore || exhausted) return;
    setBusy(true);
    try {
      const page = await loadMore({ ...nextPageFilter(all, baseFilter), limit: PAGE_SIZE });
      const fresh = page.filter((e) => !all.some((x) => x.id === e.id));
      if (fresh.length === 0) setExhausted(true);
      else {
        setExtra((prev) => mergePage(prev, fresh));
        setVisible((v) => v + fresh.length);
      }
    } finally {
      setBusy(false);
    }
  };

  const canLoadMore = hasHiddenLoaded || (Boolean(loadMore) && !exhausted && !isFullscreen);
  const canOpenTimeline = Boolean(surface?.canFullscreen) && !isFullscreen;

  if (all.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
        No posts yet.
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <NoteCard {...props} events={shown} />
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
