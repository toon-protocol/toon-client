/* eslint-disable @typescript-eslint/no-non-null-assertion -- safe array-index accesses in blame algorithm */
/**
 * Blame algorithm for Rig-UI.
 *
 * Walks the commit history on Arweave to attribute each line of a file
 * to the commit that last modified it. Simplified blame (not full Myers diff).
 *
 * Browser-compatible: uses Uint8Array, TextDecoder, fetch() only.
 */

import { parseGitCommit, parseGitTree, isBinaryBlob } from './git-objects.js';
import { resolveGitSha, fetchArweaveObject } from './arweave-client.js';
import type { TreeEntry } from './git-objects.js';

/**
 * A single line in a blame result.
 */
export interface BlameLine {
  /** SHA of the commit that last modified this line */
  commitSha: string;
  /** Author identity string from the commit */
  author: string;
  /** Unix timestamp in seconds */
  timestamp: number;
  /** 1-based line number */
  lineNumber: number;
}

/**
 * Result of a blame computation.
 */
export interface BlameResult {
  /** Per-line blame attribution */
  lines: BlameLine[];
  /** The full file content as a string */
  fileContent: string;
  /** True if the depth limit was reached before all lines were attributed */
  beyondLimit: boolean;
  /** Maximum depth used for the computation (for display in depth limit notices) */
  maxDepth: number;
}

/**
 * Reason why blame could not be computed.
 * Used to distinguish file-not-found from binary-file in the UI.
 */
export type BlameError = { reason: 'not-found' } | { reason: 'binary' };

/**
 * Type guard: checks if a computeBlame result is a BlameError.
 */
export function isBlameError(
  result: BlameResult | BlameError | null
): result is BlameError {
  return result !== null && 'reason' in result;
}

/**
 * Resolve a file path within a git tree hierarchy on Arweave.
 *
 * Given a root tree SHA and a path like "src/web/main.ts", walks the
 * tree hierarchy: root tree -> src (subtree) -> web (subtree) -> main.ts (blob).
 *
 * @param treeSha - SHA of the root tree object
 * @param filePath - Forward-slash-separated file path
 * @param repo - Repository identifier for Arweave lookups
 * @returns The blob SHA for the file, or null if not found
 */
export async function resolveFileSha(
  treeSha: string,
  filePath: string,
  repo: string
): Promise<string | null> {
  const segments = filePath.split('/').filter(Boolean);
  if (segments.length === 0) return null;

  let currentTreeSha = treeSha;

  // Walk directory segments (all but the last)
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i]!;
    const entries = await fetchTreeEntries(currentTreeSha, repo);
    if (!entries) return null;

    const dirEntry = entries.find(
      (e) => e.name === segment && e.mode === '40000'
    );
    if (!dirEntry) return null;

    currentTreeSha = dirEntry.sha;
  }

  // Find the file in the final tree
  const fileName = segments[segments.length - 1]!;
  const entries = await fetchTreeEntries(currentTreeSha, repo);
  if (!entries) return null;

  const fileEntry = entries.find((e) => e.name === fileName);
  return fileEntry ? fileEntry.sha : null;
}

/**
 * Fetch and parse a git tree object from Arweave.
 */
async function fetchTreeEntries(
  treeSha: string,
  repo: string
): Promise<TreeEntry[] | null> {
  const txId = await resolveGitSha(treeSha, repo);
  if (!txId) return null;

  const data = await fetchArweaveObject(txId);
  if (!data) return null;

  return parseGitTree(data);
}

/**
 * Compute blame for a file at a given commit.
 *
 * Walks the commit history from Arweave and attributes each line of the
 * current file content to the commit that last modified it.
 *
 * @param filePath - Path to the file within the repository
 * @param startSha - SHA of the starting (most recent) commit
 * @param repo - Repository identifier for Arweave lookups
 * @param maxDepth - Maximum number of commits to walk (default 50)
 * @returns BlameResult on success, BlameError if file is binary or not found, or null on resolution failure
 */
