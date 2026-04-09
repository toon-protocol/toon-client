/**
 * Seed Script: Push 08 — Merge PR & Close Issue
 *
 * Publishes a kind:1632 (Closed) status event for Issue #2.
 * Verifies PR #1 already has kind:1631 from Push 06 (assertion only).
 *
 * No new git objects — only publishes 1 kind:1632 close status event.
 *
 * Story 10.8
 */

import { finalizeEvent } from 'nostr-tools/pure';
import type { ToonClient } from '@toon-protocol/client';
import {
  buildStatus,
  publishWithRetry,
  type ShaToTxIdMap,
} from './lib/index.js';
import { type Push07State } from './push-07-issues.js';

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Run Push 08: verify PR #1 merged status and close Issue #2.
 *
 * @param aliceClient - Bootstrapped ToonClient for Alice
 * @param aliceSecretKey - Alice's Nostr secret key (Uint8Array, 32 bytes)
 * @param push07State - State returned from runPush07
 * @returns Push08State with closedIssueEventIds added, all other fields unchanged
 */
export async function runPush08(
  aliceClient: ToonClient,
  aliceSecretKey: Uint8Array,
  push07State: Push07State
): Promise<Push08State> {
  // -------------------------------------------------------------------------
  // Task 1.3: Assert PR #1 already has kind:1631 (AC-8.2)
  // -------------------------------------------------------------------------

  const pr1 = push07State.prs[0];
  if (!pr1) {
    throw new Error(
      `Expected PR #1 at push07State.prs[0], but prs array has only ${push07State.prs.length} entries`
    );
  }
  if (pr1.statusKind !== 1631) {
    throw new Error(
      `Expected PR #1 to already have kind:1631 (Applied/Merged), got ${pr1.statusKind}`
    );
  }

  // -------------------------------------------------------------------------
  // Task 1.4: Build kind:1632 (Closed) status for Issue #2 (AC-8.1)
  // -------------------------------------------------------------------------

  const issue2 = push07State.issues[1];
  if (!issue2) {
    throw new Error(
      `Expected Issue #2 at push07State.issues[1], but issues array has only ${push07State.issues.length} entries`
    );
  }

  const closeUnsigned = buildStatus(
    issue2.eventId,
    1632,
    issue2.authorPubkey
  );
  const closeSigned = finalizeEvent(closeUnsigned, aliceSecretKey);

  // -------------------------------------------------------------------------
  // Task 1.5: Publish kind:1632 event (AC-8.1)
  // -------------------------------------------------------------------------

  const closeResult = await publishWithRetry(aliceClient, closeSigned);
  if (!closeResult.success) {
    throw new Error(`Failed to publish close status for Issue #2 (kind:1632): ${closeResult.error}`);
  }

  // -------------------------------------------------------------------------
  // Task 1.6: Derive event ID (fallback pattern)
  // -------------------------------------------------------------------------

  const closeEventId = closeResult.eventId ?? closeSigned.id;

  // -------------------------------------------------------------------------
  // Task 1.7: Return Push08State (AC-8.1, AC-8.4)
  // -------------------------------------------------------------------------

  return {
    repoId: push07State.repoId,
    ownerPubkey: push07State.ownerPubkey,
    commits: push07State.commits,
    shaMap: push07State.shaMap,
    repoAnnouncementId: push07State.repoAnnouncementId,
    refsEventId: push07State.refsEventId,
    branches: push07State.branches,
    tags: push07State.tags,
    files: push07State.files,
    prs: push07State.prs,
    issues: push07State.issues,
    comments: push07State.comments,
    closedIssueEventIds: [closeEventId],
  };
}

// ---------------------------------------------------------------------------
// Push08State
// ---------------------------------------------------------------------------

export interface Push08State {
  repoId: string;
  ownerPubkey: string;
  commits: { sha: string; txId: string; message: string }[];
  shaMap: ShaToTxIdMap;
  repoAnnouncementId: string;
  refsEventId: string;
  branches: string[];
  tags: string[];
  files: string[];
  prs: {
    eventId: string;
    title: string;
    authorPubkey: string;
    statusKind: 1630 | 1631 | 1632 | 1633;
  }[];
  issues: {
    eventId: string;
    title: string;
    authorPubkey: string;
    labels: string[];
  }[];
  comments: {
    eventId: string;
    issueEventId: string;
    authorPubkey: string;
    body: string;
  }[];
  closedIssueEventIds: string[];
}
