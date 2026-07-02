/**
 * ATDD Tests: Story 10.6 — Seed Script: PRs with Status (Push 6)
 *
 * Unit tests verify push-06-prs.ts publishes 2 kind:1617 PR events with
 * status events (kind:1630/1631), multi-client signing (Alice + Charlie),
 * state passthrough from Push05State, and the "no new git objects" constraint.
 * Integration tests (.todo) require live relay infrastructure.
 *
 * AC-6.1: seed/push-06-prs.ts publishes 2 kind:1617 PR events with correct tags
 * AC-6.2: kind:1630 (Open) status event published for PR #2
 * AC-6.3: kind:1631 (Applied/Merged) status event published for PR #1
 * AC-6.4: All events signed by correct author keypairs
 */

import { describe, it, expect } from 'vitest';

describe('Story 10.6: Push 06 — PRs with Status', () => {
  // -------------------------------------------------------------------------
  // AC-6.1: Module exports and structure
  // -------------------------------------------------------------------------

  it('[P0] should export runPush06 function', async () => {
    const push06 = await import('../push-06-prs.js');
    expect(typeof push06.runPush06).toBe('function');
  });

  it('[P0] should accept 5 parameters (aliceClient, charlieClient, aliceSecretKey, charlieSecretKey, push05State)', async () => {
    const push06 = await import('../push-06-prs.js');
    // runPush06 should accept at least 5 parameters
    expect(push06.runPush06.length).toBeGreaterThanOrEqual(5);
  });

  it('[P0] should export Push06State type (verified by compilation)', async () => {
    const push06 = await import('../push-06-prs.js');
    expect(push06).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // AC-6.1: buildPatch produces correct kind:1617 for PR #1
  // -------------------------------------------------------------------------

  it('[P0] AC-6.1: buildPatch for PR #1 produces kind:1617 with correct a tag, subject, commit/parent-commit tags, and branch t tag', async () => {
    const { buildPatch } = await import('../lib/event-builders.js');
    const push01 = await import('../push-01-init.js');

    const ownerPubkey = 'a'.repeat(64);
    const commit3Sha = 'c'.repeat(40);
    const commit2Sha = 'b'.repeat(40);
    const commit4Sha = 'd'.repeat(40);

    const event = buildPatch(
      ownerPubkey,
      push01.REPO_ID,
      'feat: add retry logic',
      [
        { sha: commit3Sha, parentSha: commit2Sha },
        { sha: commit4Sha, parentSha: commit3Sha },
      ],
      'feature/add-retry'
    );

    // kind:1617
    expect(event.kind).toBe(1617);

    // a tag references repo
    const aTag = event.tags.find((t) => t[0] === 'a');
    expect(aTag).toBeDefined();
    expect(aTag![1]).toBe(`30617:${ownerPubkey}:${push01.REPO_ID}`);

    // p tag = owner pubkey
    const pTag = event.tags.find((t) => t[0] === 'p');
    expect(pTag).toBeDefined();
    expect(pTag![1]).toBe(ownerPubkey);

    // subject tag = PR title
    const subjectTag = event.tags.find((t) => t[0] === 'subject');
    expect(subjectTag).toBeDefined();
    expect(subjectTag![1]).toBe('feat: add retry logic');

    // commit tags — 2 commits
    const commitTags = event.tags.filter((t) => t[0] === 'commit');
    expect(commitTags).toHaveLength(2);
    expect(commitTags[0]![1]).toBe(commit3Sha);
    expect(commitTags[1]![1]).toBe(commit4Sha);

    // parent-commit tags — 2 parent commits
    const parentTags = event.tags.filter((t) => t[0] === 'parent-commit');
    expect(parentTags).toHaveLength(2);
    expect(parentTags[0]![1]).toBe(commit2Sha);
    expect(parentTags[1]![1]).toBe(commit3Sha);

    // t tag = branch name
    const tTag = event.tags.find((t) => t[0] === 't');
    expect(tTag).toBeDefined();
    expect(tTag![1]).toBe('feature/add-retry');
  });

  // -------------------------------------------------------------------------
  // AC-6.1: buildPatch produces correct kind:1617 for PR #2
  // -------------------------------------------------------------------------

  it('[P0] AC-6.1: buildPatch for PR #2 produces kind:1617 with correct a tag, subject, single commit/parent-commit pair, no branch tag', async () => {
    const { buildPatch } = await import('../lib/event-builders.js');
    const push01 = await import('../push-01-init.js');

    const ownerPubkey = 'a'.repeat(64);
    const placeholderSha = 'c'.repeat(40);
    const parentSha = 'b'.repeat(40);

    const event = buildPatch(
      ownerPubkey,
      push01.REPO_ID,
      'fix: update docs',
      [{ sha: placeholderSha, parentSha }]
      // No branch tag
    );

    // kind:1617
    expect(event.kind).toBe(1617);

    // a tag references repo
    const aTag = event.tags.find((t) => t[0] === 'a');
    expect(aTag).toBeDefined();
    expect(aTag![1]).toBe(`30617:${ownerPubkey}:${push01.REPO_ID}`);

    // subject tag = PR title
    const subjectTag = event.tags.find((t) => t[0] === 'subject');
    expect(subjectTag).toBeDefined();
    expect(subjectTag![1]).toBe('fix: update docs');

    // Single commit tag
    const commitTags = event.tags.filter((t) => t[0] === 'commit');
    expect(commitTags).toHaveLength(1);
    expect(commitTags[0]![1]).toBe(placeholderSha);

    // Single parent-commit tag
    const parentTags = event.tags.filter((t) => t[0] === 'parent-commit');
    expect(parentTags).toHaveLength(1);
    expect(parentTags[0]![1]).toBe(parentSha);

    // No t tag (no branch name)
    const tTag = event.tags.find((t) => t[0] === 't');
    expect(tTag).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // AC-6.3: buildStatus produces kind:1631 for PR #1
  // -------------------------------------------------------------------------

  it('[P0] AC-6.3: buildStatus for PR #1 produces kind:1631 with e tag referencing PR event ID and p tag', async () => {
    const { buildStatus } = await import('../lib/event-builders.js');

    const pr1EventId = 'e'.repeat(64);
    const pr1AuthorPubkey = 'a'.repeat(64);

    const event = buildStatus(pr1EventId, 1631, pr1AuthorPubkey);

    expect(event.kind).toBe(1631);

    // e tag references the PR event
    const eTag = event.tags.find((t) => t[0] === 'e');
    expect(eTag).toBeDefined();
    expect(eTag![1]).toBe(pr1EventId);

    // p tag = PR author pubkey
    const pTag = event.tags.find((t) => t[0] === 'p');
    expect(pTag).toBeDefined();
    expect(pTag![1]).toBe(pr1AuthorPubkey);
  });

  // -------------------------------------------------------------------------
  // AC-6.2: buildStatus produces kind:1630 for PR #2
  // -------------------------------------------------------------------------

  it('[P0] AC-6.2: buildStatus for PR #2 produces kind:1630 with e tag referencing PR event ID and p tag', async () => {
    const { buildStatus } = await import('../lib/event-builders.js');

    const pr2EventId = 'f'.repeat(64);
    const pr2AuthorPubkey = 'b'.repeat(64);

    const event = buildStatus(pr2EventId, 1630, pr2AuthorPubkey);

    expect(event.kind).toBe(1630);

    // e tag references the PR event
    const eTag = event.tags.find((t) => t[0] === 'e');
    expect(eTag).toBeDefined();
    expect(eTag![1]).toBe(pr2EventId);

    // p tag = PR author pubkey
    const pTag = event.tags.find((t) => t[0] === 'p');
    expect(pTag).toBeDefined();
    expect(pTag![1]).toBe(pr2AuthorPubkey);
  });

  // -------------------------------------------------------------------------
  // AC-6.1: Push06State.prs has 2 entries with correct structure
  // -------------------------------------------------------------------------

  it('[P0] AC-6.1: Push06State.prs has 2 entries with correct titles, statusKinds, and distinct authorPubkeys', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'push-06-prs.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    // Verify Push06State interface declares prs field
    const start = source.indexOf('export interface Push06State');
    expect(start).toBeGreaterThan(-1);
    const interfaceBlock = source.slice(start, start + 600);
    expect(interfaceBlock).toContain('prs:');
    expect(interfaceBlock).toContain('eventId: string');
    expect(interfaceBlock).toContain('title: string');
    expect(interfaceBlock).toContain('authorPubkey: string');
    expect(interfaceBlock).toContain('statusKind: 1630 | 1631 | 1632 | 1633');

    // Verify both PR titles appear in the source
    expect(source).toContain('feat: add retry logic');
    expect(source).toContain('fix: update docs');

    // Verify both status kinds appear
    expect(source).toContain('1631');
    expect(source).toContain('1630');
  });

  // -------------------------------------------------------------------------
  // AC-6.1: Push06State passes through all Push05State fields unchanged
  // -------------------------------------------------------------------------

  it('[P0] AC-6.1: Push06State passes through all Push05State fields unchanged', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'push-06-prs.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    // Verify the return statement references all passthrough fields from push05State
    expect(source).toContain('push05State.repoId');
    expect(source).toContain('push05State.ownerPubkey');
    expect(source).toContain('push05State.commits');
    expect(source).toContain('push05State.shaMap');
    expect(source).toContain('push05State.repoAnnouncementId');
    expect(source).toContain('push05State.refsEventId');
    expect(source).toContain('push05State.branches');
    expect(source).toContain('push05State.tags');
    expect(source).toContain('push05State.files');
  });

  // -------------------------------------------------------------------------
  // No new git objects — shaMap unchanged, commits unchanged, files unchanged
  // -------------------------------------------------------------------------

  it('[P0] AC-6.1: no new git objects created — commits passthrough, shaMap passthrough, files passthrough', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'push-06-prs.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    // Verify commits are passed through from push05State (not rebuilt or modified)
    expect(source).toContain('commits: push05State.commits');

    // Verify shaMap is passed through
    expect(source).toContain('shaMap: push05State.shaMap');

    // Verify files are passed through
    expect(source).toContain('files: push05State.files');
  });

  // -------------------------------------------------------------------------
  // Source does NOT import git builder functions
  // -------------------------------------------------------------------------

  it('[P1] push-06-prs.ts source does NOT import createGitBlob, createGitTree, createGitCommit, uploadGitObject, or signBalanceProof', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'push-06-prs.ts'
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
  // Push06State interface has correct shape
  // -------------------------------------------------------------------------

  it('[P1] Push06State interface includes prs field alongside all Push05State fields', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'push-06-prs.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    // Verify Push06State interface is exported
    expect(source).toContain('export interface Push06State');

    const start = source.indexOf('export interface Push06State');
    expect(start).toBeGreaterThan(-1);
    const interfaceBlock = source.slice(start, start + 600);

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
  });

  // -------------------------------------------------------------------------
  // AC-6.4: Events signed by correct authors — source uses correct variables
  // -------------------------------------------------------------------------

  it('[P1] AC-6.4: source uses aliceSecretKey for PR #1 and charlieSecretKey for PR #2', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'push-06-prs.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    // Alice signs PR #1
    expect(source).toContain('finalizeEvent');
    expect(source).toContain('aliceSecretKey');

    // Charlie signs PR #2
    expect(source).toContain('charlieSecretKey');

    // Both clients used for publishing
    expect(source).toContain('aliceClient');
    expect(source).toContain('charlieClient');
  });

  // -------------------------------------------------------------------------
  // AC-6.4: authorPubkeys derived from signed events, not AGENT_IDENTITIES
  // -------------------------------------------------------------------------

  it('[P1] AC-6.4: authorPubkeys derived from signed events (pr1Signed.pubkey, pr2Signed.pubkey)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'push-06-prs.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    // Pubkeys are derived from signed events, not from AGENT_IDENTITIES
    expect(source).toContain('pr1Signed.pubkey');
    expect(source).toContain('pr2Signed.pubkey');
  });

  // -------------------------------------------------------------------------
  // Module does not re-export git builder functions
  // -------------------------------------------------------------------------

  it('[P1] module does NOT export git object creation functions', async () => {
    const push06 = await import('../push-06-prs.js');
    const exportKeys = Object.keys(push06);

    expect(exportKeys).not.toContain('createGitBlob');
    expect(exportKeys).not.toContain('createGitTree');
    expect(exportKeys).not.toContain('createGitCommit');
    expect(exportKeys).not.toContain('uploadGitObject');

    // Should export runPush06
    expect(exportKeys).toContain('runPush06');
  });

  // -------------------------------------------------------------------------
  // Source imports Push05State from push-05-tag.js
  // -------------------------------------------------------------------------

  it('[P1] source imports Push05State from push-05-tag.js', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'push-06-prs.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    expect(source).toContain('Push05State');
    expect(source).toContain('push-05-tag.js');
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
      'push-06-prs.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    // Verify the eventId ?? signed.id fallback pattern is used for at least PR event IDs
    const fallbackPattern = /\.eventId \?\?.*\.id/;
    expect(fallbackPattern.test(source)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // AC-6.4: Status events signed by correct authors (Alice→PR#1 status, Charlie→PR#2 status)
  // -------------------------------------------------------------------------

  it('[P0] AC-6.4: Alice signs PR #1 status (kind:1631) and Charlie signs PR #2 status (kind:1630)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'push-06-prs.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    // Verify the status for PR #1 (kind:1631) is signed with aliceSecretKey
    // The source should show: buildStatus(pr1EventId, 1631, ...) followed by finalizeEvent(..., aliceSecretKey)
    const status1Section = source.slice(
      source.indexOf('buildStatus(pr1EventId, 1631'),
      source.indexOf('buildStatus(pr2EventId, 1630')
    );
    expect(status1Section).toContain('aliceSecretKey');
    expect(status1Section).not.toContain('charlieSecretKey');

    // Verify the status for PR #2 (kind:1630) is signed with charlieSecretKey
    const status2Start = source.indexOf('buildStatus(pr2EventId, 1630');
    const status2Section = source.slice(status2Start, status2Start + 300);
    expect(status2Section).toContain('charlieSecretKey');
    expect(status2Section).not.toContain('aliceSecretKey');
  });

  // -------------------------------------------------------------------------
  // AC-6.4: Status events published via correct clients (Alice→aliceClient, Charlie→charlieClient)
  // -------------------------------------------------------------------------

  it('[P0] AC-6.4: PR #1 status published via aliceClient and PR #2 status published via charlieClient', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'push-06-prs.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    // PR #1 published via aliceClient
    const pr1PublishSection = source.slice(
      source.indexOf('publishWithRetry(aliceClient, pr1Signed'),
      source.indexOf('publishWithRetry(charlieClient, pr2Signed')
    );
    expect(pr1PublishSection).toContain('aliceClient');

    // PR #2 published via charlieClient
    const pr2PublishIdx = source.indexOf('publishWithRetry(charlieClient, pr2Signed');
    expect(pr2PublishIdx).toBeGreaterThan(-1);

    // Status #1 published via aliceClient
    const status1PublishIdx = source.indexOf('publishWithRetry(aliceClient, status1Signed');
    expect(status1PublishIdx).toBeGreaterThan(-1);

    // Status #2 published via charlieClient
    const status2PublishIdx = source.indexOf('publishWithRetry(charlieClient, status2Signed');
    expect(status2PublishIdx).toBeGreaterThan(-1);
  });

  // -------------------------------------------------------------------------
  // AC-6.1: Correct commit index mapping for PR #1 and PR #2
  // -------------------------------------------------------------------------

  it('[P0] AC-6.1: PR #1 references commits[2] and commits[3] with correct parent chain', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'push-06-prs.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    // PR #1 should reference commits[2] (Push 3) and commits[3] (Push 4)
    expect(source).toContain('push05State.commits[2]!.sha');
    expect(source).toContain('push05State.commits[3]!.sha');

    // PR #1 parent chain: commits[1] -> commits[2] -> commits[3]
    expect(source).toContain('parentSha: push05State.commits[1]!.sha');
    expect(source).toContain('parentSha: push05State.commits[2]!.sha');
  });

  it('[P0] AC-6.1: PR #2 uses placeholder commit SHA and commits[1] as parent', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'push-06-prs.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    // PR #2 uses a placeholder commit SHA (40 'c' characters)
    expect(source).toContain("'c'.repeat(40)");

    // PR #2 parent is commits[1] (main HEAD from Push 2)
    // Already checked above but verify the placeholder is used as sha in the buildPatch call
    const pr2Section = source.slice(
      source.indexOf('placeholderCommitSha'),
      source.indexOf('pr2Signed = finalizeEvent')
    );
    expect(pr2Section).toContain('sha: placeholderCommitSha');
    expect(pr2Section).toContain('parentSha: push05State.commits[1]!.sha');
  });

  // -------------------------------------------------------------------------
  // AC-6.1: Exactly 4 publishWithRetry calls (2 patches + 2 statuses)
  // -------------------------------------------------------------------------

  it('[P0] AC-6.1: exactly 4 publishWithRetry calls in source (2 patches + 2 statuses)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'push-06-prs.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    const publishCalls = source.match(/publishWithRetry\(/g);
    expect(publishCalls).toHaveLength(4);
  });

  // -------------------------------------------------------------------------
  // Integration test stubs (.todo) for live relay publishing (AC-6.1-6.4)
  // -------------------------------------------------------------------------

  it.todo('[integration] should publish 2 kind:1617 PR events to live relay');
  it.todo('[integration] should publish kind:1631 status for PR #1 to live relay');
  it.todo('[integration] should publish kind:1630 status for PR #2 to live relay');
  it.todo('[integration] should return valid event IDs from relay for all 4 events');
  it.todo('[integration] should be queryable by relay after publish');
});
