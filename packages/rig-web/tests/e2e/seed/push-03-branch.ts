/**
 * Seed Script: Push 03 — Feature Branch Creation
 *
 * Creates a feature branch `feature/add-retry` from Push 2's commit:
 * - 1 new blob (retry.ts)
 * - 3 new trees (lib/, src/, root — all changed because retry.ts added)
 * - 1 new commit (parent = Push 2 commit)
 * - kind:30618 refs with BOTH main and feature/add-retry branches
 *
 * Delta upload: only 5 new objects (1 blob + 3 trees + 1 commit).
 * All Push 1/2 blobs and unchanged subtrees (docs/, utils/, helpers/) reused.
 *
 * Story 10.4
 */

import { finalizeEvent } from 'nostr-tools/pure';
import type { ToonClient } from '@toon-protocol/client';
import {
  createGitBlob,
  createGitTree,
  createGitCommit,
  uploadGitObject,
  buildRepoRefs,
  publishWithRetry,
  AGENT_IDENTITIES,
  type ShaToTxIdMap,
  type GitObject,
} from './lib/index.js';
import { REPO_ID, README_CONTENT, PACKAGE_JSON_CONTENT, INDEX_TS_CONTENT } from './push-01-init.js';
import { CORE_TS_CONTENT, FORMAT_TS_CONTENT, DEEP_FILE_TS_CONTENT, GUIDE_MD_CONTENT, type Push02State } from './push-02-nested.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const RETRY_TS_CONTENT = `export async function retry<T>(
  fn: () => Promise<T>,
  attempts = 3
): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (e) { if (i === attempts - 1) throw e; }
  }
  throw new Error('unreachable');
}
`;

// ---------------------------------------------------------------------------
// Push03State
// ---------------------------------------------------------------------------

export interface Push03State {
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
 * Run Push 03: create feature branch with retry.ts, upload delta objects, update refs.
 *
 * @param aliceClient - Bootstrapped ToonClient for Alice
 * @param aliceSecretKey - Alice's Nostr secret key (Uint8Array, 32 bytes)
 * @param push02State - State returned from runPush02
 * @returns Push03State with appended commits, expanded shaMap, updated branches
 */
export async function runPush03(
  aliceClient: ToonClient,
  aliceSecretKey: Uint8Array,
  push02State: Push02State
): Promise<Push03State> {
  // -------------------------------------------------------------------------
  // Task 1: Create git objects — feature branch adds retry.ts (AC-4.1)
  // -------------------------------------------------------------------------

  // Recreate Push 1 blobs to get their SHAs (needed for tree construction)
  const readmeBlob = createGitBlob(README_CONTENT);
  const pkgBlob = createGitBlob(PACKAGE_JSON_CONTENT);
  const indexBlob = createGitBlob(INDEX_TS_CONTENT);

  // Recreate Push 2 blobs to get their SHAs
  const coreBlob = createGitBlob(CORE_TS_CONTENT);
  const formatBlob = createGitBlob(FORMAT_TS_CONTENT);
  const deepFileBlob = createGitBlob(DEEP_FILE_TS_CONTENT);
  const guideBlob = createGitBlob(GUIDE_MD_CONTENT);

  // New blob for Push 3
  const retryBlob = createGitBlob(RETRY_TS_CONTENT);

  // Rebuild unchanged subtrees (same SHAs as Push 2 — delta logic will skip)
  const helpersTree = createGitTree([
    { mode: '100644', name: 'deep-file.ts', sha: deepFileBlob.sha },
  ]);
  const utilsTree = createGitTree([
    { mode: '100644', name: 'format.ts', sha: formatBlob.sha },
    { mode: '040000', name: 'helpers', sha: helpersTree.sha },
  ]);
  const docsTree = createGitTree([
    { mode: '100644', name: 'guide.md', sha: guideBlob.sha },
  ]);

  // NEW lib/ tree — adds retry.ts alongside core.ts and utils/
  const libTree = createGitTree([
    { mode: '100644', name: 'core.ts', sha: coreBlob.sha },
    { mode: '100644', name: 'retry.ts', sha: retryBlob.sha },
    { mode: '040000', name: 'utils', sha: utilsTree.sha },
  ]);

  // NEW src/ tree — lib/ subtree changed
  const srcTree = createGitTree([
    { mode: '100644', name: 'index.ts', sha: indexBlob.sha },
    { mode: '040000', name: 'lib', sha: libTree.sha },
  ]);

  // NEW root tree — src/ subtree changed
  const rootTree = createGitTree([
    { mode: '100644', name: 'README.md', sha: readmeBlob.sha },
    { mode: '100644', name: 'package.json', sha: pkgBlob.sha },
    { mode: '040000', name: 'docs', sha: docsTree.sha },
    { mode: '040000', name: 'src', sha: srcTree.sha },
  ]);

  // Commit on feature branch — parent = Push 2 commit (index 1)
  const commit03 = createGitCommit({
    treeSha: rootTree.sha,
    parentSha: push02State.commits[1]!.sha,
    authorName: 'Alice',
    authorPubkey: AGENT_IDENTITIES.alice.pubkey,
    message: 'Add retry utility',
    timestamp: 1700002000,
  });

  // -------------------------------------------------------------------------
  // Task 1.5: Upload only delta objects to Arweave (AC-4.1)
  // -------------------------------------------------------------------------

  const channelId = aliceClient.getTrackedChannels()[0];
  if (!channelId) {
    throw new Error('No payment channel available. Alice client may not be bootstrapped.');
  }

  const shaMap = push02State.shaMap;

  // Upload order: new blob, then new trees (leaf-to-root), then commit.
  // Only 5 new objects: 1 blob + 3 trees (lib/, src/, root) + 1 commit.
  // helpers/, utils/, docs/ trees have same SHAs as Push 2 — already in shaMap.
  const uploadOrder: { obj: GitObject; type: 'blob' | 'tree' | 'commit' }[] = [
    { obj: retryBlob, type: 'blob' },
    { obj: libTree, type: 'tree' },
    { obj: srcTree, type: 'tree' },
    { obj: rootTree, type: 'tree' },
    { obj: commit03, type: 'commit' },
  ];

  for (const { obj, type } of uploadOrder) {
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
  // Task 1.6: Publish kind:30618 refs with BOTH branches (AC-4.3)
  // -------------------------------------------------------------------------

  const refsUnsigned = buildRepoRefs(
    REPO_ID,
    {
      'refs/heads/main': push02State.commits[1]!.sha,
      'refs/heads/feature/add-retry': commit03.sha,
    },
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
  // Task 1.7: Return updated state (AC-4.1, AC-4.3)
  // -------------------------------------------------------------------------

  const commitTxId = shaMap[commit03.sha];
  if (!commitTxId) {
    throw new Error(`Commit SHA ${commit03.sha} missing from shaMap after upload`);
  }

  return {
    repoId: REPO_ID,
    ownerPubkey: AGENT_IDENTITIES.alice.pubkey,
    commits: [
      ...push02State.commits,
      {
        sha: commit03.sha,
        txId: commitTxId,
        message: 'Add retry utility',
      },
    ],
    shaMap,
    repoAnnouncementId: push02State.repoAnnouncementId,
    refsEventId: refsResult.eventId ?? refsSigned.id,
    branches: ['main', 'feature/add-retry'],
    files: [...new Set([...push02State.files, 'src/lib/retry.ts'])],
  };
}
