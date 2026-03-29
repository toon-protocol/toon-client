/**
 * NIP-34 event parsers for Rig-UI.
 *
 * Parses kind:30617 repository announcement events into RepoMetadata,
 * kind:1621 issue events into IssueMetadata, kind:1617 patch events
 * into PRMetadata, and kind:1622 comment events into CommentMetadata
 * for rendering in the repository list and issue/PR views.
 */

/**
 * Parsed repository metadata from a kind:30617 event.
 */
export interface RepoMetadata {
  /** Repository identifier (from `d` tag — used in URLs and relay queries) */
  repoId: string;
  /** Repository name (from `name` tag, falling back to `d` tag) */
  name: string;
  /** Repository description (from `description` tag or content) */
  description: string;
  /** Owner pubkey (hex) */
  ownerPubkey: string;
  /** Default branch (from `r` tag with HEAD marker) */
  defaultBranch: string;
  /** Event ID */
  eventId: string;
  /** Clone URLs (from `clone` tags) */
  cloneUrls: string[];
  /** Web URLs (from `web` tags) */
  webUrls: string[];
}

/**
 * Minimal NostrEvent interface for browser use (avoids importing nostr-tools).
 */
export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

/**
 * Nostr subscription filter.
 */
export interface NostrFilter {
  kinds?: number[];
  authors?: string[];
  ids?: string[];
  '#d'?: string[];
  '#e'?: string[];
  '#a'?: string[];
  limit?: number;
}

/**
 * Get the first value for a tag name.
 */
function getTagValue(tags: string[][], name: string): string | undefined {
  const tag = tags.find((t) => t[0] === name);
  return tag?.[1];
}

/**
 * Get all values for a tag name.
 */
function getTagValues(tags: string[][], name: string): string[] {
  return tags
    .filter((t) => t[0] === name)
    .map((t) => t[1])
    .filter((v): v is string => v !== undefined);
}

/**
 * Maximum number of refs to parse from a single kind:30618 event.
 * Prevents excessive memory allocation from maliciously crafted events.
 */
const MAX_REFS_PER_EVENT = 1000;

/**
 * Parsed repository refs from a kind:30618 event.
 */
export interface RepoRefs {
  /** Repository identifier (from d tag) */
  repoId: string;
  /** Map of ref name to commit SHA */
  refs: Map<string, string>;
  /** Map of git SHA to Arweave txId (from `arweave` tags, bypasses GraphQL) */
  arweaveMap: Map<string, string>;
}

/**
 * Parse a kind:30618 repository refs event into RepoRefs.
 *
 * kind:30618 is a NIP-33 parameterized replaceable event for repository refs/branches:
 * - `d` tag: repository identifier (matches kind:30617)
 * - `r` tags: `["r", "<ref-name>", "<commit-sha>"]`
 *
 * @param event - A NostrEvent (expected kind:30618)
 * @returns RepoRefs if valid, null if malformed
 */
export function parseRepoRefs(event: NostrEvent): RepoRefs | null {
  if (event.kind !== 30618) {
    return null;
  }

  const dTag = getTagValue(event.tags, 'd');
  if (!dTag) {
    return null;
  }

  const refs = new Map<string, string>();
  const arweaveMap = new Map<string, string>();
  for (const tag of event.tags) {
    if (tag[0] === 'r' && tag[1] && tag[2]) {
      if (refs.size >= MAX_REFS_PER_EVENT) break;
      refs.set(tag[1], tag[2]);
    } else if (tag[0] === 'arweave' && tag[1] && tag[2]) {
      // ["arweave", "<git-sha>", "<arweave-txId>"]
      arweaveMap.set(tag[1], tag[2]);
    }
  }

  return { repoId: dTag, refs, arweaveMap };
}

/**
 * Parse a kind:30617 repository announcement event into RepoMetadata.
 *
 * @param event - A NostrEvent (expected kind:30617)
 * @returns RepoMetadata if valid, null if malformed
 */
