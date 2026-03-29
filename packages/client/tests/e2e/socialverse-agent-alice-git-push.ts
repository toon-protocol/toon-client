/**
 * Alice — Git Push to Arweave
 *
 * Constructs real git objects (blob, tree, commit) for a simple repo with
 * README.md and LICENSE, uploads each to Arweave via the DVM (kind:5094),
 * and publishes a kind:30618 repo state event with the real commit SHA.
 *
 * Every binary format and tag schema is derived from the TOON skill files
 * (cited in comments throughout).
 */

import { createHash } from 'crypto';
import { runAgent } from './socialverse-agent-harness.js';

// ---------------------------------------------------------------------------
// File contents for the demo repo
// ---------------------------------------------------------------------------

const README_CONTENT = `# hello-toon

A demo repository created by autonomous TOON agents.
`;

const LICENSE_CONTENT = `MIT License

Copyright (c) 2026 TOON Protocol
`;

const REPO_ID = 'hello-toon';

// ---------------------------------------------------------------------------
// Git object construction helpers
//
// All binary formats follow: git-objects/SKILL.md
// ---------------------------------------------------------------------------

/**
 * Construct a git blob object and compute its SHA-1.
 *
 * Format (git-objects/SKILL.md § "Blob Format"):
 *   blob <size>\0<content>
 *
 * SHA-1 is computed over the entire envelope (header + null + content).
 * (git-objects/SKILL.md § "SHA-1 Computation")
 */
function createGitBlob(content: string): { sha: string; buffer: Buffer; body: Buffer } {
  const contentBuf = Buffer.from(content, 'utf-8');
  const header = Buffer.from(`blob ${contentBuf.length}\0`);
  const fullObject = Buffer.concat([header, contentBuf]);
  const sha = createHash('sha1').update(fullObject).digest('hex');
  // SHA computed over full envelope, but upload only the body (content after \0)
  return { sha, buffer: fullObject, body: contentBuf };
}

/**
 * Construct a git tree object from an array of entries and compute its SHA-1.
 *
 * Format (git-objects/SKILL.md § "Tree Format"):
 *   tree <size>\0<entries>
 *
 * Each entry (git-objects/SKILL.md § "Tree Format"):
 *   <mode> <name>\0<20-byte-sha1>
 *
 * Critical: entries MUST be sorted by name using byte-wise sorting.
 * The SHA-1 in tree entries is raw 20-byte binary, NOT hex-encoded.
 * (git-objects/SKILL.md § "Tree Format")
 */
