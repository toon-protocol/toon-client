// ATDD Red Phase - Integration tests will fail until implementation exists
// Test: 3.2-INT-001 [P0]: Patch application: kind:1617 -> git am succeeds

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import {
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
} from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';

// --- Imports from @crosstown/rig (DOES NOT EXIST YET) ---
import { handlePatch } from '../handlers/patch-handler.js';
import { createInMemoryMetadataStore } from '../storage/metadata-store.js';
import type { MetadataStore } from '../storage/metadata-store.js';
import type { HandlerContext } from '../types.js';

// --- Imports from @crosstown/core (exists) ---
import {
  PATCH_KIND,
  REPOSITORY_ANNOUNCEMENT_KIND,
} from '@crosstown/core/nip34';

// ---------------------------------------------------------------------------
// Factory Functions
// ---------------------------------------------------------------------------

/**
 * Initializes a bare git repository with an initial commit.
 * Returns the repo path and utility functions.
 */
function createGitRepoWithCommit(
  baseDir: string,
  repoName: string
): {
  bareRepoPath: string;
  workTreePath: string;
  initialCommitSha: string;
} {
  // Create bare repo
  const bareRepoPath = path.join(baseDir, `${repoName}.git`);
  execSync(`git init --bare "${bareRepoPath}"`, { stdio: 'pipe' });

  // Create a temporary worktree to make initial commit
  const workTreePath = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-worktree-'));
  execSync(`git clone "${bareRepoPath}" "${workTreePath}"`, { stdio: 'pipe' });

  // Configure git identity in the worktree
  execSync('git config user.email "test@nostr"', {
    cwd: workTreePath,
    stdio: 'pipe',
  });
  execSync('git config user.name "test-user"', {
    cwd: workTreePath,
    stdio: 'pipe',
  });

  // Create initial file and commit
  fs.writeFileSync(path.join(workTreePath, 'README.md'), '# Test Repository\n');
  execSync('git add README.md', { cwd: workTreePath, stdio: 'pipe' });
  execSync('git commit -m "Initial commit"', {
    cwd: workTreePath,
    stdio: 'pipe',
  });
  execSync('git push origin main', { cwd: workTreePath, stdio: 'pipe' });

  // Get initial commit SHA
  const initialCommitSha = execSync('git rev-parse HEAD', {
    cwd: workTreePath,
    encoding: 'utf-8',
  }).trim();

  return { bareRepoPath, workTreePath, initialCommitSha };
}

/**
 * Generates a valid git format-patch content by making changes in a worktree.
 */
function generatePatchContent(
  workTreePath: string,
  changes: { filename: string; content: string; commitMessage: string }
): string {
  // Make a change in the worktree
  fs.writeFileSync(path.join(workTreePath, changes.filename), changes.content);
  execSync(`git add "${changes.filename}"`, {
    cwd: workTreePath,
    stdio: 'pipe',
  });
  execSync(`git commit -m "${changes.commitMessage}"`, {
    cwd: workTreePath,
    stdio: 'pipe',
  });

  // Generate format-patch output
  const patch = execSync('git format-patch -1 --stdout', {
    cwd: workTreePath,
    encoding: 'utf-8',
  });

  return patch;
}

/**
 * Creates a kind:1617 Patch event referencing a repository.
 */
function createPatchEvent(
  ownerPubkey: string,
  repoId: string,
  patchContent: string,
  overrides: {
    secretKey?: Uint8Array;
    commitSha?: string;
    parentCommitSha?: string;
  } = {}
): { event: NostrEvent; secretKey: Uint8Array; pubkey: string } {
  const secretKey = overrides.secretKey ?? generateSecretKey();
  const pubkey = getPublicKey(secretKey);

  const tags: string[][] = [
    ['a', `${REPOSITORY_ANNOUNCEMENT_KIND}:${ownerPubkey}:${repoId}`],
    ['p', ownerPubkey],
    ['t', 'root'],
  ];

  if (overrides.commitSha) {
    tags.push(['commit', overrides.commitSha]);
  }
  if (overrides.parentCommitSha) {
    tags.push(['parent-commit', overrides.parentCommitSha]);
  }

  const event = finalizeEvent(
    {
      kind: PATCH_KIND,
      content: patchContent,
      tags,
      created_at: Math.floor(Date.now() / 1000),
    },
    secretKey
  );

  return { event, secretKey, pubkey };
}

/**
 * Creates a mock HandlerContext for testing handler functions.
 */
