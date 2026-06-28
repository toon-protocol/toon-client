/**
 * Thread atom — a focused conversation view reconstructed from NIP-10 `e`/`p`
 * thread tags over the bound notes. The agent supplies a bind that resolves the
 * root + its replies (a `kinds:[1]` query with the thread's `#e` filter); this
 * atom turns that flat event set into a reply structure and renders it two ways:
 *
 *   • inline   — the focused note, its single direct parent (for context), and a
 *     bounded slice of up to {@link INLINE_REPLY_CAP} direct replies, plus a
 *     "View full thread (N)" affordance that escalates to the host's fullscreen
 *     surface (only when one is available — it simply doesn't render otherwise).
 *   • fullscreen — the whole depth-capped reply tree, where deeply-nested replies
 *     stop indenting at {@link MAX_DEPTH} and collapse to a "continue thread →"
 *     button that re-roots the sub-conversation at the left margin (so the tree
 *     never marches off the right edge of a narrow MCP-app surface).
 *
 * Note rows are reused from {@link NoteCard} (one note per call) so a thread reads
 * exactly like the feed, with the same author header / inline media / action bar.
 */

import { type FC, useState } from 'react';
import { MessagesSquare, CornerDownRight } from 'lucide-react';
import { Button } from '@/components/ui/button.js';
import { cn } from '@/lib/utils.js';
import { parseNote, type NoteMetadata } from '../parsers/social.js';
import { type NostrEvent } from '../types.js';
import { type Atom, type AtomRenderProps } from './types.js';
import { NoteCard } from './social.js';

/** Direct replies shown inline before the "View full thread" escalation. */
const INLINE_REPLY_CAP = 3;
/** Visual indentation cap; deeper replies collapse to a "continue thread" link. */
const MAX_DEPTH = 4;

/** One note placed in the thread (the raw event + its parsed NIP-10 refs). */
interface ThreadNode {
  event: NostrEvent;
  note: NoteMetadata;
}

/** Parse the bound events into notes, keeping only real kind:1 text notes. */
function threadNodes(events: NostrEvent[]): ThreadNode[] {
  return events
    .map((event) => ({ event, note: parseNote(event) }))
    .filter((n): n is ThreadNode => n.note !== null);
}

/** parentId → its direct replies, ordered oldest-first (reading order). */
function childrenByParent(nodes: ThreadNode[]): Map<string, ThreadNode[]> {
  const byId = new Set(nodes.map((n) => n.note.eventId));
  const map = new Map<string, ThreadNode[]>();
  for (const node of nodes) {
    const parent = node.note.thread.replyToId;
    // Only thread under a parent we actually hold; a reply whose parent is
    // outside the bound set is treated as a root of this view.
    if (parent === undefined || !byId.has(parent)) continue;
    const list = map.get(parent) ?? [];
    list.push(node);
    map.set(parent, list);
  }
  for (const list of map.values()) list.sort((a, b) => a.note.createdAt - b.note.createdAt);
  return map;
}

/** Total replies beneath a node (for the "continue thread (N)" count). */
function countDescendants(id: string, childrenMap: Map<string, ThreadNode[]>): number {
  const kids = childrenMap.get(id) ?? [];
  return kids.reduce((sum, k) => sum + 1 + countDescendants(k.note.eventId, childrenMap), 0);
}

/**
 * One node of the fullscreen reply tree. Recurses through its children, capping
 * indentation at {@link MAX_DEPTH}: at the boundary the descendants collapse to a
 * "continue thread →" button which, once clicked, re-renders them at depth 0 (no
 * further indent) so a long reply chain folds back to the margin instead of
 * disappearing off the side.
 */
