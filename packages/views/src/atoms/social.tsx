/** Social atoms — NIP-01 profile/note, NIP-25 reactions, NIP-02 follow. */
import { type FC } from 'react';
import { Button } from '@/components/ui/button.js';
import { Badge } from '@/components/ui/badge.js';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar.js';
import { MonoId } from '@/components/mono-id.js';
import { parseProfile, parseNote, parseReaction } from '../parsers/social.js';
import { type Atom, type AtomRenderProps } from './types.js';

function displayName(pubkey: string): string {
  return pubkey.slice(0, 2).toUpperCase();
}

const ProfileHeader: FC<AtomRenderProps> = ({ events }) => {
  const profile = events.map(parseProfile).find((p) => p !== null) ?? null;
  if (!profile) return null;
  const name =
    profile.displayName ?? profile.name ?? profile.pubkey;
  const initials = displayName(profile.pubkey);
  return (
    <div className="flex items-center gap-3">
      <Avatar className="h-11 w-11">
        <AvatarImage src={profile.picture} alt={name} />
        <AvatarFallback className="text-xs font-semibold">{initials}</AvatarFallback>
      </Avatar>
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

const NoteCard: FC<AtomRenderProps> = ({ events, actions }) => {
  const notes = events.map(parseNote).filter((n) => n !== null);
  if (notes.length === 0) return null;
  return (
    <div className="flex flex-col divide-y divide-border">
      {notes.map((note) => (
        <article key={note.eventId} className="flex flex-col gap-1.5 py-3 first:pt-0 last:pb-0">
          <header className="flex items-center gap-2">
            <MonoId value={note.authorPubkey} />
            {note.isReply ? (
              <Badge variant="secondary" className="text-[10px]">reply</Badge>
            ) : null}
          </header>
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{note.content}</p>
          {actions['reply'] ? (
            <Button
              variant="ghost"
              size="sm"
              className="self-start h-6 px-0 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => void actions['reply']?.({ parentId: note.eventId })}
            >
              Reply
            </Button>
          ) : null}
        </article>
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
        <Badge key={emoji} variant="secondary">
          {emoji} {n}
        </Badge>
      ))}
      {actions['react'] ? (
        <Button
          variant="outline"
          size="sm"
          className="h-6 rounded-full px-2 text-xs"
          onClick={() => void actions['react']?.({ content: '+' })}
        >
          + React
        </Button>
      ) : null}
    </div>
  );
};

const FollowButton: FC<AtomRenderProps> = ({ props, actions }) => {
  const label = typeof props['label'] === 'string' ? props['label'] : 'Follow';
  return (
    <Button
      disabled={!actions['follow']}
      size="sm"
      onClick={() => void actions['follow']?.()}
    >
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