function createMockHandlerContext(
  event: NostrEvent,
  overrides: {
    amount?: bigint;
    destination?: string;
  } = {}
): HandlerContext & {
  acceptSpy: ReturnType<typeof vi.fn>;
  rejectSpy: ReturnType<typeof vi.fn>;
} {
  const acceptSpy = vi.fn().mockResolvedValue({ accept: true });
  const rejectSpy = vi.fn().mockResolvedValue({ accept: false });

  let decoded: NostrEvent | null = null;

  return {
    toon: '',
    kind: event.kind,
    pubkey: event.pubkey,
    amount: overrides.amount ?? 1000n,
    destination: overrides.destination ?? 'g.rig.test',
    decode: () => {
      if (!decoded) {
        decoded = event;
      }
      return decoded;
    },
    accept: acceptSpy,
    reject: rejectSpy,
    acceptSpy,
    rejectSpy,
  };
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('3.2-INT-001: Patch Application via kind:1617', () => {
  let baseDir: string;
  let workTreePaths: string[];
  let metadataStore: MetadataStore;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-patch-test-'));
    workTreePaths = [];
    metadataStore = createInMemoryMetadataStore();
  });

  afterEach(() => {
    // Clean up base dir and any worktrees
    fs.rmSync(baseDir, { recursive: true, force: true });
    for (const workTree of workTreePaths) {
      fs.rmSync(workTree, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // [P0] Valid patch is applied successfully via git am
  // -------------------------------------------------------------------------

  it.skip('[P0] valid git format-patch is applied to bare repo successfully', async () => {
    // Arrange - create repo with initial commit
    const ownerKey = generateSecretKey();
    const ownerPubkey = getPublicKey(ownerKey);
    const repoName = 'patch-test-repo';
    const ownerPrefix = ownerPubkey.slice(0, 8);
    const repoBaseDir = path.join(baseDir, ownerPrefix);
    fs.mkdirSync(repoBaseDir, { recursive: true });

    const { bareRepoPath, workTreePath, initialCommitSha } =
      createGitRepoWithCommit(repoBaseDir, repoName);
    workTreePaths.push(workTreePath);

    // Register repo in metadata store
    metadataStore.storeRepo({
      name: repoName,
      description: 'Patch test repo',
      ownerPubkey,
      ownerPrefix,
      repoPath: bareRepoPath,
      maintainers: [ownerPubkey],
      createdAt: Math.floor(Date.now() / 1000),
    });

    // Generate a valid patch
    const patchContent = generatePatchContent(workTreePath, {
      filename: 'hello.txt',
      content: 'Hello from patch!\n',
      commitMessage: 'Add hello.txt',
    });

    // Create kind:1617 patch event
    const { event } = createPatchEvent(ownerPubkey, repoName, patchContent, {
      parentCommitSha: initialCommitSha,
    });
    const ctx = createMockHandlerContext(event);

    // Act
    await handlePatch(ctx, { repoDir: baseDir, metadataStore });

    // Assert - patch was applied (new commit exists)
    const commitCount = execSync('git rev-list --count HEAD', {
      cwd: bareRepoPath,
      env: { ...process.env, GIT_DIR: bareRepoPath },
      encoding: 'utf-8',
    }).trim();
    expect(parseInt(commitCount, 10)).toBeGreaterThan(1);

    // Verify the new file exists in the repo
    const treeOutput = execSync('git ls-tree HEAD --name-only', {
      cwd: bareRepoPath,
      env: { ...process.env, GIT_DIR: bareRepoPath },
      encoding: 'utf-8',
    });
    expect(treeOutput).toContain('hello.txt');

    // Verify ctx.accept() was called
    expect(ctx.acceptSpy).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // [P0] ctx.accept() called on successful patch application
  // -------------------------------------------------------------------------

  it.skip('[P0] ctx.accept() is called after successful patch application', async () => {
    // Arrange
    const ownerKey = generateSecretKey();
    const ownerPubkey = getPublicKey(ownerKey);
    const repoName = 'accept-patch-repo';
    const ownerPrefix = ownerPubkey.slice(0, 8);
    const repoBaseDir = path.join(baseDir, ownerPrefix);
    fs.mkdirSync(repoBaseDir, { recursive: true });

    const { bareRepoPath, workTreePath } = createGitRepoWithCommit(
      repoBaseDir,
      repoName
    );
    workTreePaths.push(workTreePath);

    metadataStore.storeRepo({
      name: repoName,
      description: 'Accept patch repo',
      ownerPubkey,
      ownerPrefix,
      repoPath: bareRepoPath,
      maintainers: [ownerPubkey],
      createdAt: Math.floor(Date.now() / 1000),
    });

    const patchContent = generatePatchContent(workTreePath, {
      filename: 'feature.ts',
      content: 'export const feature = true;\n',
      commitMessage: 'Add feature module',
    });

    const { event } = createPatchEvent(ownerPubkey, repoName, patchContent);
    const ctx = createMockHandlerContext(event);

    // Act
    await handlePatch(ctx, { repoDir: baseDir, metadataStore });

    // Assert
    expect(ctx.acceptSpy).toHaveBeenCalledOnce();
    expect(ctx.rejectSpy).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // [P0] Malformed patch is rejected with F00
  // -------------------------------------------------------------------------

  it.skip('[P0] malformed patch content is rejected with F00', async () => {
    // Arrange
    const ownerKey = generateSecretKey();
    const ownerPubkey = getPublicKey(ownerKey);
    const repoName = 'malformed-patch-repo';
    const ownerPrefix = ownerPubkey.slice(0, 8);
    const repoBaseDir = path.join(baseDir, ownerPrefix);
    fs.mkdirSync(repoBaseDir, { recursive: true });

    const { bareRepoPath, workTreePath } = createGitRepoWithCommit(
      repoBaseDir,
      repoName
    );
    workTreePaths.push(workTreePath);

    metadataStore.storeRepo({
      name: repoName,
      description: 'Malformed patch repo',
      ownerPubkey,
      ownerPrefix,
      repoPath: bareRepoPath,
      maintainers: [ownerPubkey],
      createdAt: Math.floor(Date.now() / 1000),
    });

    // Create a malformed patch
    const malformedPatch =
      'This is not a valid git patch format\n@@ invalid diff @@\n';
    const { event } = createPatchEvent(ownerPubkey, repoName, malformedPatch);
    const ctx = createMockHandlerContext(event);

    // Act
    await handlePatch(ctx, { repoDir: baseDir, metadataStore });

    // Assert
    expect(ctx.rejectSpy).toHaveBeenCalledOnce();
    expect(ctx.rejectSpy).toHaveBeenCalledWith(
      'F00',
      expect.stringContaining('atch')
    );
    expect(ctx.acceptSpy).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // [P0] Patch for non-existent repo is rejected with F00
  // -------------------------------------------------------------------------

  it.skip('[P0] patch referencing non-existent repository is rejected with F00', async () => {
    // Arrange
    const ownerKey = generateSecretKey();
    const ownerPubkey = getPublicKey(ownerKey);
    const patchContent =
      'From abc123 Mon Sep 17 00:00:00 2001\nSubject: test\n---\n';

    const { event } = createPatchEvent(
      ownerPubkey,
      'nonexistent-repo',
      patchContent
    );
    const ctx = createMockHandlerContext(event);

    // Act
    await handlePatch(ctx, { repoDir: baseDir, metadataStore });

    // Assert
    expect(ctx.rejectSpy).toHaveBeenCalledOnce();
    expect(ctx.rejectSpy).toHaveBeenCalledWith(
      'F00',
      expect.stringContaining('not found')
    );
    expect(ctx.acceptSpy).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // [P1] Patch author pubkey is recorded in commit metadata
  // -------------------------------------------------------------------------

  it.skip('[P1] patch commit attributes the contributor pubkey as author', async () => {
    // Arrange
    const ownerKey = generateSecretKey();
    const ownerPubkey = getPublicKey(ownerKey);
    const repoName = 'author-test-repo';
    const ownerPrefix = ownerPubkey.slice(0, 8);
    const repoBaseDir = path.join(baseDir, ownerPrefix);
    fs.mkdirSync(repoBaseDir, { recursive: true });

    const { bareRepoPath, workTreePath } = createGitRepoWithCommit(
      repoBaseDir,
      repoName
    );
    workTreePaths.push(workTreePath);

    metadataStore.storeRepo({
      name: repoName,
      description: 'Author test repo',
      ownerPubkey,
      ownerPrefix,
      repoPath: bareRepoPath,
      maintainers: [ownerPubkey],
      createdAt: Math.floor(Date.now() / 1000),
    });

    const contributorKey = generateSecretKey();
    const contributorPubkey = getPublicKey(contributorKey);
    const patchContent = generatePatchContent(workTreePath, {
      filename: 'contributor-file.ts',
      content: 'export const contributed = true;\n',
      commitMessage: 'Contributor patch',
    });

    const { event } = createPatchEvent(ownerPubkey, repoName, patchContent, {
      secretKey: contributorKey,
    });
    const ctx = createMockHandlerContext(event);

    // Act
    await handlePatch(ctx, { repoDir: baseDir, metadataStore });

    // Assert - commit author should reference the contributor's pubkey
    const lastCommitAuthor = execSync('git log -1 --format=%ae', {
      cwd: bareRepoPath,
      env: { ...process.env, GIT_DIR: bareRepoPath },
      encoding: 'utf-8',
    }).trim();
    expect(lastCommitAuthor).toContain(contributorPubkey.slice(0, 16));
  });
});
