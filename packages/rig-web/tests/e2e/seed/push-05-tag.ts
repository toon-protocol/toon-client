/**
 * Seed Script: Push 05 — Tag (Lightweight Tag on Main HEAD)
 *
 * Adds `refs/tags/v1.0.0` pointing to main's HEAD commit (Push 2).
 * No new git objects — only publishes a new kind:30618 refs event
 * with the tag added alongside existing branch refs.
 *
 * Story 10.5
 */

import { finalizeEvent } from 'nostr-tools/pure';
import type { ToonClient } from '@toon-protocol/client';
import {
  buildRepoRefs,
  publishWithRetry,
  type ShaToTxIdMap,
} from './lib/index.js';
import { REPO_ID } from './push-01-init.js';
import { type Push04State } from './push-04-branch-work.js';

// ---------------------------------------------------------------------------
// Push05State
// ---------------------------------------------------------------------------

export interface Push05State {
  repoId: string;
  ownerPubkey: string;
  commits: { sha: string; txId: string; message: string }[];
  shaMap: ShaToTxIdMap;
  repoAnnouncementId: string;
  refsEventId: string;
  branches: string[];
  tags: string[];
  files: string[];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Run Push 05: add v1.0.0 tag pointing to main HEAD, publish updated refs.
 *
 * @param aliceClient - Bootstrapped ToonClient for Alice
 * @param aliceSecretKey - Alice's Nostr secret key (Uint8Array, 32 bytes)
 * @param push04State - State returned from runPush04
 * @returns Push05State with tag added, refs updated, all other fields unchanged
 */
export async function runPush05(
  aliceClient: ToonClient,
  aliceSecretKey: Uint8Array,
  push04State: Push04State
): Promise<Push05State> {
  // -------------------------------------------------------------------------
  // Task 1.3–1.5: Build and publish kind:30618 refs with tag (AC-5.1, 5.2)
  // -------------------------------------------------------------------------

  const refsUnsigned = buildRepoRefs(
    REPO_ID,
    {
      // IMPORTANT: main MUST be first key so HEAD points to main
      'refs/heads/main': push04State.commits[1]!.sha,              // Push 2 commit
      'refs/heads/feature/add-retry': push04State.commits[3]!.sha, // Push 4 commit
      'refs/tags/v1.0.0': push04State.commits[1]!.sha,             // Tag -> same as main HEAD
    },
    push04State.shaMap
  );
  const refsSigned = finalizeEvent(refsUnsigned, aliceSecretKey);
  const refsResult = await publishWithRetry(aliceClient, refsSigned);

  if (!refsResult.success) {
    throw new Error(
      `Failed to publish kind:30618 refs: ${refsResult.error}`
    );
  }

  // -------------------------------------------------------------------------
  // Task 1.6–1.7: Return Push05State (AC-5.4)
  // -------------------------------------------------------------------------

  const refsEventId = refsResult.eventId ?? refsSigned.id;

  return {
    repoId: push04State.repoId,
    ownerPubkey: push04State.ownerPubkey,
    commits: push04State.commits,
    shaMap: push04State.shaMap,
    repoAnnouncementId: push04State.repoAnnouncementId,
    refsEventId,
    branches: push04State.branches,
    tags: ['v1.0.0'],
    files: push04State.files,
  };
}
