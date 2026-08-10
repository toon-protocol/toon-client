/**
 * NIP-34 (git) event parsers.
 *
 * kind:30617 repository announcement → RepoMetadata
 * kind:30618 repository refs/state   → RepoRefs
 * kind:1621  issue                   → IssueMetadata
 * kind:1617  patch/PR                → PRMetadata
 * kind:1618  pull request            → PRMetadata
 * kind:1619  PR update (moves tip)   → PRUpdateMetadata, resolved via resolvePRTip
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
  /**
   * Declared maintainer pubkeys (hex) from the `maintainers` tag (#287). Does
   * NOT include the owner, who is an implicit maintainer. Combine with
   * `ownerPubkey` via {@link repoAuthorizedAuthors} to get the full set of
   * authors whose kind:1630-1633 status events are authoritative.
   */
  maintainers: string[];
}

/**
 * NIP-34 tag naming a repo's declared maintainers on the kind:30617:
 * one multi-valued `["maintainers", "<hex>", …]` tag (mirrors `relays`).
 */
const MAINTAINERS_TAG = 'maintainers';
const HEX64_RE = /^[0-9a-f]{64}$/;

/** Collect the lowercased-hex maintainer pubkeys from 30617 tags (#287). */
function parseMaintainerTags(tags: string[][]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tag of tags) {
    if (tag[0] !== MAINTAINERS_TAG) continue;
    for (const value of tag.slice(1)) {
      const hex = value.toLowerCase();
      if (HEX64_RE.test(hex) && !seen.has(hex)) {
        seen.add(hex);
        out.push(hex);
      }
    }
  }
  return out;
}

/**
 * The set of authors whose kind:1630-1633 status events are authoritative for
 * a repo (#287): the owner (always) ∪ declared maintainers. Lowercased hex.
 * Feed this to {@link resolvePRStatus} / {@link resolveIssueStatus}.
 */
export function repoAuthorizedAuthors(repo: RepoMetadata): Set<string> {
  return new Set([repo.ownerPubkey.toLowerCase(), ...repo.maintainers]);
}

/**
 * Collect every value out of a NIP-34 multi-value tag — e.g. `clone` is
 * emitted as ONE tag carrying every URL (`["clone", url1, url2, …]`), unlike
 * `t`/`commit`, which repeat as separate single-value tags. Distinct from
 * {@link getTagValues} in `types.ts`, which grabs only index 1 per matching
 * tag and would silently drop all but the first clone URL here.
 */
