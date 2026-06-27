/**
 * NIP-01 filter builders for the read side (all reads are free via `toon_read`).
 *
 * The forge builders are promoted from rig's `web/relay-client.ts`; the social
 * and media builders are new. Pure functions returning {@link NostrFilter}.
 */

import { type NostrFilter } from './types.js';

// ── NIP-34 forge ───────────────────────────────────────────────────────────

/** kind:30617 repository announcements. */
export function buildRepoListFilter(): NostrFilter {
  return { kinds: [30617] };
}

/** kind:30618 repository refs/state for one repo. */
export function buildRepoRefsFilter(pubkey: string, repoId: string): NostrFilter {
  return { kinds: [30618], authors: [pubkey], '#d': [repoId] };
}

/** kind:1621 issues for a repository. */
export function buildIssueListFilter(ownerPubkey: string, repoId: string): NostrFilter {
  return { kinds: [1621], '#a': [`30617:${ownerPubkey}:${repoId}`], limit: 100 };
}

/** kind:1617 patches/PRs for a repository. */
export function buildPRListFilter(ownerPubkey: string, repoId: string): NostrFilter {
  return { kinds: [1617], '#a': [`30617:${ownerPubkey}:${repoId}`], limit: 100 };
}

/** kind:1622 comments by parent event id(s). */
export function buildCommentFilter(eventIds: string[]): NostrFilter {
  return { kinds: [1622], '#e': eventIds, limit: 500 };
}

/** kind:1630-1633 status events by referenced event id(s). */
export function buildStatusFilter(eventIds: string[]): NostrFilter {
  return { kinds: [1630, 1631, 1632, 1633], '#e': eventIds, limit: 500 };
}

/** kind:1632 issue-close events by issue event id(s). */
export function buildIssueCloseFilter(eventIds: string[]): NostrFilter {
  return { kinds: [1632], '#e': eventIds, limit: 500 };
}

/** Fetch specific events by id. */
export function buildEventByIdFilter(eventIds: string[]): NostrFilter {
  return { ids: eventIds };
}

// ── Social (NIP-01/02/10/18/25) ──────────────────────────────────────────────

/** kind:0 profile metadata for the given pubkeys. */
export function buildProfileFilter(pubkeys: string[]): NostrFilter {
  return { kinds: [0], authors: pubkeys };
}

/**
 * Social feed, optionally scoped to authors: kind:1 text notes plus inline media
 * — NIP-68 pictures (20) / video (21,22) and NIP-94 file metadata (1063). The
 * feed binds with `kindAuto`, so each kind renders via its own atom (note-card
 * for kind:1, media-embed for the media kinds), interleaved newest-first.
 */
export function buildFeedFilter(authors?: string[], limit = 100): NostrFilter {
  const f: NostrFilter = { kinds: [1, 20, 21, 22, 1063], limit };
  if (authors && authors.length > 0) f.authors = authors;
  return f;
}

/** kind:1 replies referencing the given note id(s) (NIP-10 thread). */
export function buildRepliesFilter(eventIds: string[]): NostrFilter {
  return { kinds: [1], '#e': eventIds, limit: 500 };
}

/** kind:3 follow list for a pubkey. */
export function buildFollowListFilter(pubkey: string): NostrFilter {
  return { kinds: [3], authors: [pubkey], limit: 1 };
}

/** kind:7 reactions targeting the given event id(s). */
export function buildReactionFilter(eventIds: string[]): NostrFilter {
  return { kinds: [7], '#e': eventIds, limit: 1000 };
}

/** kind:6/16 reposts targeting the given event id(s). */
export function buildRepostFilter(eventIds: string[]): NostrFilter {
  return { kinds: [6, 16], '#e': eventIds, limit: 500 };
}

// ── Media (NIP-68/71/94) ─────────────────────────────────────────────────────

/** kind:20/21/22 media posts, optionally scoped to authors. */
export function buildMediaFeedFilter(authors?: string[], limit = 100): NostrFilter {
  const f: NostrFilter = { kinds: [20, 21, 22], limit };
  if (authors && authors.length > 0) f.authors = authors;
  return f;
}

/** kind:1063 NIP-94 file metadata, optionally scoped to authors. */
export function buildFileMetadataFilter(authors?: string[], limit = 100): NostrFilter {
  const f: NostrFilter = { kinds: [1063], limit };
  if (authors && authors.length > 0) f.authors = authors;
  return f;
}
