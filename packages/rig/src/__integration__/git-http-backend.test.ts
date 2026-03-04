// ATDD Red Phase - Integration tests will fail until implementation exists
// Tests: 3.4-INT-001, 3.4-INT-002, 3.4-INT-003

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import request from 'supertest';
import type { Express } from 'express';

// --- Imports from @crosstown/rig (DOES NOT EXIST YET) ---
import { createRigApp } from '../app.js';
import { createInMemoryMetadataStore } from '../storage/metadata-store.js';
import type { MetadataStore } from '../storage/metadata-store.js';
import type { RigAppConfig } from '../app.js';

// ---------------------------------------------------------------------------
// Factory Functions
// ---------------------------------------------------------------------------

/**
 * Creates a bare git repo with an initial commit and returns repo metadata.
 */
function createGitRepoWithCommit(
  baseDir: string,
  ownerPrefix: string,
  repoName: string
): {
  bareRepoPath: string;
  workTreePath: string;
  commitSha: string;
} {
  const ownerDir = path.join(baseDir, ownerPrefix);
  fs.mkdirSync(ownerDir, { recursive: true });

  const bareRepoPath = path.join(ownerDir, `${repoName}.git`);
  execSync(`git init --bare "${bareRepoPath}"`, { stdio: 'pipe' });

  // Clone to worktree for committing
  const workTreePath = fs.mkdtempSync(
    path.join(os.tmpdir(), 'rig-http-worktree-')
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

  // Create initial commit
  fs.writeFileSync(path.join(workTreePath, 'README.md'), '# Test Repository\n');
  execSync('git add README.md', { cwd: workTreePath, stdio: 'pipe' });
  execSync('git commit -m "Initial commit"', {
    cwd: workTreePath,
    stdio: 'pipe',
  });
  execSync('git push origin main', { cwd: workTreePath, stdio: 'pipe' });

  const commitSha = execSync('git rev-parse HEAD', {
    cwd: workTreePath,
    encoding: 'utf-8',
  }).trim();

  return { bareRepoPath, workTreePath, commitSha };
}

/**
 * Creates a configured Rig Express app for testing.
 */
function createTestRigApp(config: {
  repoDir: string;
  metadataStore: MetadataStore;
}): Express {
  const appConfig: RigAppConfig = {
    repoDir: config.repoDir,
    metadataStore: config.metadataStore,
    relayUrl: 'ws://localhost:7100', // Not used in HTTP backend tests
  };
  return createRigApp(appConfig);
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('3.4-INT: Git HTTP Backend for Clone and Fetch', () => {
  let repoDir: string;
  let workTreePaths: string[];
  let metadataStore: MetadataStore;
  let app: Express;

  const ownerKey = generateSecretKey();
  const ownerPubkey = getPublicKey(ownerKey);
  const ownerPrefix = ownerPubkey.slice(0, 8);

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-http-test-'));
    workTreePaths = [];
    metadataStore = createInMemoryMetadataStore();
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
    for (const workTree of workTreePaths) {
      fs.rmSync(workTree, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // 3.4-INT-001 [P1]: Clone via HTTP (git-upload-pack)
  // -------------------------------------------------------------------------

  it.skip('[P1] 3.4-INT-001: GET info/refs?service=git-upload-pack returns 200 with smart HTTP headers', async () => {
    // Arrange
    const repoName = 'clone-test';
    const { bareRepoPath, workTreePath, commitSha } = createGitRepoWithCommit(
      repoDir,
      ownerPrefix,
      repoName
    );
    workTreePaths.push(workTreePath);

    metadataStore.storeRepo({
      name: repoName,
      description: 'Clone test repo',
      ownerPubkey,
      ownerPrefix,
      repoPath: bareRepoPath,
      maintainers: [ownerPubkey],
      createdAt: Math.floor(Date.now() / 1000),
    });

    app = createTestRigApp({ repoDir, metadataStore });

    // Act
    const response = await request(app)
      .get(`/${ownerPrefix}/${repoName}.git/info/refs`)
      .query({ service: 'git-upload-pack' });

    // Assert
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain(
      'application/x-git-upload-pack-advertisement'
    );

    // Response body should contain refs
    const body = response.text ?? response.body.toString();
    expect(body).toContain('refs/heads/main');
    expect(body).toContain(commitSha);
  });

  // -------------------------------------------------------------------------
  // 3.4-INT-002 [P1]: Fetch returns updated refs
  // -------------------------------------------------------------------------

  it.skip('[P1] 3.4-INT-002: fetch returns updated refs after new commit', async () => {
    // Arrange
    const repoName = 'fetch-test';
    const {
      bareRepoPath,
      workTreePath,
      commitSha: initialSha,
    } = createGitRepoWithCommit(repoDir, ownerPrefix, repoName);
    workTreePaths.push(workTreePath);

    metadataStore.storeRepo({
      name: repoName,
      description: 'Fetch test repo',
      ownerPubkey,
      ownerPrefix,
      repoPath: bareRepoPath,
      maintainers: [ownerPubkey],
      createdAt: Math.floor(Date.now() / 1000),
    });

    // Add a new commit
    fs.writeFileSync(path.join(workTreePath, 'new-file.txt'), 'New content\n');
    execSync('git add new-file.txt', { cwd: workTreePath, stdio: 'pipe' });
    execSync('git commit -m "Add new file"', {
      cwd: workTreePath,
      stdio: 'pipe',
    });
    execSync('git push origin main', { cwd: workTreePath, stdio: 'pipe' });

    const newSha = execSync('git rev-parse HEAD', {
      cwd: workTreePath,
      encoding: 'utf-8',
    }).trim();

    app = createTestRigApp({ repoDir, metadataStore });

    // Act
    const response = await request(app)
      .get(`/${ownerPrefix}/${repoName}.git/info/refs`)
      .query({ service: 'git-upload-pack' });

    // Assert
    expect(response.status).toBe(200);
    const body = response.text ?? response.body.toString();

    // Should contain the NEW commit SHA, not just the old one
    expect(body).toContain(newSha);
    // Old SHA should no longer be the HEAD ref
    expect(body).not.toMatch(new RegExp(`${initialSha}\\s+HEAD`));
  });

  // -------------------------------------------------------------------------
  // 3.4-INT-003 [P3]: 404 for clone/fetch non-existent repo
  // -------------------------------------------------------------------------

  it.skip('[P3] 3.4-INT-003: 404 for clone/fetch of non-existent repository', async () => {
    // Arrange
    app = createTestRigApp({ repoDir, metadataStore });

    // Act
    const response = await request(app)
      .get('/nonexistent-owner/nonexistent-repo.git/info/refs')
      .query({ service: 'git-upload-pack' });

    // Assert
    expect(response.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // [P1] git-receive-pack (push) is rejected
  // -------------------------------------------------------------------------

  it.skip('[P1] git-receive-pack (push) is rejected since writes go through ILP', async () => {
    // Arrange
    const repoName = 'push-reject-test';
    const { bareRepoPath, workTreePath } = createGitRepoWithCommit(
      repoDir,
      ownerPrefix,
      repoName
    );
    workTreePaths.push(workTreePath);

    metadataStore.storeRepo({
      name: repoName,
      description: 'Push reject test repo',
      ownerPubkey,
      ownerPrefix,
      repoPath: bareRepoPath,
      maintainers: [ownerPubkey],
      createdAt: Math.floor(Date.now() / 1000),
    });

    app = createTestRigApp({ repoDir, metadataStore });

    // Act - attempt push via HTTP
    const response = await request(app)
      .get(`/${ownerPrefix}/${repoName}.git/info/refs`)
      .query({ service: 'git-receive-pack' });

    // Assert - push should be forbidden
    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});