function getMultiValueTag(tags: string[][], name: string): string[] {
  const out: string[] = [];
  for (const tag of tags) {
    if (tag[0] !== name) continue;
    out.push(...tag.slice(1));
  }
  return out;
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
    maintainers: parseMaintainerTags(event.tags),
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

/**
 * Parsed pull request metadata from a kind:1617 (patch) or kind:1618 (pull
 * request) event. The two carry the change differently — 1617's `content` is
 * self-contained `git format-patch` output, 1618's is a markdown description
 * and the change lives behind a `["c", "<tip-commit>"]` + `["clone", …]`
 * pointer — hence `sourceKind` and the 1618-only optional fields below.
 */
export interface PRMetadata {
  eventId: string;
  title: string;
  content: string;
  authorPubkey: string;
  createdAt: number;
  commitShas: string[];
  baseBranch: string;
  status: 'open' | 'applied' | 'closed' | 'draft';
  /**
   * PR body from the `description` tag (`rig pr create --body`). Kept apart
   * from `content`, which is pure `git format-patch` output for `git am`.
   */
  description?: string;
  /** Which event kind this was parsed from — 1617 fields are unaffected by 1618's additions. */
  sourceKind: 1617 | 1618;
  /** kind:1618 only: tip commit of the PR branch, from the `c` tag. */
  tipCommit?: string;
  /** kind:1618 only: clone URL(s) where `tipCommit` can be fetched, from the `clone` tag. */
  cloneUrls?: string[];
  /** kind:1618 only: recommended branch name, from the `branch-name` tag. */
  branchName?: string;
  /** kind:1618 only: most recent common ancestor with the target branch, from `merge-base`. */
  mergeBase?: string;
  /** kind:1618 only: labels, from `t` tags. */
  labels?: string[];
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

/** Parse a kind:1617 patch or kind:1618 pull-request event into PRMetadata. */
export function parsePR(event: NostrEvent): PRMetadata | null {
  if (event.kind !== 1617 && event.kind !== 1618) return null;

  const title = getTagValue(event.tags, 'subject') ?? '';
  const commitShas = getTagValues(event.tags, 'commit');
  const baseBranch = getTagValue(event.tags, 'branch') ?? 'main';
  const description = getTagValue(event.tags, 'description');

  const base: PRMetadata = {
    eventId: event.id,
    title,
    content: event.content,
    authorPubkey: event.pubkey,
    createdAt: event.created_at,
    commitShas,
    baseBranch,
    status: 'open',
    sourceKind: event.kind === 1618 ? 1618 : 1617,
    ...(description !== undefined ? { description } : {}),
  };

  if (event.kind !== 1618) return base;

  const tipCommit = getTagValue(event.tags, 'c');
  const cloneUrls = getMultiValueTag(event.tags, 'clone');
  const branchName = getTagValue(event.tags, 'branch-name');
  const mergeBase = getTagValue(event.tags, 'merge-base');
  const labels = getTagValues(event.tags, 't');

  return {
    ...base,
    ...(tipCommit !== undefined ? { tipCommit } : {}),
    ...(cloneUrls.length > 0 ? { cloneUrls } : {}),
    ...(branchName !== undefined ? { branchName } : {}),
    ...(mergeBase !== undefined ? { mergeBase } : {}),
    ...(labels.length > 0 ? { labels } : {}),
  };
}

/**
 * Parsed pull-request-update metadata from a kind:1619 event. Moves the tip
 * of a referenced kind:1618 pull request without republishing the PR itself.
 */
export interface PRUpdateMetadata {
  eventId: string;
  /** The pull-request event this update targets — from the NIP-22 **uppercase** `E` tag. */
  prEventId: string;
  /** Updated tip commit, from the `c` tag. */
  tipCommit?: string;
  /** Clone URL(s) where the updated tip can be fetched, from the `clone` tag. */
  cloneUrls: string[];
  /** Most recent common ancestor with the target branch, from `merge-base`. */
  mergeBase?: string;
  authorPubkey: string;
  createdAt: number;
}

/**
 * Parse a kind:1619 PR-update event into PRUpdateMetadata. The PR reference
 * is the NIP-22 **uppercase** `E` tag, not `e` — a lowercase `e` tag does
 * NOT satisfy this and the event is rejected as unreferenced.
 */
export function parsePRUpdate(event: NostrEvent): PRUpdateMetadata | null {
  if (event.kind !== 1619) return null;

  const prEventId = getTagValue(event.tags, 'E');
  if (!prEventId) return null;

  const tipCommit = getTagValue(event.tags, 'c');
  const cloneUrls = getMultiValueTag(event.tags, 'clone');
  const mergeBase = getTagValue(event.tags, 'merge-base');

  return {
    eventId: event.id,
    prEventId,
    cloneUrls,
    authorPubkey: event.pubkey,
    createdAt: event.created_at,
    ...(tipCommit !== undefined ? { tipCommit } : {}),
    ...(mergeBase !== undefined ? { mergeBase } : {}),
  };
}

/**
 * Resolve the current tip of a pull request from its kind:1619 update
 * events, honoring ONLY updates signed by an AUTHORIZED author — the repo
 * owner ∪ declared maintainers (#287; see {@link repoAuthorizedAuthors}).
 * Same rationale as {@link resolvePRStatus}: the relay is permissionless, so
 * without this filter any funded stranger could repoint someone else's PR at
 * their own commit. Among authorized updates the latest (by created_at)
 * wins. Returns `null` when no authorized update references the PR.
 */
export function resolvePRTip(
  prEventId: string,
  updateEvents: NostrEvent[],
  authorized: Iterable<string>
): PRUpdateMetadata | null {
  const authors = authorized instanceof Set ? authorized : new Set(authorized);

  let latest: NostrEvent | null = null;
  for (const evt of updateEvents) {
    if (evt.kind !== 1619) continue;
    if (!authors.has(evt.pubkey.toLowerCase())) continue;
    if (getTagValue(evt.tags, 'E') !== prEventId) continue;
    if (latest === null || evt.created_at > latest.created_at) latest = evt;
  }

  return latest === null ? null : parsePRUpdate(latest);
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

/**
 * Resolve the status of a PR from status events (kind:1630-1633), honoring
 * ONLY events signed by an AUTHORIZED author — the repo owner ∪ declared
 * maintainers (#287; see {@link repoAuthorizedAuthors}). The relay is
 * permissionless, so any funded stranger can PUBLISH a kind:163x against a PR;
 * this consumer-side filter ensures such spoofed events NEVER move the
 * displayed state. Among authorized events the latest (by created_at) wins.
 *
 * `authorized` is the lowercased-hex author set. When empty (the 30617 was not
 * resolved) nothing is authoritative and the PR resolves to open — a safe,
 * non-spoofable default.
 */
export function resolvePRStatus(
  prEventId: string,
  statusEvents: NostrEvent[],
  authorized: Iterable<string>
): 'open' | 'applied' | 'closed' | 'draft' {
  const KIND_STATUS_MAP: Record<number, 'open' | 'applied' | 'closed' | 'draft'> = {
    1630: 'open',
    1631: 'applied',
    1632: 'closed',
    1633: 'draft',
  };
  const authors = authorized instanceof Set ? authorized : new Set(authorized);

  const relevant = statusEvents.filter((evt) => {
    const eTag = getTagValue(evt.tags, 'e');
    return (
      eTag === prEventId &&
      evt.kind >= 1630 &&
      evt.kind <= 1633 &&
      authors.has(evt.pubkey.toLowerCase())
    );
  });

  if (relevant.length === 0) return 'open';

  let latest = relevant[0] as (typeof relevant)[number];
  for (let i = 1; i < relevant.length; i++) {
    const entry = relevant[i] as (typeof relevant)[number];
    if (entry.created_at > latest.created_at) latest = entry;
  }

  return KIND_STATUS_MAP[latest.kind] ?? 'open';
}

/**
 * Resolve the status of an issue from close events (kind:1632), honoring ONLY
 * events signed by an AUTHORIZED author (owner ∪ maintainers, #287). An
 * unauthorized close event does NOT close the issue. `authorized` is the
 * lowercased-hex author set (see {@link repoAuthorizedAuthors}).
 */
export function resolveIssueStatus(
  issueEventId: string,
  closeEvents: NostrEvent[],
  authorized: Iterable<string>
): 'open' | 'closed' {
  const authors = authorized instanceof Set ? authorized : new Set(authorized);
  const isClosed = closeEvents.some((evt) => {
    const eTag = getTagValue(evt.tags, 'e');
    return (
      eTag === issueEventId &&
      evt.kind === 1632 &&
      authors.has(evt.pubkey.toLowerCase())
    );
  });
  return isClosed ? 'closed' : 'open';
}
