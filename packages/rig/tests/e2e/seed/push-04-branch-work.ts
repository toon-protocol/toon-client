/**
 * Seed Script: Push 04 — Branch Work (Second Commit on Feature Branch)
 *
 * Adds a second commit on `feature/add-retry`:
 * - 2 new blobs (modified index.ts with retry import, retry.test.ts)
 * - 3 new trees (lib/, src/, root — all changed)
 * - 1 new commit (parent = Push 3 commit)
 * - kind:30618 refs with main STILL at Push 2, feature/add-retry advanced to Push 4
 *
 * Delta upload: only 6 new objects (2 blobs + 3 trees + 1 commit).
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
import { REPO_ID, README_CONTENT, PACKAGE_JSON_CONTENT } from './push-01-init.js';
import { CORE_TS_CONTENT, FORMAT_TS_CONTENT, DEEP_FILE_TS_CONTENT, GUIDE_MD_CONTENT } from './push-02-nested.js';
import { RETRY_TS_CONTENT, type Push03State } from './push-03-branch.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MODIFIED_INDEX_TS_CONTENT = `import { retry } from './lib/retry.js';

export function hello(): string {
  return 'Hello from rig-e2e-test-repo';
}

export { retry };
`;

export const RETRY_TEST_TS_CONTENT = `import { describe, it, expect } from 'vitest';
import { retry } from './retry.js';

describe('retry', () => {
  it('should succeed on first try', async () => {
    const result = await retry(() => Promise.resolve(42));
    expect(result).toBe(42);
  });
});
`;

// ---------------------------------------------------------------------------
// Push04State
// ---------------------------------------------------------------------------

export interface Push04State {
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
 * Run Push 04: add second commit on feature branch, upload delta objects, update refs.
 *
 * @param aliceClient - Bootstrapped ToonClient for Alice
 * @param aliceSecretKey - Alice's Nostr secret key (Uint8Array, 32 bytes)
 * @param push03State - State returned from runPush03
 * @returns Push04State with appended commits, expanded shaMap
 */
export async function runPush04(
  aliceClient: ToonClient,
  aliceSecretKey: Uint8Array,
  push03State: Push03State
): Promise<Push04State> {
  // -------------------------------------------------------------------------
  // Task 2.4: Create git objects — modify index.ts, add retry.test.ts (AC-4.2)
  // -------------------------------------------------------------------------

  // Recreate Push 1 blobs to get their SHAs (needed for tree construction)
  const readmeBlob = createGitBlob(README_CONTENT);
  const pkgBlob = createGitBlob(PACKAGE_JSON_CONTENT);

  // Recreate Push 2 blobs to get their SHAs
  const coreBlob = createGitBlob(CORE_TS_CONTENT);
  const formatBlob = createGitBlob(FORMAT_TS_CONTENT);
  const deepFileBlob = createGitBlob(DEEP_FILE_TS_CONTENT);
  const guideBlob = createGitBlob(GUIDE_MD_CONTENT);

  // Recreate Push 3 blob to get its SHA
  const retryBlob = createGitBlob(RETRY_TS_CONTENT);

  // New blobs for Push 4
  const modifiedIndexBlob = createGitBlob(MODIFIED_INDEX_TS_CONTENT);
  const retryTestBlob = createGitBlob(RETRY_TEST_TS_CONTENT);

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

  // NEW lib/ tree — adds retry.test.ts alongside core.ts, retry.ts, utils/
  const libTree = createGitTree([
    { mode: '100644', name: 'core.ts', sha: coreBlob.sha },
    { mode: '100644', name: 'retry.test.ts', sha: retryTestBlob.sha },
    { mode: '100644', name: 'retry.ts', sha: retryBlob.sha },
    { mode: '040000', name: 'utils', sha: utilsTree.sha },
  ]);

  // NEW src/ tree — both index.ts changed and lib/ changed
  const srcTree = createGitTree([
    { mode: '100644', name: 'index.ts', sha: modifiedIndexBlob.sha },
    { mode: '040000', name: 'lib', sha: libTree.sha },
  ]);

  // NEW root tree — src/ subtree changed
  const rootTree = createGitTree([
    { mode: '100644', name: 'README.md', sha: readmeBlob.sha },
    { mode: '100644', name: 'package.json', sha: pkgBlob.sha },
    { mode: '040000', name: 'docs', sha: docsTree.sha },
    { mode: '040000', name: 'src', sha: srcTree.sha },
  ]);

  // Commit on feature branch — parent = Push 3 commit (index 2)
  const commit04 = createGitCommit({
    treeSha: rootTree.sha,
    parentSha: push03State.commits[2]!.sha,
    authorName: 'Alice',
    authorPubkey: AGENT_IDENTITIES.alice.pubkey,
    message: 'Add retry tests and import',
    timestamp: 1700003000,
  });

  // -------------------------------------------------------------------------
  // Task 2.5: Upload only delta objects to Arweave (AC-4.2)
  // -------------------------------------------------------------------------

  const channelId = aliceClient.getTrackedChannels()[0];
  if (!channelId) {
    throw new Error('No payment channel available. Alice client may not be bootstrapped.');
  }

  const shaMap = push03State.shaMap;

  // Upload order: new blobs, then new trees (leaf-to-root), then commit.
  // Only 6 new objects: 2 blobs + 3 trees (lib/, src/, root) + 1 commit.
  const uploadOrder: { obj: GitObject; type: 'blob' | 'tree' | 'commit' }[] = [
    { obj: modifiedIndexBlob, type: 'blob' },
    { obj: retryTestBlob, type: 'blob' },
    { obj: libTree, type: 'tree' },
    { obj: srcTree, type: 'tree' },
    { obj: rootTree, type: 'tree' },
    { obj: commit04, type: 'commit' },
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
  // Task 2.6: Publish kind:30618 refs — main unchanged, feature advanced (AC-4.4, AC-4.5)
  // -------------------------------------------------------------------------

  const refsUnsigned = buildRepoRefs(
    REPO_ID,
    {
      'refs/heads/main': push03State.commits[1]!.sha,
      'refs/heads/feature/add-retry': commit04.sha,
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
  // Task 2.7: Return updated state (AC-4.2)
  // -------------------------------------------------------------------------

  const commitTxId = shaMap[commit04.sha];
  if (!commitTxId) {
    throw new Error(`Commit SHA ${commit04.sha} missing from shaMap after upload`);
  }

  return {
    repoId: REPO_ID,
    ownerPubkey: AGENT_IDENTITIES.alice.pubkey,
    commits: [
      ...push03State.commits,
      {
        sha: commit04.sha,
        txId: commitTxId,
        message: 'Add retry tests and import',
      },
    ],
    shaMap,
    repoAnnouncementId: push03State.repoAnnouncementId,
    refsEventId: refsResult.eventId ?? refsSigned.id,
    branches: ['main', 'feature/add-retry'],
    files: [...new Set([...push03State.files, 'src/lib/retry.test.ts'])],
  };
}