const ReplyTreeNode: FC<{
  node: ThreadNode;
  childrenMap: Map<string, ThreadNode[]>;
  depth: number;
  continued: Set<string>;
  onContinue: (id: string) => void;
  noteProps: AtomRenderProps;
}> = ({ node, childrenMap, depth, continued, onContinue, noteProps }) => {
  const kids = childrenMap.get(node.note.eventId) ?? [];
  const atCap = depth + 1 >= MAX_DEPTH;
  const isContinued = continued.has(node.note.eventId);

  return (
    <div>
      <NoteCard {...noteProps} events={[node.event]} />
      {kids.length === 0 ? null : atCap && !isContinued ? (
        <Button
          variant="ghost"
          size="sm"
          className="ml-3 h-7 gap-1.5 px-2 text-xs text-muted-foreground"
          onClick={() => onContinue(node.note.eventId)}
        >
          <CornerDownRight aria-hidden="true" className="size-3.5" />
          Continue thread ({countDescendants(node.note.eventId, childrenMap)})
        </Button>
      ) : (
        <div className={cn(isContinued ? null : 'ml-3 border-l border-border pl-3')}>
          {kids.map((kid) => (
            <ReplyTreeNode
              key={kid.note.eventId}
              node={kid}
              childrenMap={childrenMap}
              // Re-root continued chains at 0 so indentation never exceeds the cap.
              depth={isContinued ? 0 : depth + 1}
              continued={continued}
              onContinue={onContinue}
              noteProps={noteProps}
            />
          ))}
        </div>
      )}
    </div>
  );
};

const ThreadView: FC<AtomRenderProps> = (props) => {
  const { events, props: nodeProps, surface } = props;
  // Tracks which over-deep nodes the reader chose to "continue" (fullscreen).
  const [continued, setContinued] = useState<Set<string>>(() => new Set());

  const nodes = threadNodes(events);
  if (nodes.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
        No thread to show.
      </div>
    );
  }

  const byId = new Map(nodes.map((n) => [n.note.eventId, n]));
  const childrenMap = childrenByParent(nodes);
  // Roots = notes whose parent is outside this view (or none) — the thread tops.
  const roots = nodes.filter((n) => {
    const parent = n.note.thread.replyToId;
    return parent === undefined || !byId.has(parent);
  });

  // The agent may pin a specific note as the conversation's focus; otherwise the
  // thread root is the focus, falling back to the first node for a flat set.
  const focusId = typeof nodeProps['focusId'] === 'string' ? nodeProps['focusId'] : undefined;
  const focus = (focusId ? byId.get(focusId) : undefined) ?? roots[0] ?? nodes[0];
  if (!focus) return null;

  // ── Fullscreen: the whole depth-capped reply tree from every root. ──────────
  if (surface?.mode === 'fullscreen') {
    return (
      <div className="flex flex-col gap-2">
        {roots.map((root) => (
          <ReplyTreeNode
            key={root.note.eventId}
            node={root}
            childrenMap={childrenMap}
            depth={0}
            continued={continued}
            onContinue={(id) => setContinued((prev) => new Set(prev).add(id))}
            noteProps={props}
          />
        ))}
      </div>
    );
  }

  // ── Inline: parent (context) → focus → a bounded slice of direct replies. ──
  const parent = focus.note.thread.replyToId ? byId.get(focus.note.thread.replyToId) : undefined;
  const directReplies = childrenMap.get(focus.note.eventId) ?? [];
  const shown = directReplies.slice(0, INLINE_REPLY_CAP);
  const hidden = nodes.length - (parent ? 1 : 0) - 1 - shown.length;
  // We already returned above when mode === 'fullscreen', so capability is enough.
  const canOpenFull = Boolean(surface?.canFullscreen);

  return (
    <div className="flex flex-col">
      {parent ? (
        <div className="opacity-70">
          <NoteCard {...props} events={[parent.event]} />
        </div>
      ) : null}
      <div className={cn(parent ? 'ml-3 border-l-2 border-primary/40 pl-3' : null)}>
        <NoteCard {...props} events={[focus.event]} />
      </div>
      {shown.length > 0 ? (
        <div className="ml-3 border-l border-border pl-3">
          {shown.map((reply) => (
            <NoteCard key={reply.note.eventId} {...props} events={[reply.event]} />
          ))}
        </div>
      ) : null}
      {canOpenFull ? (
        <footer className="mt-2">
          <Button variant="ghost" size="sm" onClick={() => void surface?.request('fullscreen')}>
            <MessagesSquare aria-hidden="true" className="size-4" />
            View full thread ({nodes.length}
            {hidden > 0 ? `, ${hidden} more` : ''})
          </Button>
        </footer>
      ) : null}
    </div>
  );
};

export const threadAtoms: Atom[] = [
  {
    id: 'thread-view',
    // reply/react/follow fire on the reused note rows via the unsigned-publish tool.
    writes: [{ name: 'toon_publish_unsigned' }],
    Component: ThreadView,
  },
];
