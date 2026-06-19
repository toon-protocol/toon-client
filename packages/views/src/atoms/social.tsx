/** Social atoms — NIP-01 profile/note, NIP-25 reactions, NIP-02 follow. */
import { type FC } from 'react';
import { cn } from '../lib/cn.js';
import { parseProfile, parseNote, parseReaction } from '../parsers/social.js';
import { type Atom, type AtomRenderProps } from './types.js';

function shortPk(pk: string): string {
  return pk.length > 12 ? `${pk.slice(0, 8)}…${pk.slice(-4)}` : pk;
}

const ProfileHeader: FC<AtomRenderProps> = ({ events }) => {
  const profile = events.map(parseProfile).find((p) => p !== null) ?? null;
  if (!profile) return null;
  const name = profile.displayName ?? profile.name ?? shortPk(profile.pubkey);
  return (
    <div className="flex items-center gap-3">
      {profile.picture ? (
        <img
          src={profile.picture}
          alt={name}
          className="h-12 w-12 rounded-full object-cover"
        />
      ) : (
        <div className="h-12 w-12 rounded-full bg-muted" />
      )}
      <div className="min-w-0">
        <div className="truncate font-semibold">{name}</div>
        {profile.nip05 ? (
          <div className="truncate text-xs text-muted-foreground">{profile.nip05}</div>
        ) : null}
        {profile.about ? (
          <div className="line-clamp-2 text-sm text-muted-foreground">{profile.about}</div>
        ) : null}
      </div>
    </div>
  );
};

const NoteCard: FC<AtomRenderProps> = ({ events, actions }) => {
  const note = events.map(parseNote).find((n) => n !== null) ?? null;
  if (!note) return null;
  return (
    <article className="flex flex-col gap-2 border-b border-border py-3">
      <header className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{shortPk(note.authorPubkey)}</span>
        {note.isReply ? <span className="rounded bg-muted px-1">reply</span> : null}
      </header>
      <p className="whitespace-pre-wrap break-words text-sm">{note.content}</p>
      {actions['reply'] ? (
        <div>
          <button
            type="button"
            className="text-xs text-muted-foreground hover:text-foreground"
            onClick={() => void actions['reply']?.({ parentId: note.eventId })}
          >
            Reply
          </button>
        </div>
      ) : null}
    </article>
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
    <div className="flex items-center gap-2">
      {[...counts.entries()].map(([emoji, n]) => (
        <span key={emoji} className="rounded-full bg-muted px-2 py-0.5 text-xs">
          {emoji} {n}
        </span>
      ))}
      {actions['react'] ? (
        <button
          type="button"
          className="rounded-full border border-border px-2 py-0.5 text-xs hover:bg-muted"
          onClick={() => void actions['react']?.({ content: '+' })}
        >
          + React
        </button>
      ) : null}
    </div>
  );
};

const FollowButton: FC<AtomRenderProps> = ({ props, actions }) => {
  const label = typeof props['label'] === 'string' ? props['label'] : 'Follow';
  return (
    <button
      type="button"
      disabled={!actions['follow']}
      className={cn(
        'rounded-md px-3 py-1 text-sm font-medium',
        'bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50'
      )}
      onClick={() => void actions['follow']?.()}
    >
      {label}
    </button>
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
