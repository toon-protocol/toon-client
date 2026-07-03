/**
 * Pure NIP-34 event builders for the Git-to-TOON write path.
 *
 * Promoted from `packages/rig-web/tests/e2e/seed/lib/event-builders.ts` (#223).
 * All builders return UnsignedEvent — the caller signs with their keypair
 * via finalizeEvent() and publishes through a Publisher (#226). Tag
 * structures follow the NIP-34 spec and `@toon-protocol/core/nip34`.
 */

import {
  ISSUE_KIND,
  PATCH_KIND,
  REPOSITORY_ANNOUNCEMENT_KIND,
} from '@toon-protocol/core/nip34';
import type {
  STATUS_APPLIED_KIND,
  STATUS_CLOSED_KIND,
  STATUS_DRAFT_KIND,
  STATUS_OPEN_KIND,
} from '@toon-protocol/core/nip34';

// Kinds not (yet) exported by @toon-protocol/core/nip34:
/** Repository State (refs) — replaceable, pairs with kind:30617 via `d` tag. */
export const REPOSITORY_STATE_KIND = 30618;
/** Comment on an issue or patch (NIP-22 style threading within NIP-34). */
export const COMMENT_KIND = 1622;

// ---------------------------------------------------------------------------
// UnsignedEvent type (subset of nostr-tools — no id, sig, or pubkey)
// ---------------------------------------------------------------------------

export interface UnsignedEvent {
  kind: number;
  content: string;
  tags: string[][];
  created_at: number;
}

// ---------------------------------------------------------------------------
// kind:30617 — Repository Announcement (+ maintainer authority, #287)
// ---------------------------------------------------------------------------

/**
 * NIP-34 tag naming the repo's declared maintainers: one multi-valued tag
 * `["maintainers", "<hex-pubkey>", "<hex-pubkey>", …]` on the kind:30617
 * announcement (mirrors the spec's multi-valued `relays` tag). The repo
 * OWNER — the announcement event's own pubkey — is ALWAYS an implicit
 * maintainer and need not be listed. Consumers derive an issue/PR's status
 * ONLY from kind:1630-1633 events signed by owner ∪ maintainers (#287): the
 * relay is permissionless, so this is the CONSUMER-side authority filter.
 */
export const MAINTAINERS_TAG = 'maintainers';

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Collect the declared maintainer pubkeys (lowercased hex) from a kind:30617
 * event's tags. Tolerant of repeated `maintainers` tags and non-hex noise —
 * only 64-char hex values survive. Does NOT include the owner (implicit).
 */
export function parseMaintainers(tags: string[][]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tag of tags) {
    if (tag[0] !== MAINTAINERS_TAG) continue;
    for (const value of tag.slice(1)) {
      const hex = value.toLowerCase();
      if (HEX64.test(hex) && !seen.has(hex)) {
        seen.add(hex);
        out.push(hex);
      }
    }
  }
  return out;
}

/**
 * The set of pubkeys whose kind:1630-1633 status events are authoritative for
 * a repo: the owner (always) ∪ the declared maintainers (from the 30617's
 * `maintainers` tag). All values are lowercased hex.
 */
export function authorizedStatusAuthors(
  ownerPubkey: string,
  repoAnnouncementTags: string[][]
): Set<string> {
  return new Set([
    ownerPubkey.toLowerCase(),
    ...parseMaintainers(repoAnnouncementTags),
  ]);
}

/**
 * Build a kind:30617 repository announcement event.
 *
 * @param repoId - Repository identifier (d tag)
 * @param name - Human-readable repository name
 * @param description - Repository description
 * @param maintainers - Optional declared maintainer pubkeys (hex). Emitted as
 *   a single `["maintainers", …]` tag when non-empty. The signer (owner) is an
 *   implicit maintainer and is filtered out if passed. See {@link MAINTAINERS_TAG}.
 */
export function buildRepoAnnouncement(
  repoId: string,
  name: string,
  description: string,
  maintainers: string[] = []
): UnsignedEvent {
  const tags: string[][] = [
    ['d', repoId],
    ['name', name],
    ['description', description],
  ];
  const declared: string[] = [];
  const seen = new Set<string>();
  for (const value of maintainers) {
    const hex = value.toLowerCase();
    if (HEX64.test(hex) && !seen.has(hex)) {
      seen.add(hex);
      declared.push(hex);
    }
  }
  if (declared.length > 0) {
    tags.push([MAINTAINERS_TAG, ...declared]);
  }
  return {
    kind: REPOSITORY_ANNOUNCEMENT_KIND,
    content: '',
    tags,
    created_at: Math.floor(Date.now() / 1000),
  };
}

// ---------------------------------------------------------------------------
// kind:30618 — Repository Refs/State
// ---------------------------------------------------------------------------

/**
 * Build a kind:30618 repository refs/state event.
 *
 * @param repoId - Repository identifier (d tag, matches kind:30617)
 * @param refs - Map of ref paths to commit SHAs (e.g., { 'refs/heads/main': 'abc123' })
 * @param arweaveMap - Map of git SHAs to Arweave transaction IDs
 */
export function buildRepoRefs(
  repoId: string,
  refs: Record<string, string>,
  arweaveMap: Record<string, string> = {}
): UnsignedEvent {
  const tags: string[][] = [['d', repoId]];

  // Add ref tags
  for (const [refPath, commitSha] of Object.entries(refs)) {
    tags.push(['r', refPath, commitSha]);
  }

  // Default HEAD to first ref (typically refs/heads/main)
  const firstRef = Object.keys(refs)[0];
  if (firstRef) {
    tags.push(['HEAD', `ref: ${firstRef}`]);
  }

  // Add arweave SHA-to-txId mapping tags
  for (const [sha, txId] of Object.entries(arweaveMap)) {
    tags.push(['arweave', sha, txId]);
  }

  return {
    kind: REPOSITORY_STATE_KIND,
    content: '',
    tags,
    created_at: Math.floor(Date.now() / 1000),
  };
}

