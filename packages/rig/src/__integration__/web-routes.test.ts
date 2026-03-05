// ATDD Red Phase - Integration tests will fail until implementation exists
// Tests: 3.7-INT-001, 3.8-INT-001, 3.8-INT-002, 3.9-INT-001, 3.9-INT-002, 3.10-INT-001

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
 * Creates a git repo with the specified files committed.
 * Returns bare repo path and worktree path for further operations.
 */
function createGitRepoWithFiles(
  baseDir: string,
  ownerPrefix: string,
  repoName: string,
  files: Record<string, string>
): {
  bareRepoPath: string;
  workTreePath: string;
  commitShas: string[];
} {
  const ownerDir = path.join(baseDir, ownerPrefix);
  fs.mkdirSync(ownerDir, { recursive: true });

  const bareRepoPath = path.join(ownerDir, `${repoName}.git`);
  execSync(`git init --bare "${bareRepoPath}"`, { stdio: 'pipe' });

  const workTreePath = fs.mkdtempSync(
    path.join(os.tmpdir(), 'rig-web-worktree-')
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

  const commitShas: string[] = [];

  // Create all files and commit them
  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = path.join(workTreePath, filePath);
    const dir = path.dirname(fullPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fullPath, content);
  }

  execSync('git add -A', { cwd: workTreePath, stdio: 'pipe' });
  execSync('git commit -m "Add initial files"', {
    cwd: workTreePath,
    stdio: 'pipe',
  });
  execSync('git push origin main', { cwd: workTreePath, stdio: 'pipe' });

  const sha = execSync('git rev-parse HEAD', {
    cwd: workTreePath,
    encoding: 'utf-8',
  }).trim();
  commitShas.push(sha);

  return { bareRepoPath, workTreePath, commitShas };
}

/**
 * Adds a commit to an existing worktree and pushes to bare repo.
 * Returns the new commit SHA.
 */
