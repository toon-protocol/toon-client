/**
 * Core social-NIP parsers.
 *
 * NIP-01 kind:0  profile metadata  → ProfileMetadata
 * NIP-01 kind:1  text note         → NoteMetadata (with NIP-10 thread refs)
 * NIP-02 kind:3  follow list       → FollowList
 * NIP-25 kind:7  reaction          → Reaction
 * NIP-18 kind:6/16 repost          → Repost
 */

import { type NostrEvent, getTagValue, getTagValues } from '../types.js';

/** Parsed profile (kind:0). Unknown JSON fields are preserved in `raw`. */
export interface ProfileMetadata {
  pubkey: string;
  name?: string;
  displayName?: string;
  about?: string;
  picture?: string;
  banner?: string;
  nip05?: string;
  lud16?: string;
  website?: string;
  raw: Record<string, unknown>;
}

/** Parse a kind:0 profile metadata event. Returns null on wrong kind / bad JSON. */
export function parseProfile(event: NostrEvent): ProfileMetadata | null {
  if (event.kind !== 0) return null;

  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(event.content);
    if (typeof parsed !== 'object' || parsed === null) return null;
    raw = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  const str = (k: string): string | undefined =>
    typeof raw[k] === 'string' ? (raw[k] as string) : undefined;

  return {
    pubkey: event.pubkey,
    name: str('name'),
    displayName: str('display_name') ?? str('displayName'),
    about: str('about'),
    picture: str('picture'),
    banner: str('banner'),
    nip05: str('nip05'),
    lud16: str('lud16'),
    website: str('website'),
    raw,
  };
}

/** NIP-10 thread references parsed from a note's `e`/`p` tags. */
export interface ThreadRefs {
  /** Root event id of the thread, if any. */
  rootId?: string;
  /** Immediate parent event id this note replies to, if any. */
  replyToId?: string;
  /** Pubkeys referenced via `p` tags. */
  mentionedPubkeys: string[];
}

/** Parsed text note (kind:1). */
export interface NoteMetadata {
  eventId: string;
  content: string;
  authorPubkey: string;
  createdAt: number;
  thread: ThreadRefs;
  /** True when the note is a reply (has a parent or root reference). */
  isReply: boolean;
}

/**
 * Resolve NIP-10 thread refs from `e` tags, preferring marked tags
 * (`["e", id, relay, "root"|"reply"]`) and falling back to positional
 * semantics (first = root, last = reply) for legacy notes.
 */
export function parseThreadRefs(tags: string[][]): ThreadRefs {
  const eTags = tags.filter((t) => t[0] === 'e' && t[1]);
  const mentionedPubkeys = getTagValues(tags, 'p');

  let rootId: string | undefined;
  let replyToId: string | undefined;

  const marked = eTags.filter((t) => t[3] === 'root' || t[3] === 'reply');
  if (marked.length > 0) {
    rootId = marked.find((t) => t[3] === 'root')?.[1];
    replyToId = marked.find((t) => t[3] === 'reply')?.[1] ?? rootId;
  } else if (eTags.length === 1) {
    rootId = eTags[0]?.[1];
    replyToId = rootId;
  } else if (eTags.length > 1) {
    rootId = eTags[0]?.[1];
    replyToId = eTags[eTags.length - 1]?.[1];
  }

  const refs: ThreadRefs = { mentionedPubkeys };
  if (rootId !== undefined) refs.rootId = rootId;
  if (replyToId !== undefined) refs.replyToId = replyToId;
  return refs;
}

/** Parse a kind:1 text note. */
export function parseNote(event: NostrEvent): NoteMetadata | null {
  if (event.kind !== 1) return null;

  const thread = parseThreadRefs(event.tags);
  return {
    eventId: event.id,
    content: event.content,
    authorPubkey: event.pubkey,
    createdAt: event.created_at,
    thread,
    isReply: thread.rootId !== undefined || thread.replyToId !== undefined,
  };
}

/** Parsed follow list (kind:3, NIP-02). */
export interface FollowList {
  pubkey: string;
  follows: string[];
  createdAt: number;
}

/** Parse a kind:3 follow list. */
export function parseFollowList(event: NostrEvent): FollowList | null {
  if (event.kind !== 3) return null;
  return {
    pubkey: event.pubkey,
    follows: getTagValues(event.tags, 'p'),
    createdAt: event.created_at,
  };
}

/** Parsed reaction (kind:7, NIP-25). */
export interface Reaction {
  eventId: string;
  authorPubkey: string;
  createdAt: number;
  /** Reaction content: `+`, `-`, or an emoji/shortcode. */
  content: string;
  /** Event the reaction targets (last `e` tag per NIP-25). */
  targetEventId?: string;
  /** Author of the targeted event (last `p` tag). */
  targetPubkey?: string;
}

/** Parse a kind:7 reaction. */
export function parseReaction(event: NostrEvent): Reaction | null {
  if (event.kind !== 7) return null;

  const eTags = getTagValues(event.tags, 'e');
  const pTags = getTagValues(event.tags, 'p');

  const reaction: Reaction = {
    eventId: event.id,
    authorPubkey: event.pubkey,
    createdAt: event.created_at,
    content: event.content || '+',
  };
  const targetEventId = eTags[eTags.length - 1];
  const targetPubkey = pTags[pTags.length - 1];
  if (targetEventId !== undefined) reaction.targetEventId = targetEventId;
  if (targetPubkey !== undefined) reaction.targetPubkey = targetPubkey;
  return reaction;
}

/** Parsed repost (kind:6 or kind:16, NIP-18). */
export interface Repost {
  eventId: string;
  authorPubkey: string;
  createdAt: number;
  /** Reposted event id (`e` tag). */
  repostedEventId?: string;
  /** Author of the reposted event (`p` tag). */
  repostedPubkey?: string;
  /** For generic reposts (kind:16), the original kind from the `k` tag. */
  repostedKind?: number;
}

/** Parse a kind:6 (repost) or kind:16 (generic repost). */
export function parseRepost(event: NostrEvent): Repost | null {
  if (event.kind !== 6 && event.kind !== 16) return null;

  const repost: Repost = {
    eventId: event.id,
    authorPubkey: event.pubkey,
    createdAt: event.created_at,
  };
  const repostedEventId = getTagValue(event.tags, 'e');
  const repostedPubkey = getTagValue(event.tags, 'p');
  const kTag = getTagValue(event.tags, 'k');
  if (repostedEventId !== undefined) repost.repostedEventId = repostedEventId;
  if (repostedPubkey !== undefined) repost.repostedPubkey = repostedPubkey;
  if (kTag !== undefined) {
    const k = Number(kTag);
    if (Number.isFinite(k)) repost.repostedKind = k;
  }
  return repost;
}
