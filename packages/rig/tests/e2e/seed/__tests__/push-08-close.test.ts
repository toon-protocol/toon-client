/**
 * ATDD Tests: Story 10.8 -- Seed Script: Merge PR & Close Issue (Push 8)
 *
 * Unit tests verify push-08-close.ts publishes kind:1632 (Closed) for Issue #2,
 * asserts PR #1 already has kind:1631 (Applied/Merged) from Push 06,
 * single-client signing (Alice only), state passthrough from Push07State,
 * and the "no new git objects" constraint.
 * Integration tests (.todo) require live relay infrastructure.
 *
 * AC-8.1: seed/push-08-close.ts publishes kind:1632 (Closed) for Issue #2
 * AC-8.2: Verifies PR #1 already has kind:1631 from Push 6 (assertion only)
 * AC-8.3: All events signed by appropriate authors (Alice signs close event)
 * AC-8.4: Push08State extends Push07State with closedIssueEventIds: string[]
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('Story 10.8: Push 08 -- Merge PR & Close Issue', () => {
  // -------------------------------------------------------------------------
  // AC-8.4: Module exports and structure
  // -------------------------------------------------------------------------

  it('[P0] should export runPush08 function', async () => {
    const push08 = await import('../push-08-close.js');
    expect(typeof push08.runPush08).toBe('function');
  });

  it('[P0] should accept 3 parameters (aliceClient, aliceSecretKey, push07State)', async () => {
    const push08 = await import('../push-08-close.js');
    // runPush08 should accept at least 3 parameters
    expect(push08.runPush08.length).toBeGreaterThanOrEqual(3);
  });

  it('[P0] should export Push08State type (verified by compilation)', async () => {
    const push08 = await import('../push-08-close.js');
    expect(push08).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // AC-8.1: buildStatus for Issue #2 close produces kind:1632 with correct tags
  // -------------------------------------------------------------------------

  it('[P0] AC-8.1: buildStatus for Issue #2 close produces kind:1632 with correct e tag and p tag', async () => {
    const { buildStatus } = await import('../lib/event-builders.js');

    const issueEventId = 'e'.repeat(64);
    const issueAuthorPubkey = 'b'.repeat(64);

    const event = buildStatus(issueEventId, 1632, issueAuthorPubkey);

    // kind:1632 (Closed)
    expect(event.kind).toBe(1632);

    // e tag references the issue event
    const eTag = event.tags.find((t) => t[0] === 'e');
    expect(eTag).toBeDefined();
    expect(eTag![1]).toBe(issueEventId);

    // p tag references the issue author pubkey
    const pTag = event.tags.find((t) => t[0] === 'p');
    expect(pTag).toBeDefined();
    expect(pTag![1]).toBe(issueAuthorPubkey);

    // content is empty for status events
    expect(event.content).toBe('');
  });

  // -------------------------------------------------------------------------
  // AC-8.4: Push08State.closedIssueEventIds has exactly 1 entry
  // -------------------------------------------------------------------------

  it('[P0] AC-8.4: Push08State interface declares closedIssueEventIds field as string[]', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'push-08-close.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    // Verify Push08State interface is exported
    expect(source).toContain('export interface Push08State');

    const start = source.indexOf('export interface Push08State');
    expect(start).toBeGreaterThan(-1);
    const interfaceBlock = source.slice(start, start + 800);

    // New field: closedIssueEventIds
    expect(interfaceBlock).toContain('closedIssueEventIds: string[]');
  });

  it('[P0] AC-8.4: return statement includes closedIssueEventIds with exactly 1 entry', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'push-08-close.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    // Find the return statement
    const returnIdx = source.lastIndexOf('return {');
    expect(returnIdx).toBeGreaterThan(-1);
    const returnSection = source.slice(returnIdx);

    // closedIssueEventIds should contain exactly 1 element
    expect(returnSection).toContain('closedIssueEventIds:');
    // The array should have a single close event ID reference
    const closedMatch = returnSection.match(/closedIssueEventIds:\s*\[([^\]]*)\]/);
    expect(closedMatch).not.toBeNull();
    // Should contain exactly 1 comma-separated item (no commas = 1 item)
    const items = closedMatch![1]!.split(',').filter((s) => s.trim().length > 0);
    expect(items).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // AC-8.4: Push08State passes through all Push07State fields unchanged
  // -------------------------------------------------------------------------

  it('[P0] AC-8.4: Push08State passes through all Push07State fields unchanged', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'push-08-close.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    // Verify the return statement references all passthrough fields from push07State
    expect(source).toContain('push07State.repoId');
    expect(source).toContain('push07State.ownerPubkey');
    expect(source).toContain('push07State.commits');
    expect(source).toContain('push07State.shaMap');
    expect(source).toContain('push07State.repoAnnouncementId');
    expect(source).toContain('push07State.refsEventId');
    expect(source).toContain('push07State.branches');
    expect(source).toContain('push07State.tags');
    expect(source).toContain('push07State.files');
    expect(source).toContain('push07State.prs');
    expect(source).toContain('push07State.issues');
    expect(source).toContain('push07State.comments');
  });

  // -------------------------------------------------------------------------
  // No new git objects -- shaMap unchanged, commits unchanged, files unchanged
  // -------------------------------------------------------------------------

  it('[P0] AC-8.4: no new git objects created -- commits passthrough, shaMap passthrough, files passthrough', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'push-08-close.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    // Verify commits are passed through from push07State (not rebuilt or modified)
    expect(source).toContain('commits: push07State.commits');

    // Verify shaMap is passed through
    expect(source).toContain('shaMap: push07State.shaMap');

    // Verify files are passed through
    expect(source).toContain('files: push07State.files');
  });

  // -------------------------------------------------------------------------
  // AC-8.4: prs array unchanged from Push07State
  // -------------------------------------------------------------------------

  it('[P0] AC-8.4: Push08State.prs array unchanged from Push07State input', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'push-08-close.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    // prs are passed through unchanged
    expect(source).toContain('prs: push07State.prs');
  });

  // -------------------------------------------------------------------------
  // Source does NOT import git builder functions
  // -------------------------------------------------------------------------

  it('[P1] push-08-close.ts source does NOT import createGitBlob, createGitTree, createGitCommit, uploadGitObject, or signBalanceProof', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'push-08-close.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    expect(source).not.toContain('createGitBlob');
    expect(source).not.toContain('createGitTree');
    expect(source).not.toContain('createGitCommit');
    expect(source).not.toContain('uploadGitObject');
    expect(source).not.toContain('signBalanceProof');
    expect(source).not.toContain('git-builder');
  });

  // -------------------------------------------------------------------------
  // AC-8.2: runPush08 throws when PR #1 statusKind !== 1631
  // -------------------------------------------------------------------------

  it('[P0] AC-8.2: source verifies PR #1 has statusKind 1631 and throws descriptive error if not', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'push-08-close.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    // Verify the source checks prs[0].statusKind against 1631
    expect(source).toContain('prs[0]');
    expect(source).toContain('statusKind');
    expect(source).toContain('1631');

    // Verify a throw/error path exists for the verification
    expect(source).toContain('throw new Error');
    // Error message should reference PR #1 and kind:1631
    const throwIdx = source.indexOf('throw new Error');
    expect(throwIdx).toBeGreaterThan(-1);
    const errorSection = source.slice(throwIdx, throwIdx + 200);
    expect(errorSection).toContain('1631');
  });

  // -------------------------------------------------------------------------
  // AC-8.3: Alice signs the close event
  // -------------------------------------------------------------------------

  it('[P0] AC-8.3: close event is signed with aliceSecretKey and published via aliceClient', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'push-08-close.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    // finalizeEvent used for signing
    expect(source).toContain('finalizeEvent');
    // Signed with aliceSecretKey
    expect(source).toContain('aliceSecretKey');
    // Published via aliceClient
    expect(source).toContain('aliceClient');

    // Verify the close event is signed with aliceSecretKey specifically
    const buildStatusIdx = source.indexOf('buildStatus');
    expect(buildStatusIdx).toBeGreaterThan(-1);
    const afterBuildStatus = source.slice(buildStatusIdx, buildStatusIdx + 500);
    expect(afterBuildStatus).toContain('aliceSecretKey');
  });

  // -------------------------------------------------------------------------
  // AC-8.1: Exactly 1 publishWithRetry call
  // -------------------------------------------------------------------------

  it('[P0] AC-8.1: exactly 1 publishWithRetry call in source (1 close status event)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'push-08-close.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    const publishCalls = source.match(/publishWithRetry\(/g);
    expect(publishCalls).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Push08State interface has correct shape
  // -------------------------------------------------------------------------

  it('[P1] Push08State interface includes closedIssueEventIds alongside all Push07State fields', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'push-08-close.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    // Verify Push08State interface is exported
    expect(source).toContain('export interface Push08State');

    const start = source.indexOf('export interface Push08State');
    expect(start).toBeGreaterThan(-1);
    const interfaceBlock = source.slice(start, start + 800);

    // All Push07State fields present
    expect(interfaceBlock).toContain('repoId: string');
    expect(interfaceBlock).toContain('ownerPubkey: string');
    expect(interfaceBlock).toContain('commits:');
    expect(interfaceBlock).toContain('shaMap:');
    expect(interfaceBlock).toContain('repoAnnouncementId: string');
    expect(interfaceBlock).toContain('refsEventId: string');
    expect(interfaceBlock).toContain('branches: string[]');
    expect(interfaceBlock).toContain('tags: string[]');
    expect(interfaceBlock).toContain('files: string[]');
    expect(interfaceBlock).toContain('prs:');
    expect(interfaceBlock).toContain('issues:');
    expect(interfaceBlock).toContain('comments:');

    // New Push08State field
    expect(interfaceBlock).toContain('closedIssueEventIds: string[]');
  });

  // -------------------------------------------------------------------------
  // Source imports Push07State from push-07-issues.js
  // -------------------------------------------------------------------------

  it('[P1] source imports Push07State from push-07-issues.js', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'push-08-close.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    expect(source).toContain('Push07State');
    expect(source).toContain('push-07-issues.js');
  });

  // -------------------------------------------------------------------------
  // Event ID derivation uses fallback pattern
  // -------------------------------------------------------------------------

  it('[P1] event ID derivation uses result.eventId ?? signed.id fallback pattern', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'push-08-close.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    // Verify the eventId ?? signed.id fallback pattern is used
    const fallbackPattern = /\.eventId \?\?.*\.id/;
    expect(fallbackPattern.test(source)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Single-client module -- only uses aliceClient, no bobClient/charlieClient
  // -------------------------------------------------------------------------

  it('[P1] source uses only aliceClient (single-client module, no bobClient or charlieClient)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'push-08-close.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    // Only aliceClient used
    expect(source).toContain('aliceClient');
    // No bob or charlie clients
    expect(source).not.toContain('bobClient');
    expect(source).not.toContain('charlieClient');
    expect(source).not.toContain('bobSecretKey');
    expect(source).not.toContain('charlieSecretKey');
  });

  // -------------------------------------------------------------------------
  // Module does NOT re-export git builder functions
  // -------------------------------------------------------------------------

  it('[P1] module does NOT export git object creation functions', async () => {
    const push08 = await import('../push-08-close.js');
    const exportKeys = Object.keys(push08);

    expect(exportKeys).not.toContain('createGitBlob');
    expect(exportKeys).not.toContain('createGitTree');
    expect(exportKeys).not.toContain('createGitCommit');
    expect(exportKeys).not.toContain('uploadGitObject');

    // Should export runPush08
    expect(exportKeys).toContain('runPush08');
  });

  // -------------------------------------------------------------------------
  // AC-8.1: Close event references Issue #2 specifically (issues[1])
  // -------------------------------------------------------------------------

  it('[P0] AC-8.1: source references push07State.issues[1] for close event (Issue #2)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'push-08-close.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    // Verify the source references issues[1] (Issue #2) for the close event
    expect(source).toContain('issues[1]');
    // Verify buildStatus is called with 1632 (Closed)
    expect(source).toContain('buildStatus');
    expect(source).toContain('1632');
  });

  // -------------------------------------------------------------------------
  // Module does NOT import buildIssue, buildComment, buildPatch, REPO_ID, AGENT_IDENTITIES
  // -------------------------------------------------------------------------

  it('[P1] module does NOT import buildIssue, buildComment, buildPatch, REPO_ID, or AGENT_IDENTITIES', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'push-08-close.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    expect(source).not.toContain('buildIssue');
    expect(source).not.toContain('buildComment');
    expect(source).not.toContain('buildPatch');
    expect(source).not.toContain('REPO_ID');
    expect(source).not.toContain('AGENT_IDENTITIES');
  });

  // -------------------------------------------------------------------------
  // issues and comments arrays passed through unchanged
  // -------------------------------------------------------------------------

  it('[P0] AC-8.4: issues and comments arrays passed through unchanged from Push07State', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'push-08-close.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    expect(source).toContain('issues: push07State.issues');
    expect(source).toContain('comments: push07State.comments');
  });

  // -------------------------------------------------------------------------
  // BEHAVIORAL TESTS: runPush08 with mocked dependencies
  // -------------------------------------------------------------------------

  describe('Behavioral: runPush08 with mocked dependencies', () => {
    // Mock Push07State used across behavioral tests
    const mockPush07State = {
      repoId: 'test-repo-id',
      ownerPubkey: 'a'.repeat(64),
      commits: [
        { sha: 'abc123', txId: 'tx1', message: 'init' },
        { sha: 'abc456', txId: 'tx2', message: 'nested' },
        { sha: 'abc789', txId: 'tx3', message: 'branch' },
        { sha: 'abcdef', txId: 'tx4', message: 'work' },
      ],
      shaMap: { abc123: 'tx1', abc456: 'tx2', abc789: 'tx3', abcdef: 'tx4', blob1: 'tx5' } as Record<string, string>,
      repoAnnouncementId: 'repo-ann-id',
      refsEventId: 'refs-event-id',
      branches: ['main', 'feature/add-retry'],
      tags: ['v1.0.0'],
      files: ['README.md', 'src/index.ts', 'src/lib/utils.ts'],
      prs: [
        { eventId: 'pr1-event-id', title: 'PR #1', authorPubkey: 'b'.repeat(64), statusKind: 1631 as const },
        { eventId: 'pr2-event-id', title: 'PR #2', authorPubkey: 'c'.repeat(64), statusKind: 1630 as const },
      ],
      issues: [
        { eventId: 'issue1-event-id', title: 'Issue #1', authorPubkey: 'a'.repeat(64), labels: ['enhancement', 'networking'] },
        { eventId: 'issue2-event-id', title: 'Issue #2', authorPubkey: 'b'.repeat(64), labels: ['bug', 'forge-ui'] },
      ],
      comments: [
        { eventId: 'c1-id', issueEventId: 'issue1-event-id', authorPubkey: 'b'.repeat(64), body: 'comment 1' },
        { eventId: 'c2-id', issueEventId: 'issue1-event-id', authorPubkey: 'a'.repeat(64), body: 'comment 2' },
      ],
    };

    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it('[P0] AC-8.2: runPush08 throws descriptive error when push07State.prs[0].statusKind !== 1631', async () => {
      // Given: Push07State with PR #1 statusKind set to 1630 (Open) instead of 1631 (Merged)
      const badState = {
        ...mockPush07State,
        prs: [
          { eventId: 'pr1-event-id', title: 'PR #1', authorPubkey: 'b'.repeat(64), statusKind: 1630 as const },
          { eventId: 'pr2-event-id', title: 'PR #2', authorPubkey: 'c'.repeat(64), statusKind: 1630 as const },
        ],
      };

      const { runPush08 } = await import('../push-08-close.js');

      // When: runPush08 is called with bad state
      // Then: it should throw a descriptive error referencing kind:1631
      const mockClient = {} as any;
      const mockSecretKey = new Uint8Array(32);

      await expect(runPush08(mockClient, mockSecretKey, badState)).rejects.toThrow('1631');
    });

    it('[P0] AC-8.2: runPush08 throws with descriptive message mentioning Applied/Merged', async () => {
      // Given: Push07State with PR #1 statusKind set to 1632 (Closed) instead of 1631
      const badState = {
        ...mockPush07State,
        prs: [
          { eventId: 'pr1-event-id', title: 'PR #1', authorPubkey: 'b'.repeat(64), statusKind: 1632 as const },
          { eventId: 'pr2-event-id', title: 'PR #2', authorPubkey: 'c'.repeat(64), statusKind: 1630 as const },
        ],
      };

      const { runPush08 } = await import('../push-08-close.js');

      // When/Then: error message should be descriptive
      const mockClient = {} as any;
      const mockSecretKey = new Uint8Array(32);

      await expect(runPush08(mockClient, mockSecretKey, badState)).rejects.toThrow(/Applied\/Merged/);
    });

    it('[P0] AC-8.1, AC-8.4: runPush08 returns Push08State with closedIssueEventIds containing exactly 1 entry and all passthrough fields unchanged', async () => {
      // Given: valid Push07State and mocked publishWithRetry
      const fakeEventId = 'f'.repeat(64);

      // Mock publishWithRetry to return success
      const publishMod = await import('../lib/publish.js');
      vi.spyOn(publishMod, 'publishWithRetry').mockResolvedValue({
        success: true,
        eventId: fakeEventId,
      });

      const { runPush08 } = await import('../push-08-close.js');

      // When: runPush08 is called with valid state
      const mockClient = {} as any;
      const mockSecretKey = new Uint8Array(32).fill(1); // non-zero for valid key

      const result = await runPush08(mockClient, mockSecretKey, mockPush07State);

      // Then: closedIssueEventIds has exactly 1 entry matching the returned event ID
      expect(result.closedIssueEventIds).toHaveLength(1);
      expect(result.closedIssueEventIds[0]).toBe(fakeEventId);

      // Then: all passthrough fields are unchanged (reference equality)
      expect(result.repoId).toBe(mockPush07State.repoId);
      expect(result.ownerPubkey).toBe(mockPush07State.ownerPubkey);
      expect(result.commits).toBe(mockPush07State.commits);
      expect(result.shaMap).toBe(mockPush07State.shaMap);
      expect(result.repoAnnouncementId).toBe(mockPush07State.repoAnnouncementId);
      expect(result.refsEventId).toBe(mockPush07State.refsEventId);
      expect(result.branches).toBe(mockPush07State.branches);
      expect(result.tags).toBe(mockPush07State.tags);
      expect(result.files).toBe(mockPush07State.files);
      expect(result.prs).toBe(mockPush07State.prs);
      expect(result.issues).toBe(mockPush07State.issues);
      expect(result.comments).toBe(mockPush07State.comments);
    });

    it('[P0] AC-8.1, AC-8.3: runPush08 calls publishWithRetry exactly once with aliceClient', async () => {
      // Given: valid Push07State and mocked publishWithRetry
      const publishMod = await import('../lib/publish.js');
      const publishSpy = vi.spyOn(publishMod, 'publishWithRetry').mockResolvedValue({
        success: true,
        eventId: 'f'.repeat(64),
      });

      const { runPush08 } = await import('../push-08-close.js');

      // When: runPush08 is called
      const mockClient = { name: 'aliceClient' } as any;
      const mockSecretKey = new Uint8Array(32).fill(1);

      await runPush08(mockClient, mockSecretKey, mockPush07State);

      // Then: publishWithRetry called exactly once with the alice client
      expect(publishSpy).toHaveBeenCalledTimes(1);
      expect(publishSpy.mock.calls[0]![0]).toBe(mockClient);
    });

    it('[P0] AC-8.1: published event is kind:1632 with e tag referencing Issue #2 event ID', async () => {
      // Given: valid Push07State and mocked publishWithRetry that captures the event
      const publishMod = await import('../lib/publish.js');
      let capturedEvent: any = null;
      vi.spyOn(publishMod, 'publishWithRetry').mockImplementation(async (_client, event) => {
        capturedEvent = event;
        return { success: true, eventId: 'f'.repeat(64) };
      });

      const { runPush08 } = await import('../push-08-close.js');

      // When: runPush08 is called
      const mockClient = {} as any;
      const mockSecretKey = new Uint8Array(32).fill(1);

      await runPush08(mockClient, mockSecretKey, mockPush07State);

      // Then: captured event is kind:1632
      expect(capturedEvent).not.toBeNull();
      expect(capturedEvent.kind).toBe(1632);

      // Then: e tag references Issue #2 event ID
      const eTag = capturedEvent.tags.find((t: string[]) => t[0] === 'e');
      expect(eTag).toBeDefined();
      expect(eTag[1]).toBe(mockPush07State.issues[1]!.eventId);

      // Then: p tag references Issue #2 author pubkey
      const pTag = capturedEvent.tags.find((t: string[]) => t[0] === 'p');
      expect(pTag).toBeDefined();
      expect(pTag[1]).toBe(mockPush07State.issues[1]!.authorPubkey);
    });

    it('[P0] AC-8.1: runPush08 throws when publishWithRetry returns failure', async () => {
      // Given: publishWithRetry returns failure
      const publishMod = await import('../lib/publish.js');
      vi.spyOn(publishMod, 'publishWithRetry').mockResolvedValue({
        success: false,
        error: 'relay rejected event',
      });

      const { runPush08 } = await import('../push-08-close.js');

      // When/Then: runPush08 should throw on publish failure
      const mockClient = {} as any;
      const mockSecretKey = new Uint8Array(32).fill(1);

      await expect(runPush08(mockClient, mockSecretKey, mockPush07State)).rejects.toThrow(/kind:1632/);
    });

    it('[P0] AC-8.4: shaMap key count unchanged in result (no new git objects)', async () => {
      // Given: valid Push07State with known shaMap size
      const publishMod = await import('../lib/publish.js');
      vi.spyOn(publishMod, 'publishWithRetry').mockResolvedValue({
        success: true,
        eventId: 'f'.repeat(64),
      });

      const { runPush08 } = await import('../push-08-close.js');

      const mockClient = {} as any;
      const mockSecretKey = new Uint8Array(32).fill(1);

      // When: runPush08 is called
      const result = await runPush08(mockClient, mockSecretKey, mockPush07State);

      // Then: shaMap has same key count as input
      expect(Object.keys(result.shaMap).length).toBe(Object.keys(mockPush07State.shaMap).length);

      // Then: commits array has same length
      expect(result.commits.length).toBe(mockPush07State.commits.length);

      // Then: files array has same length
      expect(result.files.length).toBe(mockPush07State.files.length);
    });

    it('[P1] AC-8.1: closedIssueEventIds falls back to signed event id when publishWithRetry returns no eventId', async () => {
      // Given: publishWithRetry returns success but WITHOUT eventId (triggers ?? fallback)
      const publishMod = await import('../lib/publish.js');
      vi.spyOn(publishMod, 'publishWithRetry').mockResolvedValue({
        success: true,
      } as any);

      const { runPush08 } = await import('../push-08-close.js');

      // When: runPush08 is called
      const mockClient = {} as any;
      const mockSecretKey = new Uint8Array(32).fill(1);

      const result = await runPush08(mockClient, mockSecretKey, mockPush07State);

      // Then: closedIssueEventIds still has exactly 1 entry (falls back to signed.id)
      expect(result.closedIssueEventIds).toHaveLength(1);
      expect(typeof result.closedIssueEventIds[0]).toBe('string');
      expect(result.closedIssueEventIds[0]!.length).toBe(64); // Nostr event IDs are 64 hex chars
    });
  });

  // -------------------------------------------------------------------------
  // Integration test stubs (.todo) for live relay publishing (AC-8.1-8.4)
  // -------------------------------------------------------------------------

  it.todo('[integration] should publish kind:1632 close event for Issue #2 to live relay');
  it.todo('[integration] should return valid event ID from relay for close event');
  it.todo('[integration] should be queryable by relay after publish (kind:1632 for Issue #2)');
  it.todo('[integration] should verify PR #1 kind:1631 exists on relay before closing Issue #2');
});
