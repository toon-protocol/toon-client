/** Social atoms — NIP-01 profile/note, NIP-25 reactions, NIP-02 follow. */
import { type FC, type ReactNode, useState } from 'react';
import { Heart, MessageCircle, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button.js';
import { Badge } from '@/components/ui/badge.js';
import { Textarea } from '@/components/ui/textarea.js';
import { MonoId } from '@/components/mono-id.js';
import { cn } from '@/lib/utils.js';
import {
  parseProfile,
  parseNote,
  parseReaction,
  type ProfileMetadata,
  type NoteMetadata,
} from '../parsers/social.js';
import { parseInlineMedia } from '../parsers/media.js';
import { type NostrEvent } from '../types.js';
import { InlineMediaList } from './media.js';
import { type Atom, type AtomRenderProps } from './types.js';
import { IdentityAvatar, relativeTime } from './social-ui.js';

const ProfileHeader: FC<AtomRenderProps> = ({ events }) => {
  const profile = events.map(parseProfile).find((p) => p !== null) ?? null;
  if (!profile) return null;
  const name = profile.displayName ?? profile.name ?? profile.pubkey;
  return (
    <div className="flex items-center gap-3">
      <IdentityAvatar pubkey={profile.pubkey} name={name} picture={profile.picture} />
      <div className="min-w-0 flex-1">
        <div className="truncate font-semibold leading-tight">{name}</div>
        {profile.nip05 ? (
          <div className="truncate text-xs text-muted-foreground">{profile.nip05}</div>
        ) : (
          <MonoId value={profile.pubkey} className="text-muted-foreground" />
        )}
        {profile.about ? (
          <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{profile.about}</p>
        ) : null}
      </div>
    </div>
  );
};

/**
 * One X-style action: an icon + optional count, rendered as a quiet muted
 * button that accents on hover/focus (and stays accented while `active`). Counts
 * sit to the right of the icon, X-style. `accent` tints the hover/active state
 * so Like reads rose while Reply/etc. settle on the foreground.
 */
const ActionButton: FC<{
  label: string;
  icon: ReactNode;
  text: string;
  count?: number;
  active?: boolean;
  accent?: 'foreground' | 'rose';
  onClick: () => void;
}> = ({ label, icon, text, count, active = false, accent = 'foreground', onClick }) => {
  const accentClass =
    accent === 'rose'
      ? cn('hover:text-rose-500 focus-visible:text-rose-500', active && 'text-rose-500')
      : cn('hover:text-foreground focus-visible:text-foreground', active && 'text-foreground');
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-label={label}
      aria-pressed={active}
      className={cn('h-8 gap-1.5 px-2 text-xs text-muted-foreground transition-colors', accentClass)}
      onClick={onClick}
    >
      {icon}
      <span>{text}</span>
      {typeof count === 'number' && count > 0 ? (
        <span className="tabular-nums">{count}</span>
      ) : null}
    </Button>
  );
};

/** A single feed item: identity row, note body, inline media, engagement. */
const NoteRow: FC<{
  event: NostrEvent;
  note: NoteMetadata;
  profile: ProfileMetadata | undefined;
  reactionCount: number;
  actions: AtomRenderProps['actions'];
}> = ({ event, note, profile, reactionCount, actions }) => {
  const media = parseInlineMedia(event);
  const displayName = profile?.displayName ?? profile?.name;
  const reply = actions['reply'];
  const react = actions['react'];
  const follow = actions['follow'];

  // Pay-to-write actions settle a channel fee per event. We toggle optimistically
  // for a snappy feel; the publish itself is routed through the paid write path.
  const [liked, setLiked] = useState(false);
  const [followed, setFollowed] = useState(false);
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [sending, setSending] = useState(false);

  const onLike = (): void => {
    if (!react) return;
    setLiked((v) => !v);
    // The runtime supplies the NIP-25 e/p tags for the targeted note; we only
    // need to assert the reaction content.
    void react({ content: '+' });
  };
  const onFollow = (): void => {
    if (!follow) return;
    setFollowed(true);
    void follow({ tags: [['p', note.authorPubkey]] });
  };
  const onSendReply = (): void => {
    const text = replyText.trim();
    if (!reply || text.length === 0 || sending) return;
    setSending(true);
    void Promise.resolve(reply({ content: text, parentId: note.eventId })).finally(() => {
      setSending(false);
      setReplyText('');
      setReplyOpen(false);
    });
  };

  const likeCount = reactionCount + (liked ? 1 : 0);

  return (
    <article className="group/note flex gap-3 px-1 py-3 transition-colors first:pt-0 last:pb-0 hover:bg-muted/30">
      <IdentityAvatar
        pubkey={note.authorPubkey}
        name={displayName}
        picture={profile?.picture}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <header className="flex items-center gap-1.5">
          <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
            {displayName ? (
              <>
                <span className="truncate font-semibold leading-tight text-foreground">
                  {displayName}
                </span>
                <MonoId value={note.authorPubkey} className="shrink-0 text-muted-foreground" />
              </>
            ) : (
              <MonoId value={note.authorPubkey} className="text-muted-foreground" />
            )}
            <span aria-hidden="true" className="text-muted-foreground">
              ·
            </span>
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              {relativeTime(note.createdAt)}
            </span>
            {note.isReply ? (
              <Badge variant="secondary" className="px-1.5 py-0 text-[10px] font-normal">
                reply
              </Badge>
            ) : null}
          </div>
          {follow ? (
            <Button
              type="button"
              variant={followed ? 'secondary' : 'outline'}
              size="sm"
              aria-label={followed ? 'Following this author' : 'Follow this author'}
              aria-pressed={followed}
              className="h-7 shrink-0 rounded-full px-3 text-xs font-semibold"
              onClick={onFollow}
            >
              <UserPlus aria-hidden="true" />
              {followed ? 'Following' : 'Follow'}
            </Button>
          ) : null}
        </header>

        {note.content ? (
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground">
            {note.content}
          </p>
        ) : null}

        {media.length > 0 ? (
          <div className="mt-1">
            <InlineMediaList variants={media} />
          </div>
        ) : null}

        {reply || react ? (
          <footer className="-ml-2 mt-1 flex items-center gap-6">
            {reply ? (
              <ActionButton
                label={replyOpen ? 'Close reply' : 'Reply to this note'}
                icon={<MessageCircle aria-hidden="true" />}
                text="Reply"
                active={replyOpen}
                onClick={() => setReplyOpen((v) => !v)}
              />
            ) : null}
            {react ? (
              <ActionButton
                label={liked ? 'Liked this note' : 'Like this note'}
                icon={
                  <Heart
                    aria-hidden="true"
                    className={liked ? 'fill-current' : undefined}
                  />
                }
                text="Like"
                count={likeCount}
                active={liked}
                accent="rose"
                onClick={onLike}
              />
            ) : null}
          </footer>
        ) : null}

        {reply && replyOpen ? (
          <div className="mt-1.5 flex flex-col gap-1.5">
            <Textarea
              autoFocus
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              placeholder="Post your reply…"
              aria-label="Reply text"
              rows={2}
              className="min-h-[2.5rem] text-sm"
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault();
                  onSendReply();
                }
              }}
            />
            <div className="flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-3 text-xs"
                onClick={() => {
                  setReplyOpen(false);
                  setReplyText('');
                }}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                className="h-7 px-3 text-xs font-semibold"
                disabled={replyText.trim().length === 0 || sending}
                onClick={onSendReply}
              >
                {sending ? 'Posting…' : 'Reply'}
              </Button>
            </div>
          </div>
        ) : null}

        {reply || react || follow ? (
          <p className="mt-0.5 text-[10px] text-muted-foreground/70">
            Like, reply, and follow are paid writes — each spends the per-event channel fee.
          </p>
        ) : null}
      </div>
    </article>
  );
};

