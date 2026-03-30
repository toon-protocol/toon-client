/**
 * Seed Script: Push 07 — Issues, Labels, Conversations
 *
 * Publishes 2 kind:1621 issue events with labels and multi-client
 * comment threads (kind:1622):
 * - Issue #1: WebSocket reconnection (Alice, enhancement + networking labels)
 * - Issue #2: Deep path navigation (Bob, bug + forge-ui labels)
 *
 * Comment threads:
 * - Issue #1: Bob, Alice, Charlie (3 comments)
 * - Issue #2: Alice, Bob (2 comments)
 *
 * No new git objects — only publishes kind:1621 issues and kind:1622 comments.
 *
 * Story 10.7
 */

import { finalizeEvent } from 'nostr-tools/pure';
import type { ToonClient } from '@toon-protocol/client';
import {
  buildIssue,
  buildComment,
  publishWithRetry,
  type ShaToTxIdMap,
} from './lib/index.js';
import { REPO_ID } from './push-01-init.js';
import { type Push06State } from './push-06-prs.js';

// ---------------------------------------------------------------------------
// Push07State
// ---------------------------------------------------------------------------

export interface Push07State {
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
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Run Push 07: publish 2 issues with labels and 5 comments across 3 authors.
 *
 * @param aliceClient - Bootstrapped ToonClient for Alice
 * @param bobClient - Bootstrapped ToonClient for Bob
 * @param charlieClient - Bootstrapped ToonClient for Charlie
 * @param aliceSecretKey - Alice's Nostr secret key (Uint8Array, 32 bytes)
 * @param bobSecretKey - Bob's Nostr secret key (Uint8Array, 32 bytes)
 * @param charlieSecretKey - Charlie's Nostr secret key (Uint8Array, 32 bytes)
 * @param push06State - State returned from runPush06
 * @returns Push07State with issues and comments added, all other fields unchanged
 */
export async function runPush07(
  aliceClient: ToonClient,
  bobClient: ToonClient,
  charlieClient: ToonClient,
  aliceSecretKey: Uint8Array,
  bobSecretKey: Uint8Array,
  charlieSecretKey: Uint8Array,
  push06State: Push06State
): Promise<Push07State> {
  // -------------------------------------------------------------------------
  // Task 1.3: Build Issue #1 — Alice's enhancement issue (AC-7.1)
  // -------------------------------------------------------------------------

  const issue1Unsigned = buildIssue(
    push06State.ownerPubkey,
    REPO_ID,
    'Add WebSocket reconnection logic',
    'We need automatic reconnection with backoff when the WebSocket connection drops.',
    ['enhancement', 'networking']
  );
  const issue1Signed = finalizeEvent(issue1Unsigned, aliceSecretKey);

  // -------------------------------------------------------------------------
  // Task 1.4: Build Issue #2 — Bob's bug report (AC-7.1)
  // -------------------------------------------------------------------------

  const issue2Unsigned = buildIssue(
    push06State.ownerPubkey,
    REPO_ID,
    'Fix deep path navigation bug',
    'Navigation breaks when traversing directories deeper than 3 levels.',
    ['bug', 'forge-ui']
  );
  const issue2Signed = finalizeEvent(issue2Unsigned, bobSecretKey);

  // -------------------------------------------------------------------------
  // Task 1.5: Publish both issues (AC-7.1)
  // -------------------------------------------------------------------------

  const issue1Result = await publishWithRetry(aliceClient, issue1Signed);
  if (!issue1Result.success) {
    throw new Error(`Failed to publish Issue #1 (kind:1621): ${issue1Result.error}`);
  }

  const issue2Result = await publishWithRetry(bobClient, issue2Signed);
  if (!issue2Result.success) {
    throw new Error(`Failed to publish Issue #2 (kind:1621): ${issue2Result.error}`);
  }

  // -------------------------------------------------------------------------
  // Task 1.6: Derive event IDs (fallback pattern)
  // -------------------------------------------------------------------------

  const issue1EventId = issue1Result.eventId ?? issue1Signed.id;
  const issue2EventId = issue2Result.eventId ?? issue2Signed.id;

  // -------------------------------------------------------------------------
  // Task 1.7: Build and publish 3 comments on Issue #1 (AC-7.2, AC-7.4)
  // -------------------------------------------------------------------------

  // Comment 1: Bob on Issue #1
  const c1Unsigned = buildComment(
    push06State.ownerPubkey,
    REPO_ID,
    issue1EventId,
    issue1Signed.pubkey,
    'Should we use exponential backoff?'
  );
  const c1Signed = finalizeEvent(c1Unsigned, bobSecretKey);
  const c1Result = await publishWithRetry(bobClient, c1Signed);
  if (!c1Result.success) {
    throw new Error(`Failed to publish comment 1 on Issue #1 (kind:1622): ${c1Result.error}`);
  }

  // Comment 2: Alice on Issue #1
  const c2Unsigned = buildComment(
    push06State.ownerPubkey,
    REPO_ID,
    issue1EventId,
    issue1Signed.pubkey,
    'Yes, with jitter. See RFC 6298.'
  );
  const c2Signed = finalizeEvent(c2Unsigned, aliceSecretKey);
  const c2Result = await publishWithRetry(aliceClient, c2Signed);
  if (!c2Result.success) {
    throw new Error(`Failed to publish comment 2 on Issue #1 (kind:1622): ${c2Result.error}`);
  }

  // Comment 3: Charlie on Issue #1
  const c3Unsigned = buildComment(
    push06State.ownerPubkey,
    REPO_ID,
    issue1EventId,
    issue1Signed.pubkey,
    'What about connection pooling?'
  );
  const c3Signed = finalizeEvent(c3Unsigned, charlieSecretKey);
  const c3Result = await publishWithRetry(charlieClient, c3Signed);
  if (!c3Result.success) {
    throw new Error(`Failed to publish comment 3 on Issue #1 (kind:1622): ${c3Result.error}`);
  }

  // -------------------------------------------------------------------------
  // Task 1.8: Build and publish 2 comments on Issue #2 (AC-7.3, AC-7.4)
  // -------------------------------------------------------------------------

  // Comment 4: Alice on Issue #2
  const c4Unsigned = buildComment(
    push06State.ownerPubkey,
    REPO_ID,
    issue2EventId,
    issue2Signed.pubkey,
    'Reproduced at depth 3+'
  );
  const c4Signed = finalizeEvent(c4Unsigned, aliceSecretKey);
  const c4Result = await publishWithRetry(aliceClient, c4Signed);
  if (!c4Result.success) {
    throw new Error(`Failed to publish comment 1 on Issue #2 (kind:1622): ${c4Result.error}`);
  }

  // Comment 5: Bob on Issue #2
  const c5Unsigned = buildComment(
    push06State.ownerPubkey,
    REPO_ID,
    issue2EventId,
    issue2Signed.pubkey,
    'Root cause is in tree SHA resolution'
  );
  const c5Signed = finalizeEvent(c5Unsigned, bobSecretKey);
  const c5Result = await publishWithRetry(bobClient, c5Signed);
  if (!c5Result.success) {
    throw new Error(`Failed to publish comment 2 on Issue #2 (kind:1622): ${c5Result.error}`);
  }

  // -------------------------------------------------------------------------
  // Derive comment event IDs
  // -------------------------------------------------------------------------

  const c1EventId = c1Result.eventId ?? c1Signed.id;
  const c2EventId = c2Result.eventId ?? c2Signed.id;
  const c3EventId = c3Result.eventId ?? c3Signed.id;
  const c4EventId = c4Result.eventId ?? c4Signed.id;
  const c5EventId = c5Result.eventId ?? c5Signed.id;

  // -------------------------------------------------------------------------
  // Task 1.9: Return Push07State (AC-7.1)
  // -------------------------------------------------------------------------

  return {
    repoId: push06State.repoId,
    ownerPubkey: push06State.ownerPubkey,
    commits: push06State.commits,
    shaMap: push06State.shaMap,
    repoAnnouncementId: push06State.repoAnnouncementId,
    refsEventId: push06State.refsEventId,
    branches: push06State.branches,
    tags: push06State.tags,
    files: push06State.files,
    prs: push06State.prs,
    issues: [
      {
        eventId: issue1EventId,
        title: 'Add WebSocket reconnection logic',
        authorPubkey: issue1Signed.pubkey,
        labels: ['enhancement', 'networking'],
      },
      {
        eventId: issue2EventId,
        title: 'Fix deep path navigation bug',
        authorPubkey: issue2Signed.pubkey,
        labels: ['bug', 'forge-ui'],
      },
    ],
    comments: [
      {
        eventId: c1EventId,
        issueEventId: issue1EventId,
        authorPubkey: c1Signed.pubkey,
        body: 'Should we use exponential backoff?',
      },
      {
        eventId: c2EventId,
        issueEventId: issue1EventId,
        authorPubkey: c2Signed.pubkey,
        body: 'Yes, with jitter. See RFC 6298.',
      },
      {
        eventId: c3EventId,
        issueEventId: issue1EventId,
        authorPubkey: c3Signed.pubkey,
        body: 'What about connection pooling?',
      },
      {
        eventId: c4EventId,
        issueEventId: issue2EventId,
        authorPubkey: c4Signed.pubkey,
        body: 'Reproduced at depth 3+',
      },
      {
        eventId: c5EventId,
        issueEventId: issue2EventId,
        authorPubkey: c5Signed.pubkey,
        body: 'Root cause is in tree SHA resolution',
      },
    ],
  };
}
