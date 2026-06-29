/** Social atoms — NIP-01 profile/note, NIP-25 reactions, NIP-02 follow. */
import { type FC, type ReactNode, useEffect, useState } from 'react';
import { Coins, Heart, MessageCircle, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button.js';
import { Badge } from '@/components/ui/badge.js';
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
import { useEngagementBudget } from '../engagement-budget.js';

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

/**
 * A subtle "remaining budget" affordance for the engagement bar. Likes/follows
 * debit a pre-authorized session allowance silently; this surfaces what's left
 * and lets the user top it up. It reads the budget via context (never the
 * bridge) and renders nothing until the user has authorized an allowance — so
 * before the first engagement, and on hosts/tests with no budget provider, the
 * bar stays clean.
 */
const EngagementBudgetMeter: FC = () => {
  const { authorized, remaining, asset, requestTopUp } = useEngagementBudget();
  if (!authorized) return null;
  const suffix = asset ? ` ${asset}` : '';
  return (
    <button
      type="button"
      onClick={requestTopUp}
      aria-label={`Engagement budget: ${remaining}${suffix} left. Tap to top up.`}
      title="Likes & follows budget — tap to top up"
      className="ml-auto inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Coins aria-hidden="true" className="size-3" />
      <span className="tabular-nums">{`${remaining}${suffix} left`}</span>
    </button>
  );
};

/**
 * Resolve an author's kind:0 profile. A profile already joined from the bind's
 * own events (`seeded`) wins immediately; otherwise — the feed case, where the
 * bind carries only `kinds:[1]` — we lazily pull the author's kind:0 via the
 * runtime-wired `resolveProfile` seam. Authors with no kind:0 stay `undefined`,
 * so the avatar/name degrade to the deterministic placeholder.
 */
function useAuthorProfile(
  pubkey: string,
  seeded: ProfileMetadata | undefined,
  resolveProfile: AtomRenderProps['resolveProfile']
): ProfileMetadata | undefined {
  const [fetched, setFetched] = useState<ProfileMetadata | undefined>(undefined);
  useEffect(() => {
    if (seeded || !resolveProfile) return;
    let cancelled = false;
    void resolveProfile(pubkey).then((profileEvent) => {
      if (cancelled || !profileEvent) return;
      const parsed = parseProfile(profileEvent);
      if (parsed) setFetched(parsed);
    });
    return () => {
      cancelled = true;
    };
  }, [pubkey, seeded, resolveProfile]);
  return seeded ?? fetched;
}

// Matches, in priority order: URLs, #hashtags, nostr:/npub mentions, @handles.
const RICH_TOKEN_RE =
  /(https?:\/\/[^\s]+)|(#[\p{L}\p{N}_]+)|((?:nostr:)?npub1[0-9a-z]+)|(@[\p{L}\p{N}_]+)/giu;

/**
 * Render note text with #hashtags, @/npub mentions and URLs lifted into the
 * jade accent (URLs are real links). Built as React nodes — no HTML injection —
 * and plain segments stay strings so `whitespace-pre-wrap` keeps newlines.
 */
function renderNoteContent(text: string): ReactNode {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  RICH_TOKEN_RE.lastIndex = 0;
  for (let m = RICH_TOKEN_RE.exec(text); m !== null; m = RICH_TOKEN_RE.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (m[1]) {
      out.push(
        <a
          key={key++}
          href={tok}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="break-all text-primary underline-offset-2 hover:underline"
        >
          {tok}
        </a>,
      );
    } else {
      out.push(
        <span key={key++} className="font-medium text-primary">
          {tok}
        </span>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * The author's profile, revealed inline when their avatar/name is clicked.
 * This is where Follow lives — off the per-row header so the feed stays clean.
 */
const AuthorProfileCard: FC<{
  pubkey: string;
  displayName: string | undefined;
  profile: ProfileMetadata | undefined;
  follow: AtomRenderProps['actions'][string] | undefined;
  followed: boolean;
  onFollow: () => void;
}> = ({ pubkey, displayName, profile, follow, followed, onFollow }) => (
  <div className="mt-1 flex items-start gap-3 rounded-lg border border-border bg-muted/40 p-3">
    <IdentityAvatar pubkey={pubkey} name={displayName} picture={profile?.picture} size="lg" />
    <div className="min-w-0 flex-1">
      <div className="truncate font-semibold leading-tight">{displayName ?? 'Unknown author'}</div>
      {profile?.nip05 ? (
        <div className="truncate text-xs text-muted-foreground">{profile.nip05}</div>
      ) : (
        <MonoId value={pubkey} className="text-muted-foreground" />
      )}
      {profile?.about ? (
        <p className="mt-1 line-clamp-3 text-sm text-muted-foreground">{profile.about}</p>
      ) : null}
    </div>
    {follow ? (
      <Button
        type="button"
        variant={followed ? 'secondary' : 'default'}
        size="sm"
        aria-pressed={followed}
        className="h-8 shrink-0 rounded-full px-3 text-xs font-semibold"
        onClick={onFollow}
      >
        <UserPlus aria-hidden="true" />
        {followed ? 'Following' : 'Follow'}
      </Button>
    ) : null}
  </div>
);

/** A single feed item: identity row, note body, inline media, engagement. */
const NoteRow: FC<{
  event: NostrEvent;
  note: NoteMetadata;
  profile: ProfileMetadata | undefined;
  resolveProfile: AtomRenderProps['resolveProfile'];
  reactionCount: number;
  actions: AtomRenderProps['actions'];
}> = ({ event, note, profile: seededProfile, resolveProfile, reactionCount, actions }) => {
  const profile = useAuthorProfile(note.authorPubkey, seededProfile, resolveProfile);
  const media = parseInlineMedia(event);
  const displayName = profile?.displayName ?? profile?.name;
  const reply = actions['reply'];
  const react = actions['react'];
  const follow = actions['follow'];

  // Pay-to-write actions settle a channel fee per event. We toggle optimistically
  // for a snappy feel; the publish itself is routed through the paid write path.
  const [liked, setLiked] = useState(false);
  const [followed, setFollowed] = useState(false);
  // Follow lives in the author's profile (revealed by clicking the avatar/name),
  // not as a per-row button — keeps the feed scannable.
  const [showProfile, setShowProfile] = useState(false);

  const onLike = (): void => {
    if (!react) return;
    setLiked((v) => !v);
    void react({ content: '+' });
  };
  const onFollow = (): void => {
    if (!follow) return;
    setFollowed(true);
    void follow({ tags: [['p', note.authorPubkey]] });
  };

  const likeCount = reactionCount + (liked ? 1 : 0);

  return (
    <article className="group/note flex gap-3 px-1 py-3 transition-colors first:pt-0 last:pb-0 hover:bg-muted/30">
      <button
        type="button"
        onClick={() => setShowProfile((v) => !v)}
        aria-expanded={showProfile}
        aria-label={`View ${displayName ?? 'author'}'s profile`}
        className="shrink-0 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <IdentityAvatar pubkey={note.authorPubkey} name={displayName} picture={profile?.picture} />
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <header className="flex min-w-0 items-baseline gap-1.5">
          <button
            type="button"
            onClick={() => setShowProfile((v) => !v)}
            aria-expanded={showProfile}
            className="flex min-w-0 items-baseline gap-1.5 text-left hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
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
          </button>
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
        </header>

        {showProfile ? (
          <AuthorProfileCard
            pubkey={note.authorPubkey}
            displayName={displayName}
            profile={profile}
            follow={follow}
            followed={followed}
            onFollow={onFollow}
          />
        ) : null}

        {note.content ? (
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground">
            {renderNoteContent(note.content)}
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
                label="Reply to this note"
                icon={<MessageCircle aria-hidden="true" />}
                text="Reply"
                onClick={() => void reply({ parentId: note.eventId })}
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
            <EngagementBudgetMeter />
          </footer>
        ) : null}

      </div>
    </article>
  );
};

/**
 * Renders bound notes as a divided list of X-style rows. Exported so the
 * `feed-list` atom can reuse the row rendering and wrap it with pagination /
 * fullscreen chrome rather than re-implement note rows.
 */
export const NoteCard: FC<AtomRenderProps> = ({ events, actions, resolveProfile }) => {
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
          resolveProfile={resolveProfile}
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
