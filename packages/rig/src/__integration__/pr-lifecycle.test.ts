// ATDD Red Phase - Integration tests will fail until implementation exists
// Test: 3.6-INT-001 [P0]: PR merge: kind:1631 -> git merge on target branch

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

// --- Imports from @toon-protocol/rig (DOES NOT EXIST YET) ---
import { handlePrLifecycle } from '../handlers/pr-lifecycle-handler.js';
import { createInMemoryMetadataStore } from '../storage/metadata-store.js';
import type { MetadataStore } from '../storage/metadata-store.js';
import type { HandlerContext } from '../types.js';

// --- Imports from @toon-protocol/core (exists) ---
import {
  STATUS_APPLIED_KIND,
  STATUS_CLOSED_KIND,
  STATUS_DRAFT_KIND,
  STATUS_OPEN_KIND,
  REPOSITORY_ANNOUNCEMENT_KIND,
} from '@toon-protocol/core/nip34';

// ---------------------------------------------------------------------------
// Factory Functions
// ---------------------------------------------------------------------------

/**
 * Creates a bare git repo with main branch and a feature branch with diverging commits.
 * Returns paths and commit SHAs for assertions.
 */
function createRepoWithBranches(
  baseDir: string,
  repoName: string,
  options: {
    mainCommits?: number;
    featureBranch?: string;
    featureCommits?: number;
  } = {}
): {
  bareRepoPath: string;
  workTreePath: string;
  mainHeadSha: string;
  featureBranchName: string;
  featureHeadSha: string;
} {
  const mainCommitCount = options.mainCommits ?? 1;
  const featureBranchName = options.featureBranch ?? 'feature/my-patch';
  const featureCommitCount = options.featureCommits ?? 1;

  // Create bare repo
  const bareRepoPath = path.join(baseDir, `${repoName}.git`);
  execSync(`git init --bare "${bareRepoPath}"`, { stdio: 'pipe' });

  // Clone to worktree for committing
  const workTreePath = fs.mkdtempSync(
    path.join(os.tmpdir(), 'rig-pr-worktree-')
  );
  execSync(`git clone "${bareRepoPath}" "${workTreePath}"`, { stdio: 'pipe' });
  execSync('git config user.email "test@nostr"', {
    cwd: workTreePath,
    stdio: 'pipe',
  });
  execSync('git config user.name "test-user"', {
    cwd: workTreePath,
    stdio: 'pipe',
  });

  // Create initial commit on main
  fs.writeFileSync(path.join(workTreePath, 'README.md'), '# Test Repo\n');
  execSync('git add README.md', { cwd: workTreePath, stdio: 'pipe' });
  execSync('git commit -m "Initial commit"', {
    cwd: workTreePath,
    stdio: 'pipe',
  });

  // Add additional main commits
  for (let i = 1; i < mainCommitCount; i++) {
    fs.writeFileSync(
      path.join(workTreePath, `main-file-${i}.txt`),
      `Main commit ${i}\n`
    );
    execSync(`git add main-file-${i}.txt`, {
      cwd: workTreePath,
      stdio: 'pipe',
    });
    execSync(`git commit -m "Main commit ${i}"`, {
      cwd: workTreePath,
      stdio: 'pipe',
    });
  }

  // Push main to bare repo
  execSync('git push origin main', { cwd: workTreePath, stdio: 'pipe' });

  const mainHeadSha = execSync('git rev-parse HEAD', {
    cwd: workTreePath,
    encoding: 'utf-8',
  }).trim();

  // Create feature branch with diverging commits
  execSync(`git checkout -b "${featureBranchName}"`, {
    cwd: workTreePath,
    stdio: 'pipe',
  });

  for (let i = 0; i < featureCommitCount; i++) {
    fs.writeFileSync(
      path.join(workTreePath, `feature-file-${i}.txt`),
      `Feature commit ${i}\n`
    );
    execSync(`git add feature-file-${i}.txt`, {
      cwd: workTreePath,
      stdio: 'pipe',
    });
    execSync(`git commit -m "Feature commit ${i}"`, {
      cwd: workTreePath,
      stdio: 'pipe',
    });
  }

  // Push feature branch to bare repo
  execSync(`git push origin "${featureBranchName}"`, {
    cwd: workTreePath,
    stdio: 'pipe',
  });

  const featureHeadSha = execSync('git rev-parse HEAD', {
    cwd: workTreePath,
    encoding: 'utf-8',
  }).trim();

  return {
    bareRepoPath,
    workTreePath,
    mainHeadSha,
    featureBranchName,
    featureHeadSha,
  };
}