function createGitTree(
  entries: { mode: string; name: string; sha: string }[]
): { sha: string; buffer: Buffer; body: Buffer } {
  // Sort entries by name (byte-wise), per git-objects/SKILL.md § "Tree Format"
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name, 'en'));

  // Build concatenated entry buffers
  const entryBuffers: Buffer[] = [];
  for (const entry of sorted) {
    const modeAndName = Buffer.from(`${entry.mode} ${entry.name}\0`);
    // Raw 20-byte SHA-1 (NOT hex), per git-objects/SKILL.md § "Tree Format"
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
 * Construct a git commit object and compute its SHA-1.
 *
 * Format (git-objects/SKILL.md § "Commit Format"):
 *   commit <size>\0tree <tree-sha>\n
 *   [parent <parent-sha>\n]*
 *   author <name> <email> <timestamp> <timezone>\n
 *   committer <name> <email> <timestamp> <timezone>\n
 *   \n
 *   <message>
 *
 * Note: SHA-1 values in commit objects are hex-encoded (40 chars),
 * unlike tree entries which use raw 20-byte binary.
 * (git-objects/SKILL.md § "Commit Format")
 *
 * Nostr pubkey to git author mapping (git-objects/SKILL.md § "Nostr Pubkey to Git Author Mapping"):
 *   author Alice <hex-pubkey@nostr> <timestamp> +0000
 */
function createGitCommit(opts: {
  treeSha: string;
  authorName: string;
  authorPubkey: string;
  message: string;
  timestamp: number;
}): { sha: string; buffer: Buffer; body: Buffer } {
  const lines = [
    `tree ${opts.treeSha}`,
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
// Upload helper — kind:5094 with Git-specific tags
//
// The harness ctx.publishBlob() uses buildBlobStorageRequest which does NOT
// support custom tags (Git-SHA, Git-Type, Repo). We construct the event
// manually with all required + git-specific tags, then use ctx.sign() +
// ctx.publish().
//
// Tags follow: kind-5094-arweave-blob.md § "Required Tags" and
//              kind-5094-arweave-blob.md § "Git-Specific Tags"
// Upload order: blobs first, then trees, then commits.
// (git-arweave/SKILL.md § "Upload Flow Overview")
// ---------------------------------------------------------------------------

async function uploadGitObject(
  ctx: Parameters<Parameters<typeof runAgent>[1]>[0],
  objectBody: Buffer,  // content WITHOUT git header — matches `git cat-file <type> <sha>` output
  gitSha: string,
  gitType: 'blob' | 'tree' | 'commit',
  repoId: string
): Promise<{ success: boolean; eventId?: string; arweaveTxId?: string }> {
  // Upload the body (content after the \0 header), not the full envelope.
  // This matches how `git cat-file <type>` outputs content and how the Rig parser expects it.
  const base64Data = objectBody.toString('base64');
  const bid = (BigInt(objectBody.length) * 10n).toString();

  // Construct kind:5094 event with git-specific tags
  // Required tags: kind-5094-arweave-blob.md § "Required Tags"
  // Git-specific tags: kind-5094-arweave-blob.md § "Git-Specific Tags"
  const event = ctx.sign({
    kind: 5094,
    content: '',
    tags: [
      // Required: base64 blob data with type marker
      ['i', base64Data, 'blob'],
      // Required: bid in USDC micro-units
      ['bid', bid, 'usdc'],
      // Required: output content type
      ['output', 'application/octet-stream'],
      // Git-specific: content-addressed SHA hash
      ['Git-SHA', gitSha],
      // Git-specific: object type (blob, tree, or commit)
      ['Git-Type', gitType],
      // Git-specific: repository identifier
      ['Repo', repoId],
    ],
    created_at: Math.floor(Date.now() / 1000),
  });

  const result = await ctx.publish(event);
  // DVM fulfillment data contains the Arweave TX ID (base64-encoded)
  const arweaveTxId = result.data
    ? Buffer.from(result.data, 'base64').toString('utf-8')
    : undefined;
  return { success: result.success, eventId: event.id, arweaveTxId };
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

runAgent('alice', async (ctx) => {
  console.log(`\n[alice] === Git Push to Arweave: ${REPO_ID} ===\n`);

  // -------------------------------------------------------------------------
  // Step 1: Create git blob objects
  //
  // git-objects/SKILL.md § "Blob Format":
  //   blob <size>\0<content>
  // Upload order: blobs first (git-arweave/SKILL.md § "Upload Flow Overview")
  // -------------------------------------------------------------------------

  console.log('[alice] --- Step 1: Create git blob objects ---');

  const readmeBlob = createGitBlob(README_CONTENT);
  console.log(`[alice] README.md blob SHA: ${readmeBlob.sha}`);
  console.log(`[alice]   size: ${readmeBlob.buffer.length} bytes`);

  const licenseBlob = createGitBlob(LICENSE_CONTENT);
  console.log(`[alice] LICENSE blob SHA:    ${licenseBlob.sha}`);
  console.log(`[alice]   size: ${licenseBlob.buffer.length} bytes`);

  // -------------------------------------------------------------------------
  // Step 2: Upload blob objects to Arweave via kind:5094
  //
  // kind-5094-arweave-blob.md § "Required Tags": i, bid, output
  // kind-5094-arweave-blob.md § "Git-Specific Tags": Git-SHA, Git-Type, Repo
  // git-arweave/SKILL.md § "Upload Flow Overview" step 6: "Publish the kind:5094 event"
  // -------------------------------------------------------------------------

  console.log('\n[alice] --- Step 2: Upload blobs to Arweave ---');

  const readmeUpload = await uploadGitObject(
    ctx, readmeBlob.body, readmeBlob.sha, 'blob', REPO_ID
  );
  console.log(`[alice] README.md upload: success=${readmeUpload.success}, txId=${readmeUpload.arweaveTxId ?? 'none'}`);

  const licenseUpload = await uploadGitObject(
    ctx, licenseBlob.body, licenseBlob.sha, 'blob', REPO_ID
  );
  console.log(`[alice] LICENSE upload:    success=${licenseUpload.success}, txId=${licenseUpload.arweaveTxId ?? 'none'}`);

  // -------------------------------------------------------------------------
  // Step 3: Create git tree object
  //
  // git-objects/SKILL.md § "Tree Format":
  //   tree <size>\0<entries>
  //   Each entry: <mode> <name>\0<20-byte-sha1>
  //   Entries sorted by name (byte-wise).
  //   Mode 100644 = regular file.
  //   SHA-1 in entries is raw 20-byte binary.
  // -------------------------------------------------------------------------

  console.log('\n[alice] --- Step 3: Create git tree object ---');

  const tree = createGitTree([
    { mode: '100644', name: 'README.md', sha: readmeBlob.sha },
    { mode: '100644', name: 'LICENSE', sha: licenseBlob.sha },
  ]);
  console.log(`[alice] Tree SHA: ${tree.sha}`);
  console.log(`[alice]   size: ${tree.buffer.length} bytes`);
  console.log(`[alice]   entries: LICENSE (${licenseBlob.sha.slice(0, 12)}...), README.md (${readmeBlob.sha.slice(0, 12)}...)`);

  // -------------------------------------------------------------------------
  // Step 4: Upload tree object to Arweave
  //
  // git-arweave/SKILL.md § "Upload Flow Overview":
  //   "Upload order matters: blobs first, then trees, then commits."
  // -------------------------------------------------------------------------

  console.log('\n[alice] --- Step 4: Upload tree to Arweave ---');

  const treeUpload = await uploadGitObject(
    ctx, tree.body, tree.sha, 'tree', REPO_ID
  );
  console.log(`[alice] Tree upload: success=${treeUpload.success}, txId=${treeUpload.arweaveTxId ?? 'none'}`);

  // -------------------------------------------------------------------------
  // Step 5: Create git commit object
  //
  // git-objects/SKILL.md § "Commit Format":
  //   commit <size>\0tree <tree-sha>\n
  //   author <name> <email> <timestamp> <timezone>\n
  //   committer <name> <email> <timestamp> <timezone>\n
  //   \n<message>
  //
  //   No parent line for initial commit.
  //   tree SHA is hex-encoded (40 chars).
  //
  // git-objects/SKILL.md § "Nostr Pubkey to Git Author Mapping":
  //   author Alice <hex-pubkey@nostr> <timestamp> +0000
  // -------------------------------------------------------------------------

  console.log('\n[alice] --- Step 5: Create git commit object ---');

  const timestamp = Math.floor(Date.now() / 1000);
  const commit = createGitCommit({
    treeSha: tree.sha,
    authorName: 'Alice',
    authorPubkey: ctx.pubkey,
    message: 'Initial commit: hello-toon repository\n',
    timestamp,
  });
  console.log(`[alice] Commit SHA: ${commit.sha}`);
  console.log(`[alice]   size: ${commit.buffer.length} bytes`);
  console.log(`[alice]   tree: ${tree.sha}`);
  console.log(`[alice]   author: Alice <${ctx.pubkey.slice(0, 12)}...@nostr>`);
  console.log(`[alice]   timestamp: ${timestamp}`);

  // -------------------------------------------------------------------------
  // Step 6: Upload commit object to Arweave
  //
  // git-arweave/SKILL.md § "Upload Flow Overview":
  //   Commits uploaded last (after blobs and trees).
  // -------------------------------------------------------------------------

  console.log('\n[alice] --- Step 6: Upload commit to Arweave ---');

  const commitUpload = await uploadGitObject(
    ctx, commit.body, commit.sha, 'commit', REPO_ID
  );
  console.log(`[alice] Commit upload: success=${commitUpload.success}, txId=${commitUpload.arweaveTxId ?? 'none'}`);

  // -------------------------------------------------------------------------
  // Step 7: Publish kind:30618 — Repository State
  //
  // kind-30618-repo-state.md § "Required Tags":
  //   d tag must match a kind:30617 repository announcement's d tag
  //
  // kind-30618-repo-state.md § "Optional Tags":
  //   refs/heads/* — branch head commit hash
  //   HEAD — default branch reference
  //
  // This is a parameterized replaceable event — each update replaces
  // the previous state.
  // -------------------------------------------------------------------------

  console.log('\n[alice] --- Step 7: Publish kind:30618 repo state ---');

  const repoStateEvent = ctx.sign({
    kind: 30618,
    content: '',
    tags: [
      // d tag matches the repo identifier (kind-30618-repo-state.md § "Required Tags")
      ['d', REPO_ID],
      // Branch refs use ["r", "<ref-name>", "<commit-sha>"] format
      ['r', 'refs/heads/main', commit.sha],
      // HEAD reference
      ['HEAD', 'ref: refs/heads/main'],
      // Arweave SHA→txId mappings (Rig nip34-parsers.ts parseRepoRefs() reads these)
      // ["arweave", "<git-sha>", "<arweave-txId>"]
      ...(commitUpload.arweaveTxId ? [['arweave', commit.sha, commitUpload.arweaveTxId]] : []),
      ...(treeUpload.arweaveTxId ? [['arweave', tree.sha, treeUpload.arweaveTxId]] : []),
      ...(readmeUpload.arweaveTxId ? [['arweave', readmeBlob.sha, readmeUpload.arweaveTxId]] : []),
      ...(licenseUpload.arweaveTxId ? [['arweave', licenseBlob.sha, licenseUpload.arweaveTxId]] : []),
    ],
    created_at: Math.floor(Date.now() / 1000),
  });
  const stateResult = await ctx.publish(repoStateEvent);

  console.log(`[alice] Repo state published: success=${stateResult.success}`);
  console.log(`[alice]   event ID: ${repoStateEvent.id}`);
  console.log(`[alice]   refs/heads/main -> ${commit.sha}`);

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------

  console.log('\n[alice] === Git Push Summary ===');
  console.log(`[alice] Repository: ${REPO_ID}`);
  console.log(`[alice] Objects uploaded:`);
  console.log(`[alice]   blob README.md  ${readmeBlob.sha}  ${readmeUpload.success ? 'OK' : 'FAIL'}`);
  console.log(`[alice]   blob LICENSE    ${licenseBlob.sha}  ${licenseUpload.success ? 'OK' : 'FAIL'}`);
  console.log(`[alice]   tree           ${tree.sha}  ${treeUpload.success ? 'OK' : 'FAIL'}`);
  console.log(`[alice]   commit         ${commit.sha}  ${commitUpload.success ? 'OK' : 'FAIL'}`);
  console.log(`[alice] Branch main -> ${commit.sha}`);
  console.log(`[alice] Repo state (kind:30618): ${stateResult.success ? 'OK' : 'FAIL'}`);
  console.log('[alice] === Done ===\n');
});