function addCommitToRepo(
  workTreePath: string,
  changes: { filename: string; content: string; commitMessage: string }
): string {
  const fullPath = path.join(workTreePath, changes.filename);
  const dir = path.dirname(fullPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fullPath, changes.content);
  execSync(`git add "${changes.filename}"`, {
    cwd: workTreePath,
    stdio: 'pipe',
  });
  execSync(`git commit -m "${changes.commitMessage}"`, {
    cwd: workTreePath,
    stdio: 'pipe',
  });
  execSync('git push origin main', { cwd: workTreePath, stdio: 'pipe' });

  return execSync('git rev-parse HEAD', {
    cwd: workTreePath,
    encoding: 'utf-8',
  }).trim();
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
    relayUrl: 'ws://localhost:7100',
  };
  return createRigApp(appConfig);
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('Web Route Integration Tests', () => {
  let repoDir: string;
  let workTreePaths: string[];
  let metadataStore: MetadataStore;
  let app: Express;

  const ownerKey = generateSecretKey();
  const ownerPubkey = getPublicKey(ownerKey);
  const ownerPrefix = ownerPubkey.slice(0, 8);

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-web-test-'));
    workTreePaths = [];
    metadataStore = createInMemoryMetadataStore();
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
    for (const workTree of workTreePaths) {
      fs.rmSync(workTree, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // 3.7-INT-001 [P1]: Repository list page renders
  // =========================================================================

  describe('3.7-INT-001: Repository List Page', () => {
    it.skip('[P1] GET / returns 200 with HTML containing repository names', async () => {
      // Arrange - create 2 repos in metadata store
      const repo1Name = 'alpha-project';
      const repo2Name = 'beta-service';

      const { bareRepoPath: repo1Path, workTreePath: wt1 } =
        createGitRepoWithFiles(repoDir, ownerPrefix, repo1Name, {
          'README.md': '# Alpha Project\n',
        });
      workTreePaths.push(wt1);

      const { bareRepoPath: repo2Path, workTreePath: wt2 } =
        createGitRepoWithFiles(repoDir, ownerPrefix, repo2Name, {
          'README.md': '# Beta Service\n',
        });
      workTreePaths.push(wt2);

      metadataStore.storeRepo({
        name: repo1Name,
        description: 'The Alpha project',
        ownerPubkey,
        ownerPrefix,
        repoPath: repo1Path,
        maintainers: [ownerPubkey],
        createdAt: Math.floor(Date.now() / 1000),
      });

      metadataStore.storeRepo({
        name: repo2Name,
        description: 'The Beta service',
        ownerPubkey,
        ownerPrefix,
        repoPath: repo2Path,
        maintainers: [ownerPubkey],
        createdAt: Math.floor(Date.now() / 1000),
      });

      app = createTestRigApp({ repoDir, metadataStore });

      // Act
      const response = await request(app).get('/');

      // Assert
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.text).toContain(repo1Name);
      expect(response.text).toContain(repo2Name);
      expect(response.text).toContain('The Alpha project');
      expect(response.text).toContain('The Beta service');
    });
  });

  // =========================================================================
  // 3.8-INT-001 [P1]: File tree renders from git ls-tree
  // =========================================================================

  describe('3.8-INT-001: File Tree View', () => {
    it.skip('[P1] GET /{owner}/{repo} returns 200 with file tree HTML', async () => {
      // Arrange
      const repoName = 'tree-view-repo';
      const { bareRepoPath, workTreePath } = createGitRepoWithFiles(
        repoDir,
        ownerPrefix,
        repoName,
        {
          'README.md': '# Tree View Test\n',
          'src/index.ts': 'console.log("hello");\n',
          'src/utils/helpers.ts': 'export const help = () => {};\n',
        }
      );
      workTreePaths.push(workTreePath);

      metadataStore.storeRepo({
        name: repoName,
        description: 'Tree view repo',
        ownerPubkey,
        ownerPrefix,
        repoPath: bareRepoPath,
        maintainers: [ownerPubkey],
        createdAt: Math.floor(Date.now() / 1000),
      });

      app = createTestRigApp({ repoDir, metadataStore });

      // Act
      const response = await request(app).get(`/${ownerPrefix}/${repoName}`);

      // Assert
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
      // Should show directory and files
      expect(response.text).toContain('src');
      expect(response.text).toContain('README.md');
    });
  });

  // =========================================================================
  // 3.8-INT-002 [P1]: Blob view renders file content
  // =========================================================================

  describe('3.8-INT-002: Blob View', () => {
    it.skip('[P1] GET /{owner}/{repo}/blob/main/{path} returns file content', async () => {
      // Arrange
      const repoName = 'blob-view-repo';
      const fileContent = 'Hello World from Crosstown Rig!';
      const { bareRepoPath, workTreePath } = createGitRepoWithFiles(
        repoDir,
        ownerPrefix,
        repoName,
        { 'README.md': fileContent }
      );
      workTreePaths.push(workTreePath);

      metadataStore.storeRepo({
        name: repoName,
        description: 'Blob view repo',
        ownerPubkey,
        ownerPrefix,
        repoPath: bareRepoPath,
        maintainers: [ownerPubkey],
        createdAt: Math.floor(Date.now() / 1000),
      });

      app = createTestRigApp({ repoDir, metadataStore });

      // Act
      const response = await request(app).get(
        `/${ownerPrefix}/${repoName}/blob/main/README.md`
      );

      // Assert
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.text).toContain('Hello World from Crosstown Rig!');
    });
  });

  // =========================================================================
  // 3.9-INT-001 [P1]: Commit log renders from git log
  // =========================================================================

  describe('3.9-INT-001: Commit Log View', () => {
    it.skip('[P1] GET /{owner}/{repo}/commits returns HTML with commit messages', async () => {
      // Arrange - create repo with 3 commits
      const repoName = 'commit-log-repo';
      const { bareRepoPath, workTreePath } = createGitRepoWithFiles(
        repoDir,
        ownerPrefix,
        repoName,
        { 'README.md': '# Commit Log Test\n' }
      );
      workTreePaths.push(workTreePath);

      // Add 2 more commits
      addCommitToRepo(workTreePath, {
        filename: 'feature-a.ts',
        content: 'export const featureA = true;\n',
        commitMessage: 'Add feature A implementation',
      });

      addCommitToRepo(workTreePath, {
        filename: 'feature-b.ts',
        content: 'export const featureB = true;\n',
        commitMessage: 'Add feature B implementation',
      });

      metadataStore.storeRepo({
        name: repoName,
        description: 'Commit log repo',
        ownerPubkey,
        ownerPrefix,
        repoPath: bareRepoPath,
        maintainers: [ownerPubkey],
        createdAt: Math.floor(Date.now() / 1000),
      });

      app = createTestRigApp({ repoDir, metadataStore });

      // Act
      const response = await request(app).get(
        `/${ownerPrefix}/${repoName}/commits`
      );

      // Assert
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.text).toContain('Add initial files');
      expect(response.text).toContain('Add feature A implementation');
      expect(response.text).toContain('Add feature B implementation');
    });
  });

  // =========================================================================
  // 3.9-INT-002 [P1]: Commit diff renders from git diff
  // =========================================================================

  describe('3.9-INT-002: Commit Diff View', () => {
    it.skip('[P1] GET /{owner}/{repo}/commit/{sha} returns diff HTML', async () => {
      // Arrange - create repo and then modify a file
      const repoName = 'diff-view-repo';
      const { bareRepoPath, workTreePath } = createGitRepoWithFiles(
        repoDir,
        ownerPrefix,
        repoName,
        { 'data.txt': 'original content\nline two\nline three\n' }
      );
      workTreePaths.push(workTreePath);

      // Modify the file in second commit
      const commitSha = addCommitToRepo(workTreePath, {
        filename: 'data.txt',
        content:
          'modified content\nline two\nnew line three\nadded line four\n',
        commitMessage: 'Modify data.txt with changes',
      });

      metadataStore.storeRepo({
        name: repoName,
        description: 'Diff view repo',
        ownerPubkey,
        ownerPrefix,
        repoPath: bareRepoPath,
        maintainers: [ownerPubkey],
        createdAt: Math.floor(Date.now() / 1000),
      });

      app = createTestRigApp({ repoDir, metadataStore });

      // Act
      const response = await request(app).get(
        `/${ownerPrefix}/${repoName}/commit/${commitSha}`
      );

      // Assert
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
      // Response should contain diff markers (additions/deletions)
      expect(response.text).toMatch(/[+-].*content/);
      expect(response.text).toContain('Modify data.txt with changes');
    });
  });

  // =========================================================================
  // 3.10-INT-001 [P2]: Blame view renders from git blame
  // =========================================================================

  describe('3.10-INT-001: Blame View', () => {
    it.skip('[P2] GET /{owner}/{repo}/blame/main/{path} returns blame HTML', async () => {
      // Arrange - create a file, then modify it in a second commit
      const repoName = 'blame-view-repo';
      const { bareRepoPath, workTreePath, commitShas } = createGitRepoWithFiles(
        repoDir,
        ownerPrefix,
        repoName,
        {
          'src/module.ts':
            'line one from first commit\nline two from first commit\n',
        }
      );
      workTreePaths.push(workTreePath);

      // Modify file in second commit (only change line 2)
      const secondSha = addCommitToRepo(workTreePath, {
        filename: 'src/module.ts',
        content:
          'line one from first commit\nline two modified in second commit\n',
        commitMessage: 'Update module line 2',
      });

      metadataStore.storeRepo({
        name: repoName,
        description: 'Blame view repo',
        ownerPubkey,
        ownerPrefix,
        repoPath: bareRepoPath,
        maintainers: [ownerPubkey],
        createdAt: Math.floor(Date.now() / 1000),
      });

      app = createTestRigApp({ repoDir, metadataStore });

      // Act
      const response = await request(app).get(
        `/${ownerPrefix}/${repoName}/blame/main/src/module.ts`
      );

      // Assert
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');

      // Should contain blame info from both commits
      const firstCommitSha = commitShas[0]!;
      expect(response.text).toContain(firstCommitSha.slice(0, 7)); // abbreviated SHA from first commit
      expect(response.text).toContain(secondSha.slice(0, 7)); // abbreviated SHA from second commit

      // Should contain the file content
      expect(response.text).toContain('line one from first commit');
      expect(response.text).toContain('line two modified in second commit');
    });
  });
});
