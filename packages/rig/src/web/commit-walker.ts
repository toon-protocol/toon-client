/**
 * Commit chain walker for Forge-UI.
 *
 * Walks the parent chain of git commits stored on Arweave,
 * returning a linear history (first-parent only for merge commits).
 */

import type { GitCommit } from './git-objects.js';
import { parseGitCommit } from './git-objects.js';
import { resolveGitSha, fetchArweaveObject } from './arweave-client.js';

/**
 * A commit log entry wrapping a parsed GitCommit with its own SHA.
 */
export interface CommitLogEntry {
  /** The SHA-1 hash of this commit */
  sha: string;
  /** The parsed commit object */
  commit: GitCommit;
}

/**
 * Walk the commit parent chain from Arweave, returning a linear history.
 *
 * Follows only the first parent at merge commits (matching `git log --first-parent`).
 * Stops gracefully when: no parent exists (root commit), parent SHA cannot be
 * resolved on Arweave, or maxDepth is reached. Never throws.
 *
 * @param startSha - The SHA of the starting (most recent) commit
 * @param repo - Repository identifier for Arweave lookups
 * @param maxDepth - Maximum number of commits to walk (default 50)
 * @returns Array of CommitLogEntry ordered newest-first
 */
export async function walkCommitChain(
  startSha: string,
  repo: string,
  maxDepth = 50
): Promise<CommitLogEntry[]> {
  const entries: CommitLogEntry[] = [];
  let currentSha: string | undefined = startSha;

  while (currentSha && entries.length < maxDepth) {
    try {
      const txId = await resolveGitSha(currentSha, repo);
      if (!txId) break;

      const data = await fetchArweaveObject(txId);
      if (!data) break;

      const commit = parseGitCommit(data);
      if (!commit) break;

      entries.push({ sha: currentSha, commit });

      // Follow first parent only (linear history)
      currentSha = commit.parentShas[0];
    } catch {
      // Graceful stop on any error
      break;
    }
  }

  return entries;
}
