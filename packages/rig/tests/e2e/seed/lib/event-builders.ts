/**
 * NIP-34 event builders for E2E seed scripts.
 *
 * All builders return UnsignedEvent — the caller signs with their keypair
 * via finalizeEvent(). Tag structures follow NIP-34 spec and
 * packages/core/src/nip34/types.ts.
 *
 * AC-1.6: Event Builders
 */

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
// kind:30617 — Repository Announcement
// ---------------------------------------------------------------------------

/**
 * Build a kind:30617 repository announcement event.
 *
 * @param repoId - Repository identifier (d tag)
 * @param name - Human-readable repository name
 * @param description - Repository description
 */
export function buildRepoAnnouncement(
  repoId: string,
  name: string,
  description: string
): UnsignedEvent {
  return {
    kind: 30617,
    content: '',
    tags: [
      ['d', repoId],
      ['name', name],
      ['description', description],
    ],
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
    kind: 30618,
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
    ['a', `30617:${repoOwnerPubkey}:${repoId}`],
    ['p', repoOwnerPubkey],
    ['subject', title],
    ...labels.map((label) => ['t', label]),
  ];

  return {
    kind: 1621,
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
    kind: 1622,
    content: body,
    tags: [
      ['a', `30617:${repoOwnerPubkey}:${repoId}`],
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
 * @param repoOwnerPubkey - Pubkey of the repository owner
 * @param repoId - Repository identifier
 * @param title - Patch/PR title (subject tag)
 * @param commits - Array of { sha, parentSha } for commit and parent-commit tags
 * @param branchTag - Branch name for the t tag
 */
export function buildPatch(
  repoOwnerPubkey: string,
  repoId: string,
  title: string,
  commits: { sha: string; parentSha: string }[],
  branchTag?: string
): UnsignedEvent {
  const tags: string[][] = [
    ['a', `30617:${repoOwnerPubkey}:${repoId}`],
    ['p', repoOwnerPubkey],
    ['subject', title],
  ];

  for (const commit of commits) {
    tags.push(['commit', commit.sha]);
    tags.push(['parent-commit', commit.parentSha]);
  }

  if (branchTag) {
    tags.push(['t', branchTag]);
  }

  return {
    kind: 1617,
    content: '',
    tags,
    created_at: Math.floor(Date.now() / 1000),
  };
}

// ---------------------------------------------------------------------------
// kind:1630-1633 — Status
// ---------------------------------------------------------------------------

/**
 * Build a status event (kind 1630-1633).
 *
 * @param targetEventId - Event ID of the patch, PR, or issue being updated
 * @param statusKind - One of 1630 (open), 1631 (applied), 1632 (closed), 1633 (draft)
 * @param targetPubkey - Optional pubkey of the target event author (p tag per NIP-34 StatusEvent)
 */
export function buildStatus(
  targetEventId: string,
  statusKind: 1630 | 1631 | 1632 | 1633,
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