export function parseRepoAnnouncement(event: NostrEvent): RepoMetadata | null {
  // Validate kind
  if (event.kind !== 30617) {
    return null;
  }

  // d tag is required (NIP-33 parameterized replaceable event identifier)
  const dTag = getTagValue(event.tags, 'd');
  if (!dTag) {
    return null;
  }

  // Name: prefer `name` tag, fall back to `d` tag
  const name = getTagValue(event.tags, 'name') ?? dTag;

  // Description: prefer `description` tag, fall back to content
  const description = getTagValue(event.tags, 'description') ?? event.content;

  // Default branch: extracted from `r` tag with HEAD marker
  // Format: ["r", "HEAD", "main"]
  const refTag = event.tags.find(
    (t) => t[0] === 'r' && t[1] === 'HEAD' && t[2]
  );
  const defaultBranch = refTag?.[2] ?? 'main';

  // Clone URLs
  const cloneUrls = getTagValues(event.tags, 'clone');

  // Web URLs
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

// ============================================================================
// NIP-34 Issue / PR / Comment Types and Parsers (Story 8.5)
// ============================================================================

/**
 * Parsed issue metadata from a kind:1621 event.
 */
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
 * Parsed pull request metadata from a kind:1617 event.
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
}

/**
 * Parsed comment metadata from a kind:1622 event.
 */
export interface CommentMetadata {
  eventId: string;
  content: string;
  authorPubkey: string;
  createdAt: number;
  parentEventId: string;
}

/**
 * Parse a kind:1621 issue event into IssueMetadata.
 *
 * @param event - A NostrEvent (expected kind:1621)
 * @returns IssueMetadata if valid, null if wrong kind
 */
export function parseIssue(event: NostrEvent): IssueMetadata | null {
  if (event.kind !== 1621) {
    return null;
  }

  // Title from subject tag, fallback to first line of content
  const subjectTag = getTagValue(event.tags, 'subject');
  const title = subjectTag ?? event.content.split('\n')[0] ?? '';

  // Labels from t tags
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

/**
 * Parse a kind:1617 patch/PR event into PRMetadata.
 *
 * @param event - A NostrEvent (expected kind:1617)
 * @returns PRMetadata if valid, null if wrong kind
 */
export function parsePR(event: NostrEvent): PRMetadata | null {
  if (event.kind !== 1617) {
    return null;
  }

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

/**
 * Parse a kind:1622 comment event into CommentMetadata.
 *
 * @param event - A NostrEvent (expected kind:1622)
 * @returns CommentMetadata if valid, null if wrong kind or missing parent
 */
export function parseComment(event: NostrEvent): CommentMetadata | null {
  if (event.kind !== 1622) {
    return null;
  }

  const parentEventId = getTagValue(event.tags, 'e');
  if (!parentEventId) {
    return null;
  }

  return {
    eventId: event.id,
    content: event.content,
    authorPubkey: event.pubkey,
    createdAt: event.created_at,
    parentEventId,
  };
}

/**
 * Resolve the status of a PR from status events (kind:1630-1633).
 *
 * Filters status events to those referencing the PR, finds the most recent,
 * and maps kind to status: 1630=open, 1631=applied, 1632=closed, 1633=draft.
 *
 * @param prEventId - The PR event ID to resolve status for
 * @param statusEvents - Array of kind:1630-1633 events
 * @returns Resolved status string
 */
export function resolvePRStatus(
  prEventId: string,
  statusEvents: NostrEvent[]
): 'open' | 'applied' | 'closed' | 'draft' {
  const KIND_STATUS_MAP: Record<
    number,
    'open' | 'applied' | 'closed' | 'draft'
  > = {
    1630: 'open',
    1631: 'applied',
    1632: 'closed',
    1633: 'draft',
  };

  // Filter to status events referencing this PR
  const relevant = statusEvents.filter((evt) => {
    const eTag = getTagValue(evt.tags, 'e');
    return eTag === prEventId && evt.kind >= 1630 && evt.kind <= 1633;
  });

  if (relevant.length === 0) {
    return 'open';
  }

  // Find most recent by created_at
  let latest = relevant[0] as (typeof relevant)[number];
  for (let i = 1; i < relevant.length; i++) {
    const entry = relevant[i] as (typeof relevant)[number];
    if (entry.created_at > latest.created_at) {
      latest = entry;
    }
  }

  return KIND_STATUS_MAP[latest.kind] ?? 'open';
}

/**
 * Resolve the status of an issue from close events (kind:1632).
 *
 * An issue is closed if ANY kind:1632 event has an `e` tag referencing
 * the issue's event ID; otherwise it is open.
 *
 * @param issueEventId - The issue event ID to resolve status for
 * @param closeEvents - Array of kind:1632 events
 * @returns Resolved status string
 */
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
