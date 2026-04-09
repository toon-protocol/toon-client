/**
 * Seed Script: Push 02 — Nested Directory Structure
 *
 * Adds deeply nested directory structures to the E2E test repository:
 * - 4 new blobs (core.ts, format.ts, deep-file.ts, guide.md)
 * - 6 new trees (helpers/, utils/, lib/, src/, docs/, root)
 * - 1 new commit (parent = Push 1 commit)
 *
 * Delta upload: only new/changed git objects are uploaded.
 * Reused blobs from Push 1 (README.md, package.json, index.ts) are skipped.
 *
 * Story 10.3
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
} from './lib/index.js';
import { REPO_ID, README_CONTENT, PACKAGE_JSON_CONTENT, INDEX_TS_CONTENT, type Push01State } from './push-01-init.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CORE_TS_CONTENT = `export class Core {
  init(): void { /* core initialization */ }
}
`;

export const FORMAT_TS_CONTENT = `export function formatOutput(data: string): string {
  return data.trim();
}
`;

export const DEEP_FILE_TS_CONTENT = `export const DEEP_CONSTANT = 'found-at-depth-4';
`;

export const GUIDE_MD_CONTENT = `# Guide

Getting started with rig-e2e-test-repo.
`;

// ---------------------------------------------------------------------------
// Push02State
// ---------------------------------------------------------------------------

export interface Push02State {
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
 * Run Push 02: add nested directory structure, upload delta objects, update refs.
 *
 * @param aliceClient - Bootstrapped ToonClient for Alice
 * @param aliceSecretKey - Alice's Nostr secret key (Uint8Array, 32 bytes)
 * @param push01State - State returned from runPush01
 * @returns Push02State with appended commits, expanded shaMap, updated files
 */
export async function runPush02(
  aliceClient: ToonClient,
  aliceSecretKey: Uint8Array,
  push01State: Push01State
): Promise<Push02State> {
  // -------------------------------------------------------------------------
  // Task 1/2: Create git objects with nested tree structure (AC-3.1, AC-3.3)
  // -------------------------------------------------------------------------

  // Reuse Push 1 blob SHAs (needed for tree construction, not re-uploaded)
  const readmeBlob = createGitBlob(README_CONTENT);
  const pkgBlob = createGitBlob(PACKAGE_JSON_CONTENT);
  const indexBlob = createGitBlob(INDEX_TS_CONTENT);

  // New blobs
  const coreBlob = createGitBlob(CORE_TS_CONTENT);
  const formatBlob = createGitBlob(FORMAT_TS_CONTENT);
  const deepFileBlob = createGitBlob(DEEP_FILE_TS_CONTENT);
  const guideBlob = createGitBlob(GUIDE_MD_CONTENT);

  // Build nested trees leaf-to-root
  const helpersTree = createGitTree([
    { mode: '100644', name: 'deep-file.ts', sha: deepFileBlob.sha },
  ]);
  const utilsTree = createGitTree([
    { mode: '100644', name: 'format.ts', sha: formatBlob.sha },
    { mode: '040000', name: 'helpers', sha: helpersTree.sha },
  ]);
  const libTree = createGitTree([
    { mode: '100644', name: 'core.ts', sha: coreBlob.sha },
    { mode: '040000', name: 'utils', sha: utilsTree.sha },
  ]);
  const srcTree = createGitTree([
    { mode: '100644', name: 'index.ts', sha: indexBlob.sha },
    { mode: '040000', name: 'lib', sha: libTree.sha },
  ]);
  const docsTree = createGitTree([
    { mode: '100644', name: 'guide.md', sha: guideBlob.sha },
  ]);
  const rootTree = createGitTree([
    { mode: '100644', name: 'README.md', sha: readmeBlob.sha },
    { mode: '100644', name: 'package.json', sha: pkgBlob.sha },
    { mode: '040000', name: 'docs', sha: docsTree.sha },
    { mode: '040000', name: 'src', sha: srcTree.sha },
  ]);

  // Commit with parent = Push 1 commit
  const commit = createGitCommit({
    treeSha: rootTree.sha,
    parentSha: push01State.commits[0]!.sha,
    authorName: 'Alice',
    authorPubkey: AGENT_IDENTITIES.alice.pubkey,
    message: 'Add nested directory structure',
    timestamp: 1700001000,
  });

  // -------------------------------------------------------------------------
  // Task 3: Upload only delta objects to Arweave (AC-3.2)
  // -------------------------------------------------------------------------

  const channelId = aliceClient.getTrackedChannels()[0];
  if (!channelId) {
    throw new Error('No payment channel available. Alice client may not be bootstrapped.');
  }

  const shaMap = push01State.shaMap;

  // Upload order: new blobs first, then new trees (leaf-to-root), then commit.
  // Reused blobs from Push 1 (README.md, package.json, index.ts) are NOT
  // included — their SHAs are already in shaMap from Push 1.
  // Only the 11 new objects (4 blobs + 6 trees + 1 commit) are uploaded.
  const uploadOrder: { obj: ReturnType<typeof createGitBlob>; type: 'blob' | 'tree' | 'commit' }[] = [
    // New blobs
    { obj: coreBlob, type: 'blob' },
    { obj: formatBlob, type: 'blob' },
    { obj: deepFileBlob, type: 'blob' },
    { obj: guideBlob, type: 'blob' },
    // New trees (leaf-to-root)
    { obj: helpersTree, type: 'tree' },
    { obj: utilsTree, type: 'tree' },
    { obj: libTree, type: 'tree' },
    { obj: srcTree, type: 'tree' },
    { obj: docsTree, type: 'tree' },
    { obj: rootTree, type: 'tree' },
    // New commit
    { obj: commit, type: 'commit' },
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
  // Task 4: Publish updated kind:30618 refs (AC-3.4)
  // -------------------------------------------------------------------------

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
  // Task 5: Return updated state (AC-3.5)
  // -------------------------------------------------------------------------

  const commitTxId = shaMap[commit.sha];
  if (!commitTxId) {
    throw new Error(`Commit SHA ${commit.sha} missing from shaMap after upload`);
  }

  return {
    repoId: REPO_ID,
    ownerPubkey: AGENT_IDENTITIES.alice.pubkey,
    commits: [
      ...push01State.commits,
      {
        sha: commit.sha,
        txId: commitTxId,
        message: 'Add nested directory structure',
      },
    ],
    shaMap,
    repoAnnouncementId: push01State.repoAnnouncementId,
    refsEventId: refsResult.eventId ?? refsSigned.id,
    branches: ['main'],
    files: [
      'README.md',
      'package.json',
      'src/index.ts',
      'src/lib/core.ts',
      'src/lib/utils/format.ts',
      'src/lib/utils/helpers/deep-file.ts',
      'docs/guide.md',
    ],
  };
}
