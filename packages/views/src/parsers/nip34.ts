/**
 * NIP-34 (git) event parsers.
 *
 * kind:30617 repository announcement → RepoMetadata
 * kind:30618 repository refs/state   → RepoRefs
 * kind:1621  issue                   → IssueMetadata
 * kind:1617  patch/PR                → PRMetadata
 * kind:1622  comment                 → CommentMetadata
 * kind:1630-1633 status              → resolved via resolvePRStatus / resolveIssueStatus
 *
 * Moved verbatim from rig's `web/nip34-parsers.ts` so rig and the MCP-app
 * bundle share one parser corpus.
 */

import { type NostrEvent, getTagValue, getTagValues } from '../types.js';

/** Parsed repository metadata from a kind:30617 event. */
export interface RepoMetadata {
  repoId: string;
  name: string;
  description: string;
  ownerPubkey: string;
  defaultBranch: string;
  eventId: string;
  cloneUrls: string[];
  webUrls: string[];
}

/** Maximum number of refs to parse from a single kind:30618 event. */
const MAX_REFS_PER_EVENT = 1000;

/** Parsed repository refs from a kind:30618 event. */
export interface RepoRefs {
  repoId: string;
  refs: Map<string, string>;
  arweaveMap: Map<string, string>;
}

/** Parse a kind:30618 repository refs event into RepoRefs. */
export function parseRepoRefs(event: NostrEvent): RepoRefs | null {
  if (event.kind !== 30618) return null;

  const dTag = getTagValue(event.tags, 'd');
  if (!dTag) return null;

  const refs = new Map<string, string>();
  const arweaveMap = new Map<string, string>();
  for (const tag of event.tags) {
    if (tag[0] === 'r' && tag[1] && tag[2]) {
      if (refs.size >= MAX_REFS_PER_EVENT) break;
      refs.set(tag[1], tag[2]);
    } else if (tag[0] === 'arweave' && tag[1] && tag[2]) {
      arweaveMap.set(tag[1], tag[2]);
    }
  }

  return { repoId: dTag, refs, arweaveMap };
}

/** Parse a kind:30617 repository announcement event into RepoMetadata. */
export function parseRepoAnnouncement(event: NostrEvent): RepoMetadata | null {
  if (event.kind !== 30617) return null;

  const dTag = getTagValue(event.tags, 'd');
  if (!dTag) return null;

  const name = getTagValue(event.tags, 'name') ?? dTag;
  const description = getTagValue(event.tags, 'description') ?? event.content;

  const refTag = event.tags.find((t) => t[0] === 'r' && t[1] === 'HEAD' && t[2]);
  const defaultBranch = refTag?.[2] ?? 'main';

  const cloneUrls = getTagValues(event.tags, 'clone');
  const webUrls = getTagValues(event.tags, 'web');

  return {
    repoId: dTag,
    name,
    description,
    ownerPubkey: event.pubkey,
    defaultBranch,
    eventId: event.id,
    cloneUrls,
    webUrls,
  };
}

/** Parsed issue metadata from a kind:1621 event. */
export interface IssueMetadata {
  eventId: string;
  title: string;
  content: string;
  authorPubkey: string;
  createdAt: number;
  labels: string[];
  status: 'open' | 'closed';
}

/** Parsed pull request metadata from a kind:1617 event. */
export interface PRMetadata {
  eventId: string;
  title: string;
  content: string;
  authorPubkey: string;
  createdAt: number;
  commitShas: string[];
  baseBranch: string;
  status: 'open' | 'applied' | 'closed' | 'draft';
}

/** Parsed comment metadata from a kind:1622 event. */
export interface CommentMetadata {
  eventId: string;
  content: string;
  authorPubkey: string;
  createdAt: number;
  parentEventId: string;
}

/** Parse a kind:1621 issue event into IssueMetadata. */
export function parseIssue(event: NostrEvent): IssueMetadata | null {
  if (event.kind !== 1621) return null;

  const subjectTag = getTagValue(event.tags, 'subject');
  const title = subjectTag ?? event.content.split('\n')[0] ?? '';
  const labels = getTagValues(event.tags, 't');

  return {
    eventId: event.id,
    title,
    content: event.content,
    authorPubkey: event.pubkey,
    createdAt: event.created_at,
    labels,
    status: 'open',
  };
}

/** Parse a kind:1617 patch/PR event into PRMetadata. */
export function parsePR(event: NostrEvent): PRMetadata | null {
  if (event.kind !== 1617) return null;

  const title = getTagValue(event.tags, 'subject') ?? '';
  const commitShas = getTagValues(event.tags, 'commit');
  const baseBranch = getTagValue(event.tags, 'branch') ?? 'main';

  return {
    eventId: event.id,
    title,
    content: event.content,
    authorPubkey: event.pubkey,
    createdAt: event.created_at,
    commitShas,
    baseBranch,
    status: 'open',
  };
}

/** Parse a kind:1622 comment event into CommentMetadata. */
export function parseComment(event: NostrEvent): CommentMetadata | null {
  if (event.kind !== 1622) return null;

  const parentEventId = getTagValue(event.tags, 'e');
  if (!parentEventId) return null;

  return {
    eventId: event.id,
    content: event.content,
    authorPubkey: event.pubkey,
    createdAt: event.created_at,
    parentEventId,
  };
}

/** Resolve the status of a PR from status events (kind:1630-1633). */
export function resolvePRStatus(
  prEventId: string,
  statusEvents: NostrEvent[]
): 'open' | 'applied' | 'closed' | 'draft' {
  const KIND_STATUS_MAP: Record<number, 'open' | 'applied' | 'closed' | 'draft'> = {
    1630: 'open',
    1631: 'applied',
    1632: 'closed',
    1633: 'draft',
  };

  const relevant = statusEvents.filter((evt) => {
    const eTag = getTagValue(evt.tags, 'e');
    return eTag === prEventId && evt.kind >= 1630 && evt.kind <= 1633;
  });

  if (relevant.length === 0) return 'open';

  let latest = relevant[0] as (typeof relevant)[number];
  for (let i = 1; i < relevant.length; i++) {
    const entry = relevant[i] as (typeof relevant)[number];
    if (entry.created_at > latest.created_at) latest = entry;
  }

  return KIND_STATUS_MAP[latest.kind] ?? 'open';
}

/** Resolve the status of an issue from close events (kind:1632). */
export function resolveIssueStatus(
  issueEventId: string,
  closeEvents: NostrEvent[]
): 'open' | 'closed' {
  const isClosed = closeEvents.some((evt) => {
    const eTag = getTagValue(evt.tags, 'e');
    return eTag === issueEventId && evt.kind === 1632;
  });
  return isClosed ? 'closed' : 'open';
}
