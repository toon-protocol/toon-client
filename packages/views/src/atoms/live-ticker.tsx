/**
 * Live ticker atom — a compact, always-on stream of new posts / mentions, built
 * for the host's Picture-in-Picture surface so it can ride alongside the
 * conversation. It feature-detects PiP and degrades gracefully:
 *
 *   • host supports PiP (`surface.canPip`) — offer a "Go live" affordance that
 *     pops the ticker into the parallel PiP surface (`surface.request('pip')`).
 *   • inline-only host — degrade to a static SNAPSHOT of the most recent items
 *     plus a "Refresh" button that re-queries the base filter via the free
 *     `loadMore` seam and merges any new items to the top.
 *
 * The item list is an `aria-live="polite"` region so screen readers announce new
 * entries without stealing focus, in either mode.
 */

import { type FC, useState } from 'react';
import { Radio, RotateCw, AtSign } from 'lucide-react';
import { Button } from '@/components/ui/button.js';
import { MonoId } from '@/components/mono-id.js';
import { parseNote } from '../parsers/social.js';
import { mergePage, type NostrFilterLike } from '../paging.js';
import { type NostrEvent } from '../types.js';
import { type Atom, type AtomRenderProps } from './types.js';
import { relativeTime } from './social-ui.js';

/** Recent items kept in the ticker snapshot (it stays a glanceable slice). */
const TICKER_SIZE = 6;

/** One compact ticker line: who, a one-line excerpt, and when. */
const TickerItem: FC<{ event: NostrEvent }> = ({ event }) => {
  const note = parseNote(event);
  // Fall back to the raw content for non-kind:1 mentions (e.g. reactions).
  const text = (note?.content ?? event.content).replace(/\s+/g, ' ').trim();
  return (
    <li className="flex items-baseline gap-2 px-1 py-1.5 text-sm">
      <AtSign aria-hidden="true" className="size-3.5 shrink-0 translate-y-0.5 text-primary" />
      <MonoId value={event.pubkey} className="shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-foreground">{text || '—'}</span>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {relativeTime(event.created_at)}
      </span>
    </li>
  );
};

const LiveTicker: FC<AtomRenderProps> = ({ events, bind, loadMore, surface }) => {
  // Items pulled in by "Refresh", merged + de-duped with the bound events.
  const [extra, setExtra] = useState<NostrEvent[]>([]);
  const [busy, setBusy] = useState(false);

  const all = (extra.length ? mergePage(events, extra) : events).slice(0, TICKER_SIZE);
  const baseFilter: NostrFilterLike = (bind?.query as NostrFilterLike | undefined) ?? { kinds: [1] };

  const onRefresh = async (): Promise<void> => {
    if (!loadMore || busy) return;
    setBusy(true);
    try {
      // Re-query the BASE filter (newest items), not an older page — the ticker
      // surfaces what's NEW, so fresh ids merge to the top and dupes drop out.
      const page = await loadMore({ ...baseFilter, limit: TICKER_SIZE });
      setExtra((prev) => mergePage(prev, page));
    } finally {
      setBusy(false);
    }
  };

  const canPip = Boolean(surface?.canPip) && surface?.mode !== 'pip';

  return (
    <div className="flex flex-col rounded-xl border border-border">
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
          <Radio aria-hidden="true" className="size-3.5 text-primary" />
          Live
        </span>
        {canPip ? (
          // Host has a parallel surface — pop the ticker out to ride live.
          <Button variant="outline" size="sm" onClick={() => void surface?.request('pip')}>
            <Radio aria-hidden="true" className="size-3.5" />
            Go live
          </Button>
        ) : loadMore ? (
          // Inline-only: a manual Refresh stands in for the live feed.
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void onRefresh()}>
            <RotateCw aria-hidden="true" className={busy ? 'size-3.5 animate-spin' : 'size-3.5'} />
            Refresh
          </Button>
        ) : null}
      </header>
      <ul aria-live="polite" aria-label="New posts and mentions" className="divide-y divide-border px-2 py-1">
        {all.length === 0 ? (
          <li className="px-1 py-4 text-center text-sm text-muted-foreground">Nothing new yet.</li>
        ) : (
          all.map((event) => <TickerItem key={event.id} event={event} />)
        )}
      </ul>
    </div>
  );
};

export const liveTickerAtoms: Atom[] = [{ id: 'live-ticker', Component: LiveTicker }];
