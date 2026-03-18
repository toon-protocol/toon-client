// ATDD Red Phase - Integration tests will fail until implementation exists
// Tests: 3.11-INT-001, 3.11-INT-002, 3.11-INT-003, 3.11-INT-004

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
import request from 'supertest';
import type { Express } from 'express';

// --- Imports from @toon-protocol/rig (DOES NOT EXIST YET) ---
import { createRigApp } from '../app.js';
import { createInMemoryMetadataStore } from '../storage/metadata-store.js';
import { createMockRelayPool } from '../relay/mock-relay-pool.js';
import type { MetadataStore } from '../storage/metadata-store.js';
import type { RelayPool } from '../relay/relay-pool.js';
import type { RigAppConfig } from '../app.js';

// --- Imports from @toon-protocol/core (exists) ---
import {
  ISSUE_KIND,
  PATCH_KIND,
  STATUS_OPEN_KIND,
  STATUS_APPLIED_KIND,
  STATUS_DRAFT_KIND,
  REPOSITORY_ANNOUNCEMENT_KIND,
} from '@toon-protocol/core/nip34';

// Comment kind (not yet defined as a constant in @toon-protocol/core/nip34)
const COMMENT_KIND = 1622;

// ---------------------------------------------------------------------------
// Factory Functions
// ---------------------------------------------------------------------------

/**
 * Creates a valid NIP-34 event for testing relay integration.
 */
function createNip34Event(
  kind: number,
  overrides: {
    secretKey?: Uint8Array;
    content?: string;
    repoRef?: string;
    subject?: string;
    referencedEventId?: string;
    tags?: string[][];
    created_at?: number;
  } = {}
): { event: NostrEvent; secretKey: Uint8Array; pubkey: string } {
  const secretKey = overrides.secretKey ?? generateSecretKey();
  const pubkey = getPublicKey(secretKey);

  const tags: string[][] = overrides.tags ?? [];

  if (overrides.repoRef && !tags.some((t) => t[0] === 'a')) {
    tags.push(['a', overrides.repoRef]);
  }

  if (overrides.subject && !tags.some((t) => t[0] === 'subject')) {
    tags.push(['subject', overrides.subject]);
  }

  if (overrides.referencedEventId && !tags.some((t) => t[0] === 'e')) {
    tags.push(['e', overrides.referencedEventId]);
  }

  if (!tags.some((t) => t[0] === 'p')) {
    tags.push(['p', pubkey]);
  }

  const event = finalizeEvent(
    {
      kind,
      content: overrides.content ?? '',
      tags,
      created_at: overrides.created_at ?? Math.floor(Date.now() / 1000),
    },
    secretKey
  );

  return { event, secretKey, pubkey };
}

/**
 * Creates a bare git repo with minimal content for web UI tests.
 */
