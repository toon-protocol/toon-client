/** Social atoms — NIP-01 profile/note, NIP-25 reactions, NIP-02 follow. */
import { type FC } from 'react';
import { Heart, MessageCircle } from 'lucide-react';
import { Button } from '@/components/ui/button.js';
import { Badge } from '@/components/ui/badge.js';
import { MonoId } from '@/components/mono-id.js';
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

  return (
    <article className="group/note flex gap-3 px-1 py-3 transition-colors first:pt-0 last:pb-0 hover:bg-muted/30">
      <IdentityAvatar
        pubkey={note.authorPubkey}
        name={displayName}
        picture={profile?.picture}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <header className="flex items-baseline gap-2">
          {displayName ? (
            <span className="truncate font-semibold leading-tight">{displayName}</span>
          ) : (
            <MonoId value={note.authorPubkey} />
          )}
          {note.isReply ? (
            <Badge variant="secondary" className="px-1.5 py-0 text-[10px] font-normal">
              reply
            </Badge>
          ) : null}
          <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
            {relativeTime(note.createdAt)}
          </span>
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
          <footer className="mt-1 flex items-center gap-1 text-muted-foreground">
            {reply ? (
              <Button
                variant="ghost"
                size="sm"
                aria-label="Reply to this note"
                className="h-7 gap-1.5 px-2 text-xs hover:text-foreground"
                onClick={() => void reply({ parentId: note.eventId })}
              >
                <MessageCircle aria-hidden="true" />
                Reply
              </Button>
            ) : null}
            {react ? (
              <Button
                variant="ghost"
                size="sm"
                aria-label="React to this note"
                className="h-7 gap-1.5 px-2 text-xs hover:text-foreground"
                onClick={() => void react({ content: '+' })}
              >
                <Heart aria-hidden="true" />
                React
                {reactionCount > 0 ? (
                  <span className="tabular-nums">{reactionCount}</span>
                ) : null}
              </Button>
            ) : null}
          </footer>
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
  { id: 'note-card', kinds: [1], Component: NoteCard },
  { id: 'reaction-bar', kinds: [7], Component: ReactionBar },
  {
    id: 'follow-button',
    writes: [{ name: 'toon_publish_unsigned' }],
    Component: FollowButton,
  },
];