// ---------------------------------------------------------------------------
// kind:1621 — Issue
// ---------------------------------------------------------------------------

/**
 * Build a kind:1621 issue event.
 *
 * @param repoOwnerPubkey - Pubkey of the repository owner
 * @param repoId - Repository identifier
 * @param title - Issue title (subject tag)
 * @param body - Issue body (Markdown content)
 * @param labels - Optional labels (t tags)
 */
export function buildIssue(
  repoOwnerPubkey: string,
  repoId: string,
  title: string,
  body: string,
  labels: string[] = []
): UnsignedEvent {
  const tags: string[][] = [
    ['a', `${REPOSITORY_ANNOUNCEMENT_KIND}:${repoOwnerPubkey}:${repoId}`],
    ['p', repoOwnerPubkey],
    ['subject', title],
    ...labels.map((label) => ['t', label]),
  ];

  return {
    kind: ISSUE_KIND,
    content: body,
    tags,
    created_at: Math.floor(Date.now() / 1000),
  };
}

// ---------------------------------------------------------------------------
// kind:1622 — Comment (on issue or PR)
// ---------------------------------------------------------------------------

/**
 * Build a kind:1622 comment event.
 *
 * @param repoOwnerPubkey - Pubkey of the repository owner
 * @param repoId - Repository identifier
 * @param issueOrPrEventId - Event ID of the issue or PR being commented on
 * @param authorPubkey - Pubkey of the issue/PR author (NIP-34 `p` tag for threading), NOT the comment author
 * @param body - Comment body (Markdown content)
 * @param marker - Event reference marker: 'root' or 'reply' (default: 'reply')
 */
export function buildComment(
  repoOwnerPubkey: string,
  repoId: string,
  issueOrPrEventId: string,
  authorPubkey: string,
  body: string,
  marker: 'root' | 'reply' = 'reply'
): UnsignedEvent {
  return {
    kind: COMMENT_KIND,
    content: body,
    tags: [
      ['a', `${REPOSITORY_ANNOUNCEMENT_KIND}:${repoOwnerPubkey}:${repoId}`],
      ['e', issueOrPrEventId, '', marker],
      ['p', authorPubkey],
    ],
    created_at: Math.floor(Date.now() / 1000),
  };
}

// ---------------------------------------------------------------------------
// kind:1617 — Patch / PR
// ---------------------------------------------------------------------------

/**
 * Build a kind:1617 patch event.
 *
 * The PR body/description travels in a dedicated `description` tag, NEVER in
 * `content` (#280): `content` is real `git format-patch` output that readers
 * pipe straight into `git am`, and git's patch-format detection hard-fails on
 * any leading prose (verified: "Patch format detection failed."). The tag
 * route keeps `git am` consumption intact while `rig pr show` and the
 * rig-web/views `parsePR` renderers surface the description.
 *
 * @param repoOwnerPubkey - Pubkey of the repository owner
 * @param repoId - Repository identifier
 * @param title - Patch/PR title (subject tag)
 * @param commits - Array of { sha, parentSha } for commit and parent-commit tags
 * @param branchTag - Branch name for the t tag
 * @param content - Real `git format-patch` text (NIP-34 patch body); defaults
 *                  to '' for callers that only reference commits by tag
 * @param description - PR body/cover text (`description` tag) — kept out of
 *                      `content` so `git am` still applies it
 */
export function buildPatch(
  repoOwnerPubkey: string,
  repoId: string,
  title: string,
  commits: { sha: string; parentSha: string }[],
  branchTag?: string,
  content = '',
  description?: string
): UnsignedEvent {
  const tags: string[][] = [
    ['a', `${REPOSITORY_ANNOUNCEMENT_KIND}:${repoOwnerPubkey}:${repoId}`],
    ['p', repoOwnerPubkey],
    ['subject', title],
  ];

  if (description !== undefined && description !== '') {
    tags.push(['description', description]);
  }

  for (const commit of commits) {
    tags.push(['commit', commit.sha]);
    tags.push(['parent-commit', commit.parentSha]);
  }

  if (branchTag) {
    tags.push(['t', branchTag]);
  }

  return {
    kind: PATCH_KIND,
    content,
    tags,
    created_at: Math.floor(Date.now() / 1000),
  };
}

// ---------------------------------------------------------------------------
// kind:1630-1633 — Status
// ---------------------------------------------------------------------------

/** Status kinds: 1630 open, 1631 applied/merged, 1632 closed, 1633 draft. */
export type StatusKind =
  | typeof STATUS_OPEN_KIND
  | typeof STATUS_APPLIED_KIND
  | typeof STATUS_CLOSED_KIND
  | typeof STATUS_DRAFT_KIND;

/**
 * Build a status event (kind 1630-1633).
 *
 * @param targetEventId - Event ID of the patch, PR, or issue being updated
 * @param statusKind - One of 1630 (open), 1631 (applied), 1632 (closed), 1633 (draft)
 * @param targetPubkey - Optional pubkey of the target event author (p tag per NIP-34 StatusEvent)
 */
export function buildStatus(
  targetEventId: string,
  statusKind: StatusKind,
  targetPubkey?: string
): UnsignedEvent {
  const tags: string[][] = [['e', targetEventId]];
  if (targetPubkey) {
    tags.push(['p', targetPubkey]);
  }
  return {
    kind: statusKind,
    content: '',
    tags,
    created_at: Math.floor(Date.now() / 1000),
  };
}
