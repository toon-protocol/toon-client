/**
 * Git object construction and Arweave upload utilities for E2E seed scripts.
 *
 * The pure builders (createGitBlob/Tree/Commit, GitObject, envelope hashing,
 * MAX_OBJECT_SIZE) were promoted to `@toon-protocol/git` (#223) and are
 * re-exported here so seed scripts keep working unchanged. The upload/network
 * helpers below (uploadGitObject, waitForArweaveIndex, shaMap tracking) stay
 * in the seed lib until they're superseded by the Publisher (#226).
 *
 * AC-1.2: Git Builder
 */

import { finalizeEvent } from 'nostr-tools/pure';
import type { ToonClient, SignedBalanceProof } from '@toon-protocol/client';
import {
  MAX_OBJECT_SIZE,
  createGitBlob,
  createGitCommit,
  createGitTree,
  type GitObject,
} from '@toon-protocol/git';
import { PEER1_DESTINATION } from './constants.js';

// ---------------------------------------------------------------------------
// Promoted pure builders (re-exported from @toon-protocol/git)
// ---------------------------------------------------------------------------

export { createGitBlob, createGitCommit, createGitTree, type GitObject };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ShaToTxIdMap = Record<string, string>;

export interface UploadResult {
  sha: string;
  txId: string | undefined;
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

/**
 * Upload a git object to Arweave via kind:5094 DVM.
 *
 * - Validates size < 95KB (R10-005)
 * - Skips if SHA already in shaMap (delta upload logic)
 * - Updates shaMap in-place with new { sha -> txId } mapping
 */
export async function uploadGitObject(
  client: ToonClient,
  objectBody: Buffer,
  sha: string,
  gitType: 'blob' | 'tree' | 'commit',
  repoId: string,
  shaMap: ShaToTxIdMap,
  claim: SignedBalanceProof,
  secretKey: Uint8Array
): Promise<UploadResult> {
  // Delta logic: skip if already uploaded
  const existing = shaMap[sha];
  if (existing) {
    return { sha, txId: existing };
  }

  // Size validation (R10-005)
  if (objectBody.length > MAX_OBJECT_SIZE) {
    throw new Error(
      `Git object ${sha} exceeds 95KB limit: ${objectBody.length} bytes`
    );
  }

  const base64Data = objectBody.toString('base64');
  const bid = (BigInt(objectBody.length) * 10n).toString();

  // Construct kind:5094 event with git-specific tags
  const event = finalizeEvent(
    {
      kind: 5094,
      content: '',
      tags: [
        ['i', base64Data, 'blob'],
        ['bid', bid, 'usdc'],
        ['output', 'application/octet-stream'],
        ['Git-SHA', sha],
        ['Git-Type', gitType],
        ['Repo', repoId],
      ],
      created_at: Math.floor(Date.now() / 1000),
    },
    secretKey
  );

  const result = await client.publishEvent(event, {
    destination: PEER1_DESTINATION,
    claim,
  });

  const txId = result.data
    ? Buffer.from(result.data, 'base64').toString('utf-8')
    : undefined;

  // Update shaMap in-place
  if (txId) {
    shaMap[sha] = txId;
  }

  return { sha, txId };
}

// ---------------------------------------------------------------------------
// Arweave indexing wait helper (R10-001)
// ---------------------------------------------------------------------------

/**
 * Wait for an Arweave transaction to be indexed, with exponential backoff.
 *
 * Polls the Arweave gateway until the transaction is accessible.
 * Backoff schedule: 100ms, 200ms, 400ms, 800ms, 1600ms, ...
 *
 * @param txId - Arweave transaction ID
 * @param timeoutMs - Maximum wait time (default 30000ms per R10-001)
 */
export async function waitForArweaveIndex(
  txId: string,
  timeoutMs = 30000
): Promise<boolean> {
  // Guard against empty or malformed txId to prevent fetching bare gateway URL
  if (!txId || txId.length < 10) {
    throw new Error(`Invalid Arweave txId: "${txId}"`);
  }

  const start = Date.now();
  let delay = 100;

  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`https://arweave.net/${txId}`, {
        method: 'HEAD',
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) return true;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 5000);
  }
  return false;
}