/**
 * Creates a NIP-34 status event (kinds 1630-1633) referencing a patch event.
 */
function createStatusEvent(
  kind: 1630 | 1631 | 1632 | 1633,
  patchEventId: string,
  repoRef: string,
  overrides: {
    secretKey?: Uint8Array;
    targetBranch?: string;
    featureBranch?: string;
  } = {}
): { event: NostrEvent; secretKey: Uint8Array; pubkey: string } {
  const secretKey = overrides.secretKey ?? generateSecretKey();
  const pubkey = getPublicKey(secretKey);

  const tags: string[][] = [
    ['e', patchEventId],
    ['a', repoRef],
    ['p', pubkey],
  ];

  if (overrides.targetBranch) {
    tags.push(['merge-target', overrides.targetBranch]);
  }
  if (overrides.featureBranch) {
    tags.push(['branch', overrides.featureBranch]);
  }

  const event = finalizeEvent(
    {
      kind,
      content: kind === STATUS_APPLIED_KIND ? 'Merged' : '',
      tags,
      created_at: Math.floor(Date.now() / 1000),
    },
    secretKey
  );

  return { event, secretKey, pubkey };
}

/**
 * Creates a mock HandlerContext.
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

describe('3.6-INT-001: PR Lifecycle via NIP-34 Status Events', () => {
  let baseDir: string;
  let workTreePaths: string[];
  let metadataStore: MetadataStore;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-pr-lifecycle-'));
    workTreePaths = [];
    metadataStore = createInMemoryMetadataStore();
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
    for (const workTree of workTreePaths) {
      fs.rmSync(workTree, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // [P0] kind:1631 (Status Applied/Merged) merges feature branch into main
  // -------------------------------------------------------------------------

  it.skip('[P0] kind:1631 merges feature branch into main via git merge', async () => {
    // Arrange
    const maintainerKey = generateSecretKey();
    const maintainerPubkey = getPublicKey(maintainerKey);
    const repoName = 'merge-test-repo';
    const ownerPrefix = maintainerPubkey.slice(0, 8);
    const repoBaseDir = path.join(baseDir, ownerPrefix);
    fs.mkdirSync(repoBaseDir, { recursive: true });

    const { bareRepoPath, workTreePath, mainHeadSha, featureBranchName } =
      createRepoWithBranches(repoBaseDir, repoName, {
        mainCommits: 2,
        featureBranch: 'feature/add-widget',
        featureCommits: 2,
      });
    workTreePaths.push(workTreePath);

    // Register repo in metadata store with maintainer
    metadataStore.storeRepo({
      name: repoName,
      description: 'Merge test repo',
      ownerPubkey: maintainerPubkey,
      ownerPrefix,
      repoPath: bareRepoPath,
      maintainers: [maintainerPubkey],
      createdAt: Math.floor(Date.now() / 1000),
    });

    // Mock a patch event ID that the status event references
    const patchEventId =
      'abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234';
    const repoRef = `${REPOSITORY_ANNOUNCEMENT_KIND}:${maintainerPubkey}:${repoName}`;

    // Register the patch in metadata so the handler can look it up
    metadataStore.storePatch({
      eventId: patchEventId,
      repoName,
      ownerPrefix,
      branch: featureBranchName,
      targetBranch: 'main',
      authorPubkey: maintainerPubkey,
    });

    // Create kind:1631 (Applied/Merged) status event from maintainer
    const { event } = createStatusEvent(
      STATUS_APPLIED_KIND,
      patchEventId,
      repoRef,
      {
        secretKey: maintainerKey,
        targetBranch: 'main',
        featureBranch: featureBranchName,
      }
    );
    const ctx = createMockHandlerContext(event);

    // Act
    await handlePrLifecycle(ctx, { repoDir: baseDir, metadataStore });

    // Assert - feature branch merged into main
    const mainLog = execSync('git log --oneline main', {
      cwd: bareRepoPath,
      env: { ...process.env, GIT_DIR: bareRepoPath },
      encoding: 'utf-8',
    });

    // Main should now contain commits from the feature branch
    expect(mainLog).toContain('Feature commit');

    // Verify a merge commit exists (or fast-forward merged)
    const mainNewSha = execSync('git rev-parse main', {
      cwd: bareRepoPath,
      env: { ...process.env, GIT_DIR: bareRepoPath },
      encoding: 'utf-8',
    }).trim();
    expect(mainNewSha).not.toBe(mainHeadSha);

    // ctx.accept() should have been called
    expect(ctx.acceptSpy).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // [P0] Merge commit attributes the merger's pubkey
  // -------------------------------------------------------------------------

  it.skip('[P0] merge commit attributes the merger pubkey as committer', async () => {
    // Arrange
    const maintainerKey = generateSecretKey();
    const maintainerPubkey = getPublicKey(maintainerKey);
    const repoName = 'merge-author-repo';
    const ownerPrefix = maintainerPubkey.slice(0, 8);
    const repoBaseDir = path.join(baseDir, ownerPrefix);
    fs.mkdirSync(repoBaseDir, { recursive: true });

    const { bareRepoPath, workTreePath, featureBranchName } =
      createRepoWithBranches(repoBaseDir, repoName, {
        featureBranch: 'feature/author-check',
        featureCommits: 1,
      });
    workTreePaths.push(workTreePath);

    metadataStore.storeRepo({
      name: repoName,
      description: 'Merge author repo',
      ownerPubkey: maintainerPubkey,
      ownerPrefix,
      repoPath: bareRepoPath,
      maintainers: [maintainerPubkey],
      createdAt: Math.floor(Date.now() / 1000),
    });

    const patchEventId =
      'ef561234ef561234ef561234ef561234ef561234ef561234ef561234ef561234';
    const repoRef = `${REPOSITORY_ANNOUNCEMENT_KIND}:${maintainerPubkey}:${repoName}`;

    metadataStore.storePatch({
      eventId: patchEventId,
      repoName,
      ownerPrefix,
      branch: featureBranchName,
      targetBranch: 'main',
      authorPubkey: getPublicKey(generateSecretKey()),
    });

    const { event } = createStatusEvent(
      STATUS_APPLIED_KIND,
      patchEventId,
      repoRef,
      {
        secretKey: maintainerKey,
        targetBranch: 'main',
        featureBranch: featureBranchName,
      }
    );
    const ctx = createMockHandlerContext(event);

    // Act
    await handlePrLifecycle(ctx, { repoDir: baseDir, metadataStore });

    // Assert - the merge commit should reference the maintainer's pubkey
    const mergeCommitAuthor = execSync('git log -1 --format=%ae main', {
      cwd: bareRepoPath,
      env: { ...process.env, GIT_DIR: bareRepoPath },
      encoding: 'utf-8',
    }).trim();

    // Author email should contain the maintainer's pubkey (or prefix)
    expect(mergeCommitAuthor).toContain(maintainerPubkey.slice(0, 16));
  });

  // -------------------------------------------------------------------------
  // [P0] Non-maintainer pubkey is rejected with F06
  // -------------------------------------------------------------------------

  it.skip('[P0] merge from non-maintainer pubkey is rejected with F06', async () => {
    // Arrange
    const maintainerKey = generateSecretKey();
    const maintainerPubkey = getPublicKey(maintainerKey);
    const unauthorizedKey = generateSecretKey();
    const repoName = 'auth-test-repo';
    const ownerPrefix = maintainerPubkey.slice(0, 8);
    const repoBaseDir = path.join(baseDir, ownerPrefix);
    fs.mkdirSync(repoBaseDir, { recursive: true });

    const { bareRepoPath, workTreePath, featureBranchName } =
      createRepoWithBranches(repoBaseDir, repoName, {
        featureBranch: 'feature/unauthorized',
      });
    workTreePaths.push(workTreePath);

    metadataStore.storeRepo({
      name: repoName,
      description: 'Auth test repo',
      ownerPubkey: maintainerPubkey,
      ownerPrefix,
      repoPath: bareRepoPath,
      maintainers: [maintainerPubkey], // Only the maintainer, not the unauthorized user
      createdAt: Math.floor(Date.now() / 1000),
    });

    const patchEventId =
      'dead1234dead1234dead1234dead1234dead1234dead1234dead1234dead1234';
    const repoRef = `${REPOSITORY_ANNOUNCEMENT_KIND}:${maintainerPubkey}:${repoName}`;

    metadataStore.storePatch({
      eventId: patchEventId,
      repoName,
      ownerPrefix,
      branch: featureBranchName,
      targetBranch: 'main',
      authorPubkey: getPublicKey(unauthorizedKey),
    });

    // Create merge event from UNAUTHORIZED user
    const { event } = createStatusEvent(
      STATUS_APPLIED_KIND,
      patchEventId,
      repoRef,
      {
        secretKey: unauthorizedKey,
        targetBranch: 'main',
        featureBranch: featureBranchName,
      }
    );
    const ctx = createMockHandlerContext(event);

    // Act
    await handlePrLifecycle(ctx, { repoDir: baseDir, metadataStore });

    // Assert
    expect(ctx.rejectSpy).toHaveBeenCalledOnce();
    expect(ctx.rejectSpy).toHaveBeenCalledWith(
      'F06',
      expect.stringContaining('nauthorized')
    );
    expect(ctx.acceptSpy).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // [P1] kind:1632 (Status Closed) marks PR as closed without merge
  // -------------------------------------------------------------------------

  it.skip('[P1] kind:1632 marks PR as closed without git merge', async () => {
    // Arrange
    const maintainerKey = generateSecretKey();
    const maintainerPubkey = getPublicKey(maintainerKey);
    const repoName = 'close-test-repo';
    const ownerPrefix = maintainerPubkey.slice(0, 8);
    const repoBaseDir = path.join(baseDir, ownerPrefix);
    fs.mkdirSync(repoBaseDir, { recursive: true });

    const { bareRepoPath, workTreePath, mainHeadSha, featureBranchName } =
      createRepoWithBranches(repoBaseDir, repoName, {
        featureBranch: 'feature/to-close',
      });
    workTreePaths.push(workTreePath);

    metadataStore.storeRepo({
      name: repoName,
      description: 'Close test repo',
      ownerPubkey: maintainerPubkey,
      ownerPrefix,
      repoPath: bareRepoPath,
      maintainers: [maintainerPubkey],
      createdAt: Math.floor(Date.now() / 1000),
    });

    const patchEventId =
      'cafe1234cafe1234cafe1234cafe1234cafe1234cafe1234cafe1234cafe1234';
    const repoRef = `${REPOSITORY_ANNOUNCEMENT_KIND}:${maintainerPubkey}:${repoName}`;

    metadataStore.storePatch({
      eventId: patchEventId,
      repoName,
      ownerPrefix,
      branch: featureBranchName,
      targetBranch: 'main',
      authorPubkey: maintainerPubkey,
    });

    const { event } = createStatusEvent(
      STATUS_CLOSED_KIND,
      patchEventId,
      repoRef,
      {
        secretKey: maintainerKey,
      }
    );
    const ctx = createMockHandlerContext(event);

    // Act
    await handlePrLifecycle(ctx, { repoDir: baseDir, metadataStore });

    // Assert - main branch unchanged (no merge)
    const currentMainSha = execSync('git rev-parse main', {
      cwd: bareRepoPath,
      env: { ...process.env, GIT_DIR: bareRepoPath },
      encoding: 'utf-8',
    }).trim();
    expect(currentMainSha).toBe(mainHeadSha);

    // PR status should be updated in metadata store
    const patchMeta = metadataStore.getPatch(patchEventId);
    expect(patchMeta).toBeDefined();
    expect(patchMeta!.status).toBe('closed');

    // ctx.accept() should still be called
    expect(ctx.acceptSpy).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // [P1] kind:1633 (Status Draft) marks PR as draft
  // -------------------------------------------------------------------------

  it.skip('[P1] kind:1633 marks PR as draft', async () => {
    // Arrange
    const maintainerKey = generateSecretKey();
    const maintainerPubkey = getPublicKey(maintainerKey);
    const repoName = 'draft-test-repo';
    const ownerPrefix = maintainerPubkey.slice(0, 8);
    const repoBaseDir = path.join(baseDir, ownerPrefix);
    fs.mkdirSync(repoBaseDir, { recursive: true });

    const { bareRepoPath, workTreePath, featureBranchName } =
      createRepoWithBranches(repoBaseDir, repoName, {
        featureBranch: 'feature/draft-pr',
      });
    workTreePaths.push(workTreePath);

    metadataStore.storeRepo({
      name: repoName,
      description: 'Draft test repo',
      ownerPubkey: maintainerPubkey,
      ownerPrefix,
      repoPath: bareRepoPath,
      maintainers: [maintainerPubkey],
      createdAt: Math.floor(Date.now() / 1000),
    });

    const patchEventId =
      'babe1234babe1234babe1234babe1234babe1234babe1234babe1234babe1234';
    const repoRef = `${REPOSITORY_ANNOUNCEMENT_KIND}:${maintainerPubkey}:${repoName}`;

    metadataStore.storePatch({
      eventId: patchEventId,
      repoName,
      ownerPrefix,
      branch: featureBranchName,
      targetBranch: 'main',
      authorPubkey: maintainerPubkey,
    });

    const { event } = createStatusEvent(
      STATUS_DRAFT_KIND,
      patchEventId,
      repoRef,
      {
        secretKey: maintainerKey,
      }
    );
    const ctx = createMockHandlerContext(event);

    // Act
    await handlePrLifecycle(ctx, { repoDir: baseDir, metadataStore });

    // Assert
    const patchMeta = metadataStore.getPatch(patchEventId);
    expect(patchMeta).toBeDefined();
    expect(patchMeta!.status).toBe('draft');
    expect(ctx.acceptSpy).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // [P1] kind:1630 (Status Open) marks PR as open
  // -------------------------------------------------------------------------

  it.skip('[P1] kind:1630 marks PR as open', async () => {
    // Arrange
    const maintainerKey = generateSecretKey();
    const maintainerPubkey = getPublicKey(maintainerKey);
    const repoName = 'open-test-repo';
    const ownerPrefix = maintainerPubkey.slice(0, 8);
    const repoBaseDir = path.join(baseDir, ownerPrefix);
    fs.mkdirSync(repoBaseDir, { recursive: true });

    const { bareRepoPath, workTreePath, featureBranchName } =
      createRepoWithBranches(repoBaseDir, repoName, {
        featureBranch: 'feature/open-pr',
      });
    workTreePaths.push(workTreePath);

    metadataStore.storeRepo({
      name: repoName,
      description: 'Open test repo',
      ownerPubkey: maintainerPubkey,
      ownerPrefix,
      repoPath: bareRepoPath,
      maintainers: [maintainerPubkey],
      createdAt: Math.floor(Date.now() / 1000),
    });

    const patchEventId =
      'face1234face1234face1234face1234face1234face1234face1234face1234';
    const repoRef = `${REPOSITORY_ANNOUNCEMENT_KIND}:${maintainerPubkey}:${repoName}`;

    metadataStore.storePatch({
      eventId: patchEventId,
      repoName,
      ownerPrefix,
      branch: featureBranchName,
      targetBranch: 'main',
      authorPubkey: maintainerPubkey,
    });

    const { event } = createStatusEvent(
      STATUS_OPEN_KIND,
      patchEventId,
      repoRef,
      {
        secretKey: maintainerKey,
      }
    );
    const ctx = createMockHandlerContext(event);

    // Act
    await handlePrLifecycle(ctx, { repoDir: baseDir, metadataStore });

    // Assert
    const patchMeta = metadataStore.getPatch(patchEventId);
    expect(patchMeta).toBeDefined();
    expect(patchMeta!.status).toBe('open');
    expect(ctx.acceptSpy).toHaveBeenCalledOnce();
  });
});
