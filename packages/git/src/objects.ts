/**
 * Pure git object construction and SHA-1 envelope hashing.
 *
 * Promoted from `packages/rig/tests/e2e/seed/lib/git-builder.ts` (#223) —
 * the proven seed pipeline builders, now the core of the Git-to-TOON write
 * path. Everything here is pure: no network, no signing, no payments.
 * Upload/publish lives with the Publisher (#226).
 *
 * Git object format: `<type> <size>\0<content>`. The SHA-1 is computed over
 * the full envelope (header + NUL + content); the `body` (content only) is
 * what gets uploaded to Arweave.
 */

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** All git object types TOON can carry. */
export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  /** SHA-1 hex digest computed over full git envelope */
  sha: string;
  /** Full git object (header + null + content) */
  buffer: Buffer;
  /** Body only (content after the null byte) — this is what gets uploaded */
  body: Buffer;
}

/**
 * Maximum uploadable git object body size: 95KB safety margin under the
 * 100KB free tier (R10-005). Larger objects are a hard error in v1.
 */
export const MAX_OBJECT_SIZE = 95 * 1024;

// ---------------------------------------------------------------------------
// Envelope hashing
// ---------------------------------------------------------------------------

/**
 * Wrap a raw object body in the git envelope (`<type> <size>\0`) and compute
 * its SHA-1. This is exactly what `git hash-object -t <type>` does.
 */
export function hashGitObject(type: GitObjectType, body: Buffer): GitObject {
  const header = Buffer.from(`${type} ${body.length}\0`);
  const fullObject = Buffer.concat([header, body]);
  const sha = createHash('sha1').update(fullObject).digest('hex');
  return { sha, buffer: fullObject, body };
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
  return hashGitObject('blob', Buffer.from(content, 'utf-8'));
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

  return hashGitObject('tree', Buffer.concat(entryBuffers));
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
  return hashGitObject('commit', Buffer.from(lines.join('\n'), 'utf-8'));
}

/**
 * Construct an annotated git tag object.
 *
 * Format: tag <size>\0object <sha>\ntype <type>\ntag <name>\ntagger ...\n\n<message>
 * The tagged object is usually a commit, but git allows tagging any object
 * type (including another tag).
 */
export function createGitTag(opts: {
  /** SHA-1 of the object being tagged (hex, 40 chars) */
  objectSha: string;
  /** Type of the tagged object (usually 'commit') */
  objectType: GitObjectType;
  /** Tag name, e.g. 'v1.0.0' */
  tagName: string;
  taggerName: string;
  taggerPubkey: string;
  message: string;
  timestamp: number;
}): GitObject {
  const lines = [
    `object ${opts.objectSha}`,
    `type ${opts.objectType}`,
    `tag ${opts.tagName}`,
    `tagger ${opts.taggerName} <${opts.taggerPubkey}@nostr> ${opts.timestamp} +0000`,
    '',
    opts.message,
  ];
  return hashGitObject('tag', Buffer.from(lines.join('\n'), 'utf-8'));
}
