/**
 * Seed Script: Push 01 — Initial Repo Push
 *
 * Creates the first git push for a test repository:
 * - 3 blobs (README.md, package.json, src/index.ts)
 * - 2 trees (src/ subtree, root tree)
 * - 1 commit (initial, no parent)
 * - kind:30617 repo announcement
 * - kind:30618 refs/state
 *
 * All objects uploaded to Arweave via kind:5094 DVM through Peer1.
 *
 * Story 10.2
 */

import { finalizeEvent } from 'nostr-tools/pure';
import type { ToonClient } from '@toon-protocol/client';
import {
  createGitBlob,
  createGitTree,
  createGitCommit,
  uploadGitObject,
  buildRepoAnnouncement,
  buildRepoRefs,
  publishWithRetry,
  AGENT_IDENTITIES,
  type ShaToTxIdMap,
} from './lib/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const REPO_ID = 'rig-e2e-test-repo';

export const README_CONTENT = `# rig-e2e-test-repo

A test repository for Rig E2E integration tests.
Seeded by the TOON Protocol test infrastructure.
`;

export const PACKAGE_JSON_CONTENT = `{
  "name": "rig-e2e-test-repo",
  "version": "1.0.0",
  "description": "Test repository for Rig E2E",
  "main": "src/index.ts"
}
`;

export const INDEX_TS_CONTENT = `export function hello(): string {
  return 'Hello from rig-e2e-test-repo';
}
`;

// ---------------------------------------------------------------------------
// Push01State
// ---------------------------------------------------------------------------

export interface Push01State {
  repoId: string;
  ownerPubkey: string;
  commits: { sha: string; txId: string; message: string }[];
  shaMap: ShaToTxIdMap;
  repoAnnouncementId: string;
  refsEventId: string;
  branches: string[];
  files: string[];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Run Push 01: create initial git objects, upload to Arweave, publish Nostr events.
 *
 * @param aliceClient - Bootstrapped ToonClient for Alice
 * @param aliceSecretKey - Alice's Nostr secret key (Uint8Array, 32 bytes)
 * @param shaMap - Accumulated SHA-to-txId map (empty for Push 1, mutated in-place)
 * @returns Push01State with all created state for the orchestrator
 */
export async function runPush01(
  aliceClient: ToonClient,
  aliceSecretKey: Uint8Array,
  shaMap: ShaToTxIdMap
): Promise<Push01State> {
  // -------------------------------------------------------------------------
  // Task 2: Create git objects (AC-2.1)
  // -------------------------------------------------------------------------

  const readmeBlob = createGitBlob(README_CONTENT);
  const pkgBlob = createGitBlob(PACKAGE_JSON_CONTENT);
  const indexBlob = createGitBlob(INDEX_TS_CONTENT);

  const srcTree = createGitTree([
    { mode: '100644', name: 'index.ts', sha: indexBlob.sha },
  ]);

  const rootTree = createGitTree([
    { mode: '100644', name: 'README.md', sha: readmeBlob.sha },
    { mode: '100644', name: 'package.json', sha: pkgBlob.sha },
    { mode: '040000', name: 'src', sha: srcTree.sha },
  ]);

  const commit = createGitCommit({
    treeSha: rootTree.sha,
    authorName: 'Alice',
    authorPubkey: AGENT_IDENTITIES.alice.pubkey,
    message: 'Initial commit',
    timestamp: 1700000000,
  });

  // -------------------------------------------------------------------------
  // Task 3: Upload git objects to Arweave (AC-2.2)
  // -------------------------------------------------------------------------

  const channelId = aliceClient.getTrackedChannels()[0];
  if (!channelId) {
    throw new Error('No payment channel available. Alice client may not be bootstrapped.');
  }

  // Upload order: blobs first, then trees (leaf-to-root), then commit
  const uploadOrder: { obj: ReturnType<typeof createGitBlob>; type: 'blob' | 'tree' | 'commit' }[] = [
    { obj: readmeBlob, type: 'blob' },
    { obj: pkgBlob, type: 'blob' },
    { obj: indexBlob, type: 'blob' },
    { obj: srcTree, type: 'tree' },
    { obj: rootTree, type: 'tree' },
    { obj: commit, type: 'commit' },
  ];

  for (const { obj, type } of uploadOrder) {
    // Sign claim with per-object delta amount (Task 3.2)
    // ChannelManager.signBalanceProof() takes additionalAmount (delta) and
    // auto-accumulates the cumulative total internally, so we pass the
    // per-object cost, NOT a running cumulative.
    const perObjectAmount = BigInt(obj.body.length) * 10n;
    const claim = await aliceClient.signBalanceProof(channelId, perObjectAmount);

    const result = await uploadGitObject(
      aliceClient,
      obj.body,
      obj.sha,
      type,
      REPO_ID,
      shaMap,
      claim,
      aliceSecretKey
    );

    // R10-003: Fail immediately if any upload returns undefined txId
    if (!result.txId) {
      throw new Error(
        `Upload failed for ${type} object ${obj.sha}: txId is undefined`
      );
    }
  }

  // -------------------------------------------------------------------------
  // Task 4: Publish Nostr events (AC-2.3, AC-2.4, AC-2.6)
  // -------------------------------------------------------------------------

  // AC-2.3: kind:30617 repo announcement
  const repoAnnouncementUnsigned = buildRepoAnnouncement(
    REPO_ID,
    'Rig E2E Test Repo',
    'A test repository for Rig E2E integration tests'
  );
  const repoAnnouncementSigned = finalizeEvent(repoAnnouncementUnsigned, aliceSecretKey);
  const repoAnnouncementResult = await publishWithRetry(aliceClient, repoAnnouncementSigned);

  if (!repoAnnouncementResult.success) {
    throw new Error(
      `Failed to publish kind:30617 repo announcement: ${repoAnnouncementResult.error}`
    );
  }

  // AC-2.4: kind:30618 refs/state
  const refsUnsigned = buildRepoRefs(
    REPO_ID,
    { 'refs/heads/main': commit.sha },
    shaMap
  );
  const refsSigned = finalizeEvent(refsUnsigned, aliceSecretKey);
  const refsResult = await publishWithRetry(aliceClient, refsSigned);

  if (!refsResult.success) {
    throw new Error(
      `Failed to publish kind:30618 refs: ${refsResult.error}`
    );
  }

  // -------------------------------------------------------------------------
  // Task 5: Return state (AC-2.5)
  // -------------------------------------------------------------------------

  const commitTxId = shaMap[commit.sha];
  if (!commitTxId) {
    throw new Error(`Commit SHA ${commit.sha} missing from shaMap after upload`);
  }

  return {
    repoId: REPO_ID,
    ownerPubkey: AGENT_IDENTITIES.alice.pubkey,
    commits: [
      {
        sha: commit.sha,
        txId: commitTxId,
        message: 'Initial commit',
      },
    ],
    shaMap,
    repoAnnouncementId: repoAnnouncementResult.eventId ?? repoAnnouncementSigned.id,
    refsEventId: refsResult.eventId ?? refsSigned.id,
    branches: ['main'],
    files: ['README.md', 'package.json', 'src/index.ts'],
  };
}
