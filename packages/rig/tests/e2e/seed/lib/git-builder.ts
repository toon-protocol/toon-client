/**
 * Git object construction and Arweave upload utilities for E2E seed scripts.
 *
 * Ports createGitBlob, createGitTree, createGitCommit from socialverse-agent-alice-git-push.ts
 * and adds SHA-to-txId tracking for incremental delta uploads.
 *
 * AC-1.2: Git Builder
 */

import { createHash } from 'crypto';
import { finalizeEvent } from 'nostr-tools/pure';
import type { ToonClient, SignedBalanceProof } from '@toon-protocol/client';
import { PEER1_DESTINATION } from './constants.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ShaToTxIdMap = Record<string, string>;

export interface GitObject {
  /** SHA-1 hex digest computed over full git envelope */
  sha: string;
  /** Full git object (header + null + content) */
  buffer: Buffer;
  /** Body only (content after the null byte) — this is what gets uploaded */
  body: Buffer;
}

export interface UploadResult {
  sha: string;
  txId: string | undefined;
}

// ---------------------------------------------------------------------------
// Git object construction
// ---------------------------------------------------------------------------

/**
 * Construct a git blob object and compute its SHA-1.
 *
 * Format: blob <size>\0<content>
 * SHA is over the full envelope; body is content only (for upload).
 */
export function createGitBlob(content: string): GitObject {
  const contentBuf = Buffer.from(content, 'utf-8');
  const header = Buffer.from(`blob ${contentBuf.length}\0`);
  const fullObject = Buffer.concat([header, contentBuf]);
  const sha = createHash('sha1').update(fullObject).digest('hex');
  return { sha, buffer: fullObject, body: contentBuf };
}

/**
 * Construct a git tree object from sorted entries.
 *
 * Format: tree <size>\0<entries>
 * Each entry: <mode> <name>\0<20-byte-raw-sha1>
 * Entries MUST be sorted by name (byte-wise).
 */
export function createGitTree(
  entries: { mode: string; name: string; sha: string }[]
): GitObject {
  // Git sorts tree entries by raw byte order (NOT locale-aware)
  const sorted = [...entries].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  );

  const entryBuffers: Buffer[] = [];
  for (const entry of sorted) {
    const modeAndName = Buffer.from(`${entry.mode} ${entry.name}\0`);
    // Raw 20-byte SHA-1 (NOT hex)
    const rawSha = Buffer.from(entry.sha, 'hex');
    entryBuffers.push(Buffer.concat([modeAndName, rawSha]));
  }

  const entriesContent = Buffer.concat(entryBuffers);
  const header = Buffer.from(`tree ${entriesContent.length}\0`);
  const fullObject = Buffer.concat([header, entriesContent]);
  const sha = createHash('sha1').update(fullObject).digest('hex');
  return { sha, buffer: fullObject, body: entriesContent };
}

/**
 * Construct a git commit object.
 *
 * Format: commit <size>\0tree <tree-sha>\n[parent ...]\nauthor ...\ncommitter ...\n\n<message>
 * Tree/parent SHAs are hex-encoded (40 chars) in commits, unlike tree entries.
 */
export function createGitCommit(opts: {
  treeSha: string;
  parentSha?: string;
  authorName: string;
  authorPubkey: string;
  message: string;
  timestamp: number;
}): GitObject {
  const lines = [
    `tree ${opts.treeSha}`,
    ...(opts.parentSha ? [`parent ${opts.parentSha}`] : []),
    `author ${opts.authorName} <${opts.authorPubkey}@nostr> ${opts.timestamp} +0000`,
    `committer ${opts.authorName} <${opts.authorPubkey}@nostr> ${opts.timestamp} +0000`,
    '',
    opts.message,
  ];
  const contentStr = lines.join('\n');
  const contentBuf = Buffer.from(contentStr, 'utf-8');
  const header = Buffer.from(`commit ${contentBuf.length}\0`);
  const fullObject = Buffer.concat([header, contentBuf]);
  const sha = createHash('sha1').update(fullObject).digest('hex');
  return { sha, buffer: fullObject, body: contentBuf };
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

const MAX_OBJECT_SIZE = 95 * 1024; // 95KB safety margin from 100KB free tier

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
