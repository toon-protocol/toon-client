/**
 * Seed Script: Push 06 — PRs with Status
 *
 * Publishes 2 kind:1617 PR events (patches) with status events:
 * - PR #1: "feat: add retry logic" by Alice (kind:1631 Applied/Merged)
 * - PR #2: "fix: update docs" by Charlie (kind:1630 Open)
 *
 * No new git objects — only publishes kind:1617 patch events and
 * kind:1630/1631 status events.
 *
 * Story 10.6
 */

import { finalizeEvent } from 'nostr-tools/pure';
import type { ToonClient } from '@toon-protocol/client';
import {
  buildPatch,
  buildStatus,
  publishWithRetry,
  type ShaToTxIdMap,
} from './lib/index.js';
import { REPO_ID } from './push-01-init.js';
import { type Push05State } from './push-05-tag.js';

// ---------------------------------------------------------------------------
// Push06State
// ---------------------------------------------------------------------------

export interface Push06State {
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
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Run Push 06: publish 2 PRs with status events.
 *
 * @param aliceClient - Bootstrapped ToonClient for Alice
 * @param charlieClient - Bootstrapped ToonClient for Charlie
 * @param aliceSecretKey - Alice's Nostr secret key (Uint8Array, 32 bytes)
 * @param charlieSecretKey - Charlie's Nostr secret key (Uint8Array, 32 bytes)
 * @param push05State - State returned from runPush05
 * @returns Push06State with prs added, all other fields unchanged
 */
export async function runPush06(
  aliceClient: ToonClient,
  charlieClient: ToonClient,
  aliceSecretKey: Uint8Array,
  charlieSecretKey: Uint8Array,
  push05State: Push05State
): Promise<Push06State> {
  // -------------------------------------------------------------------------
  // Task 1.3: Build PR #1 — Alice's feature branch PR (AC-6.1)
  // -------------------------------------------------------------------------

  const pr1Unsigned = buildPatch(
    push05State.ownerPubkey,
    REPO_ID,
    'feat: add retry logic',
    [
      { sha: push05State.commits[2]!.sha, parentSha: push05State.commits[1]!.sha },
      { sha: push05State.commits[3]!.sha, parentSha: push05State.commits[2]!.sha },
    ],
    'feature/add-retry'
  );
  const pr1Signed = finalizeEvent(pr1Unsigned, aliceSecretKey);

  // -------------------------------------------------------------------------
  // Task 1.4: Build PR #2 — Charlie's docs PR (AC-6.1)
  // -------------------------------------------------------------------------

  const placeholderCommitSha = 'c'.repeat(40);
  const pr2Unsigned = buildPatch(
    push05State.ownerPubkey,
    REPO_ID,
    'fix: update docs',
    [
      { sha: placeholderCommitSha, parentSha: push05State.commits[1]!.sha },
    ]
  );
  const pr2Signed = finalizeEvent(pr2Unsigned, charlieSecretKey);

  // -------------------------------------------------------------------------
  // Task 1.5: Publish both PRs (AC-6.4)
  // -------------------------------------------------------------------------

  const pr1Result = await publishWithRetry(aliceClient, pr1Signed);
  if (!pr1Result.success) {
    throw new Error(`Failed to publish PR #1 (kind:1617): ${pr1Result.error}`);
  }

  const pr2Result = await publishWithRetry(charlieClient, pr2Signed);
  if (!pr2Result.success) {
    throw new Error(`Failed to publish PR #2 (kind:1617): ${pr2Result.error}`);
  }

  // -------------------------------------------------------------------------
  // Task 1.8: Derive event IDs (fallback pattern)
  // -------------------------------------------------------------------------

  const pr1EventId = pr1Result.eventId ?? pr1Signed.id;
  const pr2EventId = pr2Result.eventId ?? pr2Signed.id;

  // -------------------------------------------------------------------------
  // Task 1.6: Build and publish kind:1631 status for PR #1 (AC-6.3)
  // -------------------------------------------------------------------------

  const status1Unsigned = buildStatus(pr1EventId, 1631, pr1Signed.pubkey);
  const status1Signed = finalizeEvent(status1Unsigned, aliceSecretKey);
  const status1Result = await publishWithRetry(aliceClient, status1Signed);

  if (!status1Result.success) {
    throw new Error(`Failed to publish status for PR #1 (kind:1631): ${status1Result.error}`);
  }

  // -------------------------------------------------------------------------
  // Task 1.7: Build and publish kind:1630 status for PR #2 (AC-6.2)
  // -------------------------------------------------------------------------

  const status2Unsigned = buildStatus(pr2EventId, 1630, pr2Signed.pubkey);
  const status2Signed = finalizeEvent(status2Unsigned, charlieSecretKey);
  const status2Result = await publishWithRetry(charlieClient, status2Signed);

  if (!status2Result.success) {
    throw new Error(`Failed to publish status for PR #2 (kind:1630): ${status2Result.error}`);
  }

  // -------------------------------------------------------------------------
  // Task 1.9: Return Push06State (AC-6.1)
  // -------------------------------------------------------------------------

  return {
    repoId: push05State.repoId,
    ownerPubkey: push05State.ownerPubkey,
    commits: push05State.commits,
    shaMap: push05State.shaMap,
    repoAnnouncementId: push05State.repoAnnouncementId,
    refsEventId: push05State.refsEventId,
    branches: push05State.branches,
    tags: push05State.tags,
    files: push05State.files,
    prs: [
      {
        eventId: pr1EventId,
        title: 'feat: add retry logic',
        authorPubkey: pr1Signed.pubkey,
        statusKind: 1631,
      },
      {
        eventId: pr2EventId,
        title: 'fix: update docs',
        authorPubkey: pr2Signed.pubkey,
        statusKind: 1630,
      },
    ],
  };
}