function createMinimalRepo(
  baseDir: string,
  ownerPrefix: string,
  repoName: string
): { bareRepoPath: string; workTreePath: string } {
  const ownerDir = path.join(baseDir, ownerPrefix);
  fs.mkdirSync(ownerDir, { recursive: true });

  const bareRepoPath = path.join(ownerDir, `${repoName}.git`);
  execSync(`git init --bare "${bareRepoPath}"`, { stdio: 'pipe' });

  const workTreePath = fs.mkdtempSync(
    path.join(os.tmpdir(), 'rig-relay-worktree-')
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

  fs.writeFileSync(path.join(workTreePath, 'README.md'), '# Test\n');
  execSync('git add README.md', { cwd: workTreePath, stdio: 'pipe' });
  execSync('git commit -m "Initial commit"', {
    cwd: workTreePath,
    stdio: 'pipe',
  });
  execSync('git push origin main', { cwd: workTreePath, stdio: 'pipe' });

  return { bareRepoPath, workTreePath };
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('3.11-INT: Relay Integration for Issues/PRs/Comments', () => {
  let repoDir: string;
  let workTreePaths: string[];
  let metadataStore: MetadataStore;
  let app: Express;

  const ownerKey = generateSecretKey();
  const ownerPubkey = getPublicKey(ownerKey);
  const ownerPrefix = ownerPubkey.slice(0, 8);

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-relay-int-'));
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
  // 3.11-INT-001 [P2]: Issues list from relay queries
  // =========================================================================

  describe('3.11-INT-001: Issues List from Relay', () => {
    it.skip('[P2] GET /{owner}/{repo}/issues renders issue titles from relay events', async () => {
      // Arrange
      const repoName = 'issues-test-repo';
      const { bareRepoPath, workTreePath } = createMinimalRepo(
        repoDir,
        ownerPrefix,
        repoName
      );
      workTreePaths.push(workTreePath);

      const repoRef = `${REPOSITORY_ANNOUNCEMENT_KIND}:${ownerPubkey}:${repoName}`;

      metadataStore.storeRepo({
        name: repoName,
        description: 'Issues test repo',
        ownerPubkey,
        ownerPrefix,
        repoPath: bareRepoPath,
        maintainers: [ownerPubkey],
        createdAt: Math.floor(Date.now() / 1000),
      });

      // Create mock issue events
      const { event: issue1 } = createNip34Event(ISSUE_KIND, {
        content: 'This button does not work on mobile devices.',
        repoRef,
        subject: 'Bug: Mobile button broken',
      });

      const { event: issue2 } = createNip34Event(ISSUE_KIND, {
        content: 'Would be great to have dark mode support.',
        repoRef,
        subject: 'Feature: Dark mode support',
      });

      // Create mock relay pool that returns these events
      const mockPool = createMockRelayPool([issue1, issue2]);

      const appConfig: RigAppConfig = {
        repoDir,
        metadataStore,
        relayUrl: 'ws://localhost:7100',
        relayPool: mockPool,
      };
      app = createRigApp(appConfig);

      // Act
      const response = await request(app).get(
        `/${ownerPrefix}/${repoName}/issues`
      );

      // Assert
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.text).toContain('Bug: Mobile button broken');
      expect(response.text).toContain('Feature: Dark mode support');
    });
  });

  // =========================================================================
  // 3.11-INT-002 [P2]: PR list from relay queries with status
  // =========================================================================

  describe('3.11-INT-002: PR List with Status from Relay', () => {
    it.skip('[P2] GET /{owner}/{repo}/pulls renders PRs with correct status', async () => {
      // Arrange
      const repoName = 'pulls-test-repo';
      const { bareRepoPath, workTreePath } = createMinimalRepo(
        repoDir,
        ownerPrefix,
        repoName
      );
      workTreePaths.push(workTreePath);

      const repoRef = `${REPOSITORY_ANNOUNCEMENT_KIND}:${ownerPubkey}:${repoName}`;

      metadataStore.storeRepo({
        name: repoName,
        description: 'Pulls test repo',
        ownerPubkey,
        ownerPrefix,
        repoPath: bareRepoPath,
        maintainers: [ownerPubkey],
        createdAt: Math.floor(Date.now() / 1000),
      });

      // Create patch events (PRs)
      const { event: pr1 } = createNip34Event(PATCH_KIND, {
        content: 'From abc123 Subject: [PATCH] Fix login timeout\n---\n',
        repoRef,
        subject: 'Fix login timeout',
      });

      const { event: pr2 } = createNip34Event(PATCH_KIND, {
        content: 'From def456 Subject: [PATCH] Add caching layer\n---\n',
        repoRef,
        subject: 'Add caching layer',
      });

      const { event: pr3 } = createNip34Event(PATCH_KIND, {
        content: 'From ghi789 Subject: [PATCH] WIP: Refactor auth\n---\n',
        repoRef,
        subject: 'WIP: Refactor auth',
      });

      // Create status events
      const { event: status1 } = createNip34Event(STATUS_OPEN_KIND, {
        referencedEventId: pr1.id,
        repoRef,
      });

      const { event: status2 } = createNip34Event(STATUS_APPLIED_KIND, {
        referencedEventId: pr2.id,
        repoRef,
        content: 'Merged',
      });

      const { event: status3 } = createNip34Event(STATUS_DRAFT_KIND, {
        referencedEventId: pr3.id,
        repoRef,
      });

      // Mock relay pool returns patches and status events
      const mockPool = createMockRelayPool([
        pr1,
        pr2,
        pr3,
        status1,
        status2,
        status3,
      ]);

      const appConfig: RigAppConfig = {
        repoDir,
        metadataStore,
        relayUrl: 'ws://localhost:7100',
        relayPool: mockPool,
      };
      app = createRigApp(appConfig);

      // Act
      const response = await request(app).get(
        `/${ownerPrefix}/${repoName}/pulls`
      );

      // Assert
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');

      // All PR titles should appear
      expect(response.text).toContain('Fix login timeout');
      expect(response.text).toContain('Add caching layer');
      expect(response.text).toContain('WIP: Refactor auth');

      // Status indicators should render correctly (case-insensitive match)
      const lowerText = response.text.toLowerCase();
      expect(lowerText).toContain('open');
      expect(lowerText).toMatch(/merged|applied/);
      expect(lowerText).toContain('draft');
    });
  });

  // =========================================================================
  // 3.11-INT-003 [P2]: Comment thread renders chronologically
  // =========================================================================

  describe('3.11-INT-003: Comment Thread Chronological Order', () => {
    it.skip('[P2] GET /{owner}/{repo}/issues/{id} renders comments in chronological order', async () => {
      // Arrange
      const repoName = 'comments-test-repo';
      const { bareRepoPath, workTreePath } = createMinimalRepo(
        repoDir,
        ownerPrefix,
        repoName
      );
      workTreePaths.push(workTreePath);

      const repoRef = `${REPOSITORY_ANNOUNCEMENT_KIND}:${ownerPubkey}:${repoName}`;

      metadataStore.storeRepo({
        name: repoName,
        description: 'Comments test repo',
        ownerPubkey,
        ownerPrefix,
        repoPath: bareRepoPath,
        maintainers: [ownerPubkey],
        createdAt: Math.floor(Date.now() / 1000),
      });

      // Create issue event
      const { event: issue } = createNip34Event(ISSUE_KIND, {
        content: 'This is the issue body.',
        repoRef,
        subject: 'Test issue for comments',
        created_at: 1000000,
      });

      // Create comment events with specific timestamps for ordering
      const baseTime = 1000100;

      const { event: comment1 } = createNip34Event(COMMENT_KIND, {
        content: 'First comment - earliest',
        referencedEventId: issue.id,
        repoRef,
        created_at: baseTime,
      });

      const { event: comment2 } = createNip34Event(COMMENT_KIND, {
        content: 'Second comment - middle',
        referencedEventId: issue.id,
        repoRef,
        created_at: baseTime + 100,
      });

      const { event: comment3 } = createNip34Event(COMMENT_KIND, {
        content: 'Third comment - latest',
        referencedEventId: issue.id,
        repoRef,
        created_at: baseTime + 200,
      });

      // Mock relay - return comments in scrambled order to test sorting
      const mockPool = createMockRelayPool([
        issue,
        comment3,
        comment1,
        comment2,
      ]);

      const appConfig: RigAppConfig = {
        repoDir,
        metadataStore,
        relayUrl: 'ws://localhost:7100',
        relayPool: mockPool,
      };
      app = createRigApp(appConfig);

      // Act
      const response = await request(app).get(
        `/${ownerPrefix}/${repoName}/issues/${issue.id}`
      );

      // Assert
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');

      // All comments should appear
      expect(response.text).toContain('First comment - earliest');
      expect(response.text).toContain('Second comment - middle');
      expect(response.text).toContain('Third comment - latest');

      // Verify chronological order: first comment appears before second, second before third
      const firstIdx = response.text.indexOf('First comment - earliest');
      const secondIdx = response.text.indexOf('Second comment - middle');
      const thirdIdx = response.text.indexOf('Third comment - latest');

      expect(firstIdx).toBeLessThan(secondIdx);
      expect(secondIdx).toBeLessThan(thirdIdx);
    });
  });

  // =========================================================================
  // 3.11-INT-004 [P2]: Relay unavailable -> graceful degradation
  // =========================================================================

  describe('3.11-INT-004: Relay Unavailable Graceful Degradation', () => {
    it.skip('[P2] GET /{owner}/{repo}/issues returns 200 with degradation message when relay fails', async () => {
      // Arrange
      const repoName = 'relay-fail-repo';
      const { bareRepoPath, workTreePath } = createMinimalRepo(
        repoDir,
        ownerPrefix,
        repoName
      );
      workTreePaths.push(workTreePath);

      metadataStore.storeRepo({
        name: repoName,
        description: 'Relay fail test repo',
        ownerPubkey,
        ownerPrefix,
        repoPath: bareRepoPath,
        maintainers: [ownerPubkey],
        createdAt: Math.floor(Date.now() / 1000),
      });

      // Create a mock relay pool that throws/times out
      const failingPool: RelayPool = {
        querySync: vi.fn().mockRejectedValue(new Error('Connection timeout')),
        subscribeMany: vi.fn().mockImplementation(() => {
          throw new Error('Connection refused');
        }),
        close: vi.fn(),
      };

      const appConfig: RigAppConfig = {
        repoDir,
        metadataStore,
        relayUrl: 'ws://localhost:7100',
        relayPool: failingPool as unknown as RelayPool,
      };
      app = createRigApp(appConfig);

      // Act
      const response = await request(app).get(
        `/${ownerPrefix}/${repoName}/issues`
      );

      // Assert - page should still render (not crash)
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');

      // Should contain a graceful degradation message
      const lowerText = response.text.toLowerCase();
      expect(lowerText).toMatch(
        /relay.*unavailable|unable.*relay|no.*connection/
      );
    });

    it.skip('[P2] GET /{owner}/{repo}/pulls returns 200 with degradation message when relay fails', async () => {
      // Arrange
      const repoName = 'relay-fail-pulls-repo';
      const { bareRepoPath, workTreePath } = createMinimalRepo(
        repoDir,
        ownerPrefix,
        repoName
      );
      workTreePaths.push(workTreePath);

      metadataStore.storeRepo({
        name: repoName,
        description: 'Relay fail pulls test repo',
        ownerPubkey,
        ownerPrefix,
        repoPath: bareRepoPath,
        maintainers: [ownerPubkey],
        createdAt: Math.floor(Date.now() / 1000),
      });

      const failingPool: RelayPool = {
        querySync: vi.fn().mockRejectedValue(new Error('Connection timeout')),
        subscribeMany: vi.fn().mockImplementation(() => {
          throw new Error('Connection refused');
        }),
        close: vi.fn(),
      };

      const appConfig: RigAppConfig = {
        repoDir,
        metadataStore,
        relayUrl: 'ws://localhost:7100',
        relayPool: failingPool as unknown as RelayPool,
      };
      app = createRigApp(appConfig);

      // Act
      const response = await request(app).get(
        `/${ownerPrefix}/${repoName}/pulls`
      );

      // Assert - page should still render (not crash)
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
      const lowerText = response.text.toLowerCase();
      expect(lowerText).toMatch(
        /relay.*unavailable|unable.*relay|no.*connection/
      );
    });
  });
});