const NoteCard: FC<AtomRenderProps> = ({ events, actions }) => {
  const noteItems = events
    .map((event) => ({ event, note: parseNote(event) }))
    .filter((item): item is { event: NostrEvent; note: NoteMetadata } => item.note !== null);
  if (noteItems.length === 0) return null;

  // A feed bind may carry kind:0 profiles alongside the notes; join them by
  // pubkey so an author renders with a real name/picture when one is present.
  const profiles = new Map<string, ProfileMetadata>();
  for (const event of events) {
    const profile = parseProfile(event);
    if (profile) profiles.set(profile.pubkey, profile);
  }

  // Reaction counts, keyed by the targeted note (NIP-25 `e` tag).
  const reactionCounts = new Map<string, number>();
  for (const event of events) {
    const reaction = parseReaction(event);
    if (reaction?.targetEventId) {
      reactionCounts.set(
        reaction.targetEventId,
        (reactionCounts.get(reaction.targetEventId) ?? 0) + 1
      );
    }
  }

  return (
    <div className="flex flex-col divide-y divide-border">
      {noteItems.map(({ event, note }) => (
        <NoteRow
          key={note.eventId}
          event={event}
          note={note}
          profile={profiles.get(note.authorPubkey)}
          reactionCount={reactionCounts.get(note.eventId) ?? 0}
          actions={actions}
        />
      ))}
    </div>
  );
};

const ReactionBar: FC<AtomRenderProps> = ({ events, actions }) => {
  const counts = new Map<string, number>();
  for (const evt of events) {
    const reaction = parseReaction(evt);
    if (!reaction) continue;
    const key = reaction.content || '+';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {[...counts.entries()].map(([emoji, n]) => (
        <Badge key={emoji} variant="secondary" className="gap-1 tabular-nums">
          {emoji} {n}
        </Badge>
      ))}
      {actions['react'] ? (
        <Button
          variant="outline"
          size="sm"
          aria-label="Add a reaction"
          className="h-6 gap-1 rounded-full px-2 text-xs"
          onClick={() => void actions['react']?.({ content: '+' })}
        >
          <Heart aria-hidden="true" />
          React
        </Button>
      ) : null}
    </div>
  );
};

const FollowButton: FC<AtomRenderProps> = ({ props, actions }) => {
  const label = typeof props['label'] === 'string' ? props['label'] : 'Follow';
  return (
    <Button disabled={!actions['follow']} size="sm" onClick={() => void actions['follow']?.()}>
      {label}
    </Button>
  );
};

export const socialAtoms: Atom[] = [
  { id: 'profile-header', kinds: [0], Component: ProfileHeader },
  {
    id: 'note-card',
    kinds: [1],
    // reply (kind:1), react/like (kind:7) and follow (kind:3) all publish via
    // the unsigned-publish tool; the runtime supplies the kind + tags per action.
    writes: [{ name: 'toon_publish_unsigned' }],
    Component: NoteCard,
  },
  { id: 'reaction-bar', kinds: [7], Component: ReactionBar },
  {
    id: 'follow-button',
    writes: [{ name: 'toon_publish_unsigned' }],
    Component: FollowButton,
  },
];
