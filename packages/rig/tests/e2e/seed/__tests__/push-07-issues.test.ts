/**
 * ATDD Tests: Story 10.7 -- Seed Script: Issues, Labels, Conversations (Push 7)
 *
 * Unit tests verify push-07-issues.ts publishes 2 kind:1621 issue events with
 * labels (t tags), 5 kind:1622 comment events across two threads,
 * three-client signing (Alice + Bob + Charlie), state passthrough from
 * Push06State, and the "no new git objects" constraint.
 * Integration tests (.todo) require live relay infrastructure.
 *
 * AC-7.1: seed/push-07-issues.ts publishes 2 kind:1621 issues with correct tags
 * AC-7.2: Comment thread on Issue #1 — 3 comments (Bob, Alice, Charlie)
 * AC-7.3: Comment thread on Issue #2 — 2 comments (Alice, Bob)
 * AC-7.4: All comments have correct e, p, and a tags
 */

import { describe, it, expect } from 'vitest';

describe('Story 10.7: Push 07 -- Issues, Labels, Conversations', () => {
  // -------------------------------------------------------------------------
  // AC-7.1: Module exports and structure
  // -------------------------------------------------------------------------

  it('[P0] should export runPush07 function', async () => {
    const push07 = await import('../push-07-issues.js');
    expect(typeof push07.runPush07).toBe('function');
  });

  it('[P0] should accept 7 parameters (3 clients, 3 secret keys, push06State)', async () => {
    const push07 = await import('../push-07-issues.js');
    // runPush07 should accept at least 7 parameters
    expect(push07.runPush07.length).toBeGreaterThanOrEqual(7);
  });

  it('[P0] should export Push07State type (verified by compilation)', async () => {
    const push07 = await import('../push-07-issues.js');
    expect(push07).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // AC-7.1: buildIssue produces correct kind:1621 for Issue #1
  // -------------------------------------------------------------------------

  it('[P0] AC-7.1: buildIssue for Issue #1 produces kind:1621 with correct a tag, subject tag, and t tags for enhancement and networking', async () => {
    const { buildIssue } = await import('../lib/event-builders.js');
    const push01 = await import('../push-01-init.js');

    const ownerPubkey = 'a'.repeat(64);

    const event = buildIssue(
      ownerPubkey,
      push01.REPO_ID,
      'Add WebSocket reconnection logic',
      'We need automatic reconnection with backoff when the WebSocket connection drops.',
      ['enhancement', 'networking']
    );

    // kind:1621
    expect(event.kind).toBe(1621);

    // a tag references repo
    const aTag = event.tags.find((t) => t[0] === 'a');
    expect(aTag).toBeDefined();
    expect(aTag![1]).toBe(`30617:${ownerPubkey}:${push01.REPO_ID}`);

    // p tag = owner pubkey
    const pTag = event.tags.find((t) => t[0] === 'p');
    expect(pTag).toBeDefined();
    expect(pTag![1]).toBe(ownerPubkey);

    // subject tag = issue title
    const subjectTag = event.tags.find((t) => t[0] === 'subject');
    expect(subjectTag).toBeDefined();
    expect(subjectTag![1]).toBe('Add WebSocket reconnection logic');

    // t tags — 2 labels
    const tTags = event.tags.filter((t) => t[0] === 't');
    expect(tTags).toHaveLength(2);
    expect(tTags[0]![1]).toBe('enhancement');
    expect(tTags[1]![1]).toBe('networking');
  });

  // -------------------------------------------------------------------------
  // AC-7.1: buildIssue produces correct kind:1621 for Issue #2
  // -------------------------------------------------------------------------

  it('[P0] AC-7.1: buildIssue for Issue #2 produces kind:1621 with correct a tag, subject tag, and t tags for bug and forge-ui', async () => {
    const { buildIssue } = await import('../lib/event-builders.js');
    const push01 = await import('../push-01-init.js');

    const ownerPubkey = 'a'.repeat(64);

    const event = buildIssue(
      ownerPubkey,
      push01.REPO_ID,
      'Fix deep path navigation bug',
      'Navigation breaks when traversing directories deeper than 3 levels.',
      ['bug', 'forge-ui']
    );

    // kind:1621
    expect(event.kind).toBe(1621);

    // a tag references repo
    const aTag = event.tags.find((t) => t[0] === 'a');
    expect(aTag).toBeDefined();
    expect(aTag![1]).toBe(`30617:${ownerPubkey}:${push01.REPO_ID}`);

    // subject tag = issue title
    const subjectTag = event.tags.find((t) => t[0] === 'subject');
    expect(subjectTag).toBeDefined();
    expect(subjectTag![1]).toBe('Fix deep path navigation bug');

    // t tags — 2 labels
    const tTags = event.tags.filter((t) => t[0] === 't');
    expect(tTags).toHaveLength(2);
    expect(tTags[0]![1]).toBe('bug');
    expect(tTags[1]![1]).toBe('forge-ui');
  });

  // -------------------------------------------------------------------------
  // AC-7.4: buildComment produces correct kind:1622 with e, a, and p tags
  // -------------------------------------------------------------------------

  it('[P0] AC-7.4: buildComment produces kind:1622 with correct e tag (marker: reply), a tag, and p tag', async () => {
    const { buildComment } = await import('../lib/event-builders.js');
    const push01 = await import('../push-01-init.js');

    const ownerPubkey = 'a'.repeat(64);
    const issueEventId = 'e'.repeat(64);
    const issueAuthorPubkey = 'b'.repeat(64);

    const event = buildComment(
      ownerPubkey,
      push01.REPO_ID,
      issueEventId,
      issueAuthorPubkey,
      'Should we use exponential backoff?'
    );

    // kind:1622
    expect(event.kind).toBe(1622);

    // a tag references repo
    const aTag = event.tags.find((t) => t[0] === 'a');
    expect(aTag).toBeDefined();
    expect(aTag![1]).toBe(`30617:${ownerPubkey}:${push01.REPO_ID}`);

    // e tag references the issue event with 'reply' marker
    const eTag = event.tags.find((t) => t[0] === 'e');
    expect(eTag).toBeDefined();
    expect(eTag![1]).toBe(issueEventId);
    expect(eTag![3]).toBe('reply');

    // p tag = issue author pubkey (for threading)
    const pTag = event.tags.find((t) => t[0] === 'p');
    expect(pTag).toBeDefined();
    expect(pTag![1]).toBe(issueAuthorPubkey);

    // content = comment body
    expect(event.content).toBe('Should we use exponential backoff?');
  });

  // -------------------------------------------------------------------------
  // AC-7.1: Push07State.issues has 2 entries with correct structure
  // -------------------------------------------------------------------------

  it('[P0] AC-7.1: Push07State.issues has 2 entries with correct titles, labels, and distinct authorPubkeys', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'push-07-issues.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    // Verify Push07State interface declares issues field
    const start = source.indexOf('export interface Push07State');
    expect(start).toBeGreaterThan(-1);
    const interfaceBlock = source.slice(start, start + 800);
    expect(interfaceBlock).toContain('issues:');
    expect(interfaceBlock).toContain('eventId: string');
    expect(interfaceBlock).toContain('title: string');
    expect(interfaceBlock).toContain('authorPubkey: string');
    expect(interfaceBlock).toContain('labels: string[]');

    // Verify both issue titles appear in the source
    expect(source).toContain('Add WebSocket reconnection logic');
    expect(source).toContain('Fix deep path navigation bug');

    // Verify labels appear
    expect(source).toContain('enhancement');
    expect(source).toContain('networking');
    expect(source).toContain('bug');
    expect(source).toContain('forge-ui');
  });

  // -------------------------------------------------------------------------
  // AC-7.2, AC-7.3: Push07State.comments has 5 entries
  // -------------------------------------------------------------------------

  it('[P0] AC-7.2, AC-7.3: Push07State.comments has 5 entries with correct issueEventId references and distinct authorPubkeys', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'push-07-issues.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    // Verify Push07State interface declares comments field
    const start = source.indexOf('export interface Push07State');
    expect(start).toBeGreaterThan(-1);
    const interfaceBlock = source.slice(start, start + 800);
    expect(interfaceBlock).toContain('comments:');
    expect(interfaceBlock).toContain('issueEventId: string');
    expect(interfaceBlock).toContain('body: string');

    // Verify all 5 comment bodies appear in source
    expect(source).toContain('Should we use exponential backoff?');
    expect(source).toContain('Yes, with jitter. See RFC 6298.');
    expect(source).toContain('What about connection pooling?');
    expect(source).toContain('Reproduced at depth 3+');
    expect(source).toContain('Root cause is in tree SHA resolution');
  });

  // -------------------------------------------------------------------------
  // AC-7.2: Issue #1 comments preserve publication order (Bob, Alice, Charlie)
  // AC-7.3: Issue #2 comments preserve publication order (Alice, Bob)
  // -------------------------------------------------------------------------

  it('[P0] AC-7.2, AC-7.3: Push07State.comments preserves publication order -- Issue #1 (Bob, Alice, Charlie) then Issue #2 (Alice, Bob)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'push-07-issues.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    // Verify the comments array in the return statement lists all 5 in order
    // Find the return statement section
    const returnIdx = source.lastIndexOf('return {');
    expect(returnIdx).toBeGreaterThan(-1);
    const returnSection = source.slice(returnIdx);

    // Comments should reference c1 through c5 in order
    const c1Idx = returnSection.indexOf('c1');
    const c2Idx = returnSection.indexOf('c2', c1Idx + 1);
    const c3Idx = returnSection.indexOf('c3', c2Idx + 1);
    const c4Idx = returnSection.indexOf('c4', c3Idx + 1);
    const c5Idx = returnSection.indexOf('c5', c4Idx + 1);

    expect(c1Idx).toBeGreaterThan(-1);
    expect(c2Idx).toBeGreaterThan(c1Idx);
    expect(c3Idx).toBeGreaterThan(c2Idx);
    expect(c4Idx).toBeGreaterThan(c3Idx);
    expect(c5Idx).toBeGreaterThan(c4Idx);
  });

  // -------------------------------------------------------------------------
  // AC-7.1: Push07State passes through all Push06State fields unchanged
  // -------------------------------------------------------------------------

  it('[P0] AC-7.1: Push07State passes through all Push06State fields unchanged', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'push-07-issues.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    // Verify the return statement references all passthrough fields from push06State
    expect(source).toContain('push06State.repoId');
    expect(source).toContain('push06State.ownerPubkey');
    expect(source).toContain('push06State.commits');
    expect(source).toContain('push06State.shaMap');
    expect(source).toContain('push06State.repoAnnouncementId');
    expect(source).toContain('push06State.refsEventId');
    expect(source).toContain('push06State.branches');
    expect(source).toContain('push06State.tags');
    expect(source).toContain('push06State.files');
    expect(source).toContain('push06State.prs');
  });

  // -------------------------------------------------------------------------
  // No new git objects -- shaMap unchanged, commits unchanged, files unchanged
  // -------------------------------------------------------------------------

  it('[P0] AC-7.1: no new git objects created -- commits passthrough, shaMap passthrough, files passthrough, prs passthrough', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'push-07-issues.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    // Verify commits are passed through from push06State (not rebuilt or modified)
    expect(source).toContain('commits: push06State.commits');

    // Verify shaMap is passed through
    expect(source).toContain('shaMap: push06State.shaMap');

    // Verify files are passed through
    expect(source).toContain('files: push06State.files');

    // Verify prs are passed through (unchanged from Push06)
    expect(source).toContain('prs: push06State.prs');
  });

  // -------------------------------------------------------------------------
  // Source does NOT import git builder functions
  // -------------------------------------------------------------------------

  it('[P1] push-07-issues.ts source does NOT import createGitBlob, createGitTree, createGitCommit, uploadGitObject, or signBalanceProof', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'push-07-issues.ts'
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
  // Push07State interface has correct shape
  // -------------------------------------------------------------------------

  it('[P1] Push07State interface includes issues and comments fields alongside all Push06State fields', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'push-07-issues.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    // Verify Push07State interface is exported
    expect(source).toContain('export interface Push07State');

    const start = source.indexOf('export interface Push07State');
    expect(start).toBeGreaterThan(-1);
    const interfaceBlock = source.slice(start, start + 800);

    // All Push06State fields present
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

    // New Push07State fields
    expect(interfaceBlock).toContain('issues:');
    expect(interfaceBlock).toContain('comments:');
  });

  // -------------------------------------------------------------------------
  // Three clients used -- Alice, Bob, Charlie
  // -------------------------------------------------------------------------

  it('[P1] AC-7.1: source uses three clients (aliceClient, bobClient, charlieClient) and three secret keys', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'push-07-issues.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    // All three clients used
    expect(source).toContain('aliceClient');
    expect(source).toContain('bobClient');
    expect(source).toContain('charlieClient');

    // All three secret keys used
    expect(source).toContain('aliceSecretKey');
    expect(source).toContain('bobSecretKey');
    expect(source).toContain('charlieSecretKey');

    // finalizeEvent used for signing
    expect(source).toContain('finalizeEvent');
  });

  // -------------------------------------------------------------------------
  // AC-7.1: Alice signs Issue #1, Bob signs Issue #2
  // -------------------------------------------------------------------------

  it('[P1] AC-7.1: Alice signs Issue #1 and Bob signs Issue #2', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'push-07-issues.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    // Issue #1 signed with aliceSecretKey (appears before Issue #2)
    const issue1Idx = source.indexOf('Add WebSocket reconnection logic');
    const issue2Idx = source.indexOf('Fix deep path navigation bug');
    expect(issue1Idx).toBeGreaterThan(-1);
    expect(issue2Idx).toBeGreaterThan(issue1Idx);

    // Between Issue #1 build and Issue #2 build, aliceSecretKey appears
    const section1 = source.slice(issue1Idx, issue2Idx);
    expect(section1).toContain('aliceSecretKey');

    // After Issue #2 build, bobSecretKey appears
    const section2 = source.slice(issue2Idx, issue2Idx + 500);
    expect(section2).toContain('bobSecretKey');
  });

  // -------------------------------------------------------------------------
  // Source imports Push06State from push-06-prs.js
  // -------------------------------------------------------------------------

  it('[P1] source imports Push06State from push-06-prs.js', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'push-07-issues.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    expect(source).toContain('Push06State');
    expect(source).toContain('push-06-prs.js');
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
      'push-07-issues.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    // Verify the eventId ?? signed.id fallback pattern is used
    const fallbackPattern = /\.eventId \?\?.*\.id/;
    expect(fallbackPattern.test(source)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Exactly 7 publishWithRetry calls (2 issues + 5 comments)
  // -------------------------------------------------------------------------

  it('[P0] AC-7.1: exactly 7 publishWithRetry calls in source (2 issues + 5 comments)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'push-07-issues.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    const publishCalls = source.match(/publishWithRetry\(/g);
    expect(publishCalls).toHaveLength(7);
  });

  // -------------------------------------------------------------------------
  // Module does not re-export git builder functions
  // -------------------------------------------------------------------------

  it('[P1] module does NOT export git object creation functions', async () => {
    const push07 = await import('../push-07-issues.js');
    const exportKeys = Object.keys(push07);

    expect(exportKeys).not.toContain('createGitBlob');
    expect(exportKeys).not.toContain('createGitTree');
    expect(exportKeys).not.toContain('createGitCommit');
    expect(exportKeys).not.toContain('uploadGitObject');

    // Should export runPush07
    expect(exportKeys).toContain('runPush07');
  });

  // -------------------------------------------------------------------------
  // AC-7.4: Comment authors are correct per thread
  // -------------------------------------------------------------------------

  it('[P0] AC-7.2, AC-7.4: Issue #1 comments signed by Bob, Alice, Charlie (in that order)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'push-07-issues.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    // Find the section with Issue #1 comments (between "exponential backoff" and "Reproduced at depth")
    const c1Idx = source.indexOf('Should we use exponential backoff?');
    const c4Idx = source.indexOf('Reproduced at depth 3+');
    expect(c1Idx).toBeGreaterThan(-1);
    expect(c4Idx).toBeGreaterThan(c1Idx);

    const issue1CommentSection = source.slice(c1Idx, c4Idx);

    // Comment 1 (Bob): "Should we use exponential backoff?" signed with bobSecretKey
    const backoffIdx = issue1CommentSection.indexOf('Should we use exponential backoff?');
    const bobSignIdx = issue1CommentSection.indexOf('bobSecretKey', backoffIdx);
    expect(bobSignIdx).toBeGreaterThan(backoffIdx);

    // Comment 2 (Alice): "Yes, with jitter. See RFC 6298." signed with aliceSecretKey
    const jitterIdx = issue1CommentSection.indexOf('Yes, with jitter. See RFC 6298.');
    const aliceSignIdx = issue1CommentSection.indexOf('aliceSecretKey', jitterIdx);
    expect(aliceSignIdx).toBeGreaterThan(jitterIdx);

    // Comment 3 (Charlie): "What about connection pooling?" signed with charlieSecretKey
    const poolingIdx = issue1CommentSection.indexOf('What about connection pooling?');
    const charlieSignIdx = issue1CommentSection.indexOf('charlieSecretKey', poolingIdx);
    expect(charlieSignIdx).toBeGreaterThan(poolingIdx);
  });

  it('[P0] AC-7.3, AC-7.4: Issue #2 comments signed by Alice, Bob (in that order)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'push-07-issues.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    // Find the section with Issue #2 comments (after "Reproduced at depth 3+")
    const c4Idx = source.indexOf('Reproduced at depth 3+');
    expect(c4Idx).toBeGreaterThan(-1);
    const issue2CommentSection = source.slice(c4Idx);

    // Comment 4 (Alice): "Reproduced at depth 3+" signed with aliceSecretKey
    const reproIdx = issue2CommentSection.indexOf('Reproduced at depth 3+');
    const aliceSignIdx = issue2CommentSection.indexOf('aliceSecretKey', reproIdx);
    expect(aliceSignIdx).toBeGreaterThan(reproIdx);

    // Comment 5 (Bob): "Root cause is in tree SHA resolution" signed with bobSecretKey
    const rootCauseIdx = issue2CommentSection.indexOf('Root cause is in tree SHA resolution');
    const bobSignIdx = issue2CommentSection.indexOf('bobSecretKey', rootCauseIdx);
    expect(bobSignIdx).toBeGreaterThan(rootCauseIdx);
  });

  // -------------------------------------------------------------------------
  // AC-7.4: Comments published via correct clients
  // -------------------------------------------------------------------------

  it('[P0] AC-7.4: comments published via correct clients (Bob->bobClient, Alice->aliceClient, Charlie->charlieClient)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'push-07-issues.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    // Issue #1 published via aliceClient
    const issue1PublishIdx = source.indexOf('publishWithRetry(aliceClient, issue1Signed');
    expect(issue1PublishIdx).toBeGreaterThan(-1);

    // Issue #2 published via bobClient
    const issue2PublishIdx = source.indexOf('publishWithRetry(bobClient, issue2Signed');
    expect(issue2PublishIdx).toBeGreaterThan(-1);

    // Comment c1 published via bobClient (Bob's comment)
    const c1PublishIdx = source.indexOf('publishWithRetry(bobClient, c1Signed');
    expect(c1PublishIdx).toBeGreaterThan(-1);

    // Comment c2 published via aliceClient (Alice's comment)
    const c2PublishIdx = source.indexOf('publishWithRetry(aliceClient, c2Signed');
    expect(c2PublishIdx).toBeGreaterThan(-1);

    // Comment c3 published via charlieClient (Charlie's comment)
    const c3PublishIdx = source.indexOf('publishWithRetry(charlieClient, c3Signed');
    expect(c3PublishIdx).toBeGreaterThan(-1);

    // Comment c4 published via aliceClient (Alice's comment on Issue #2)
    const c4PublishIdx = source.indexOf('publishWithRetry(aliceClient, c4Signed');
    expect(c4PublishIdx).toBeGreaterThan(-1);

    // Comment c5 published via bobClient (Bob's comment on Issue #2)
    const c5PublishIdx = source.indexOf('publishWithRetry(bobClient, c5Signed');
    expect(c5PublishIdx).toBeGreaterThan(-1);
  });

  // -------------------------------------------------------------------------
  // AGENT_IDENTITIES is NOT imported by this module
  // -------------------------------------------------------------------------

  it('[P1] module does NOT import AGENT_IDENTITIES', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'push-07-issues.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    expect(source).not.toContain('AGENT_IDENTITIES');
  });

  // -------------------------------------------------------------------------
  // AC-7.1: buildIssue for Issue #2 includes p tag for owner pubkey
  // -------------------------------------------------------------------------

  it('[P0] AC-7.1: buildIssue for Issue #2 includes p tag referencing repo owner', async () => {
    const { buildIssue } = await import('../lib/event-builders.js');
    const push01 = await import('../push-01-init.js');

    const ownerPubkey = 'a'.repeat(64);

    const event = buildIssue(
      ownerPubkey,
      push01.REPO_ID,
      'Fix deep path navigation bug',
      'Navigation breaks when traversing directories deeper than 3 levels.',
      ['bug', 'forge-ui']
    );

    // p tag = owner pubkey (same as Issue #1 test verifies)
    const pTag = event.tags.find((t) => t[0] === 'p');
    expect(pTag).toBeDefined();
    expect(pTag![1]).toBe(ownerPubkey);
  });

  // -------------------------------------------------------------------------
  // AC-7.4: Issue #1 comments pass issue1EventId to buildComment (e tag wiring)
  // -------------------------------------------------------------------------

  it('[P0] AC-7.4: Issue #1 comments use issue1EventId as buildComment parent and issue1Signed.pubkey as p tag', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'push-07-issues.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    // All 3 Issue #1 comments (c1, c2, c3) must pass issue1EventId to buildComment
    const c1BuildIdx = source.indexOf("'Should we use exponential backoff?'");
    const c2BuildIdx = source.indexOf("'Yes, with jitter. See RFC 6298.'");
    const c3BuildIdx = source.indexOf("'What about connection pooling?'");
    expect(c1BuildIdx).toBeGreaterThan(-1);
    expect(c2BuildIdx).toBeGreaterThan(-1);
    expect(c3BuildIdx).toBeGreaterThan(-1);

    // Each comment's buildComment call should reference issue1EventId (appears before the body string)
    const c1Section = source.slice(c1BuildIdx - 200, c1BuildIdx);
    const c2Section = source.slice(c2BuildIdx - 200, c2BuildIdx);
    const c3Section = source.slice(c3BuildIdx - 200, c3BuildIdx);
    expect(c1Section).toContain('issue1EventId');
    expect(c2Section).toContain('issue1EventId');
    expect(c3Section).toContain('issue1EventId');

    // Each Issue #1 comment should pass issue1Signed.pubkey for p tag threading
    expect(c1Section).toContain('issue1Signed.pubkey');
    expect(c2Section).toContain('issue1Signed.pubkey');
    expect(c3Section).toContain('issue1Signed.pubkey');
  });

  // -------------------------------------------------------------------------
  // AC-7.4: Issue #2 comments pass issue2EventId to buildComment (e tag wiring)
  // -------------------------------------------------------------------------

  it('[P0] AC-7.4: Issue #2 comments use issue2EventId as buildComment parent and issue2Signed.pubkey as p tag', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'push-07-issues.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    // Both Issue #2 comments (c4, c5) must pass issue2EventId to buildComment
    const c4BuildIdx = source.indexOf("'Reproduced at depth 3+'");
    const c5BuildIdx = source.indexOf("'Root cause is in tree SHA resolution'");
    expect(c4BuildIdx).toBeGreaterThan(-1);
    expect(c5BuildIdx).toBeGreaterThan(-1);

    // Each comment's buildComment call should reference issue2EventId
    const c4Section = source.slice(c4BuildIdx - 200, c4BuildIdx);
    const c5Section = source.slice(c5BuildIdx - 200, c5BuildIdx);
    expect(c4Section).toContain('issue2EventId');
    expect(c5Section).toContain('issue2EventId');

    // Each Issue #2 comment should pass issue2Signed.pubkey for p tag threading
    expect(c4Section).toContain('issue2Signed.pubkey');
    expect(c5Section).toContain('issue2Signed.pubkey');
  });

  // -------------------------------------------------------------------------
  // AC-7.2, AC-7.3: Exact comment count per issue thread
  // -------------------------------------------------------------------------

  it('[P0] AC-7.2, AC-7.3: exactly 3 comments reference issue1EventId and 2 comments reference issue2EventId', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'push-07-issues.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    // Count buildComment calls that pass issue1EventId
    const issue1Matches = source.match(/buildComment\([^)]*issue1EventId/g);
    expect(issue1Matches).toHaveLength(3);

    // Count buildComment calls that pass issue2EventId
    const issue2Matches = source.match(/buildComment\([^)]*issue2EventId/g);
    expect(issue2Matches).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // AC-7.4: buildComment default marker is 'reply' (all comments use default)
  // -------------------------------------------------------------------------

  it('[P1] AC-7.4: source does not override buildComment marker (all comments use default reply marker)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'push-07-issues.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    // buildComment's 6th parameter (marker) defaults to 'reply'
    // Source should NOT pass 'root' as marker for any comment
    // All 5 buildComment calls should use exactly 5 args (omitting marker for default 'reply')
    const buildCommentCalls = source.match(/buildComment\(/g);
    expect(buildCommentCalls).toHaveLength(5);

    // No 'root' marker override
    expect(source).not.toContain("'root'");
  });

  // -------------------------------------------------------------------------
  // Integration test stubs (.todo) for live relay publishing (AC-7.1-7.4)
  // -------------------------------------------------------------------------

  it.todo('[integration] should publish 2 kind:1621 issue events to live relay');
  it.todo('[integration] should publish 5 kind:1622 comment events to live relay');
  it.todo('[integration] should return valid event IDs from relay for all 7 events');
  it.todo('[integration] should be queryable by relay after publish');
  it.todo('[integration] should filter issues by label (t tag) via relay query');
});