export async function computeBlame(
  filePath: string,
  startSha: string,
  repo: string,
  maxDepth = 50
): Promise<BlameResult | BlameError | null> {
  // 1. Fetch the starting commit
  const startTxId = await resolveGitSha(startSha, repo);
  if (!startTxId) return null;

  const startCommitData = await fetchArweaveObject(startTxId);
  if (!startCommitData) return null;

  const startCommit = parseGitCommit(startCommitData);
  if (!startCommit) return null;

  // 2. Resolve the file in the starting commit's tree
  const blobSha = await resolveFileSha(startCommit.treeSha, filePath, repo);
  if (!blobSha) return { reason: 'not-found' };

  // 3. Fetch the blob and check if binary
  const blobTxId = await resolveGitSha(blobSha, repo);
  if (!blobTxId) return null;

  const blobData = await fetchArweaveObject(blobTxId);
  if (!blobData) return null;

  if (isBinaryBlob(blobData)) return { reason: 'binary' };

  const decoder = new TextDecoder('utf-8', { fatal: false });
  const fileContent = decoder.decode(blobData);
  const lines = fileContent.split('\n');

  // Handle empty file
  if (lines.length === 0 || (lines.length === 1 && lines[0] === '')) {
    return { lines: [], fileContent, beyondLimit: false, maxDepth };
  }

  // 4. Initialize attribution tracking
  // attributed[i] = BlameLine if attributed, undefined if not yet
  const attributed: (BlameLine | undefined)[] = new Array(lines.length).fill(
    undefined
  );
  let unattributedCount = lines.length;

  // 5. Walk the commit chain
  let currentSha = startSha;
  let currentBlobSha = blobSha;
  let depth = 0;
  let lastCommitSha = startSha;
  let lastAuthor = startCommit.author;

  while (unattributedCount > 0 && depth < maxDepth) {
    // Fetch the current commit
    const commitTxId = await resolveGitSha(currentSha, repo);
    if (!commitTxId) break;

    const commitData = await fetchArweaveObject(commitTxId);
    if (!commitData) break;

    const commit = parseGitCommit(commitData);
    if (!commit) break;

    lastCommitSha = currentSha;
    lastAuthor = commit.author;

    // Get parent commit SHA (first parent only)
    const parentSha = commit.parentShas[0];

    if (!parentSha) {
      // Root commit: attribute all remaining lines to this commit
      const ts = extractTimestamp(commit.author);
      for (let i = 0; i < lines.length; i++) {
        if (!attributed[i]) {
          attributed[i] = {
            commitSha: currentSha,
            author: commit.author,
            timestamp: ts,
            lineNumber: i + 1,
          };
          unattributedCount--;
        }
      }
      break;
    }

    // Resolve parent's file blob SHA
    const parentCommitTxId = await resolveGitSha(parentSha, repo);
    if (!parentCommitTxId) {
      // Cannot resolve parent; attribute remaining to current commit
      const ts = extractTimestamp(commit.author);
      for (let i = 0; i < lines.length; i++) {
        if (!attributed[i]) {
          attributed[i] = {
            commitSha: currentSha,
            author: commit.author,
            timestamp: ts,
            lineNumber: i + 1,
          };
          unattributedCount--;
        }
      }
      break;
    }

    const parentCommitData = await fetchArweaveObject(parentCommitTxId);
    if (!parentCommitData) break;

    const parentCommit = parseGitCommit(parentCommitData);
    if (!parentCommit) break;

    const parentBlobSha = await resolveFileSha(
      parentCommit.treeSha,
      filePath,
      repo
    );

    if (!parentBlobSha) {
      // File doesn't exist in parent: all remaining lines added in current commit
      const ts = extractTimestamp(commit.author);
      for (let i = 0; i < lines.length; i++) {
        if (!attributed[i]) {
          attributed[i] = {
            commitSha: currentSha,
            author: commit.author,
            timestamp: ts,
            lineNumber: i + 1,
          };
          unattributedCount--;
        }
      }
      break;
    }

    if (parentBlobSha === currentBlobSha) {
      // File unchanged in this commit, skip to parent
      currentSha = parentSha;
      depth++;
      continue;
    }

    // Fetch parent blob content
    const parentBlobTxId = await resolveGitSha(parentBlobSha, repo);
    if (!parentBlobTxId) break;

    const parentBlobData = await fetchArweaveObject(parentBlobTxId);
    if (!parentBlobData) break;

    const parentContent = decoder.decode(parentBlobData);
    const parentLines = parentContent.split('\n');

    // Diff: find which lines in the current file were introduced in this commit
    const ts = extractTimestamp(commit.author);
    const parentLineSet = new Set(parentLines);

    for (let i = 0; i < lines.length; i++) {
      if (!attributed[i] && !parentLineSet.has(lines[i]!)) {
        attributed[i] = {
          commitSha: currentSha,
          author: commit.author,
          timestamp: ts,
          lineNumber: i + 1,
        };
        unattributedCount--;
      }
    }

    // Move to parent
    currentSha = parentSha;
    currentBlobSha = parentBlobSha;
    depth++;
  }

  // 6. Handle depth limit: attribute remaining lines to the oldest walked commit
  const beyondLimit = unattributedCount > 0;
  if (beyondLimit) {
    const ts = extractTimestamp(lastAuthor);
    for (let i = 0; i < lines.length; i++) {
      if (!attributed[i]) {
        attributed[i] = {
          commitSha: lastCommitSha,
          author: lastAuthor,
          timestamp: ts,
          lineNumber: i + 1,
        };
      }
    }
  }

  return {
    lines: attributed as BlameLine[],
    fileContent,
    beyondLimit,
    maxDepth,
  };
}

/**
 * Extract a Unix timestamp from a git author/committer identity string.
 * Format: "Name <email> timestamp timezone"
 */
function extractTimestamp(ident: string): number {
  const match = /\s(\d+)\s+[+-]\d{4}$/.exec(ident);
  if (!match) return 0;
  return parseInt(match[1]!, 10);
}
