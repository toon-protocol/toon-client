/**
 * ATDD Tests: Story 10.1 — AC-1.6 Event Builders
 * TDD RED PHASE: These tests define expected behavior for event-builders.ts
 *
 * Tests will FAIL until event-builders.ts is implemented.
 */

import { describe, it, expect } from 'vitest';

describe('AC-1.6: Event Builders (event-builders.ts)', () => {
  it('[P0] should export buildRepoAnnouncement for kind:30617', async () => {
    const builders = await import('../lib/event-builders.js');

    expect(typeof builders.buildRepoAnnouncement).toBe('function');

    // When building a repo announcement
    const event = builders.buildRepoAnnouncement('hello-toon', 'Hello TOON', 'A demo repo');

    // Then it should return an UnsignedEvent with correct kind and tags
    expect(event.kind).toBe(30617);
    expect(event.tags).toEqual(
      expect.arrayContaining([
        ['d', 'hello-toon'],
        ['name', 'Hello TOON'],
        ['description', 'A demo repo'],
      ])
    );
  });

  it('[P0] should export buildRepoRefs for kind:30618', async () => {
    const builders = await import('../lib/event-builders.js');

    expect(typeof builders.buildRepoRefs).toBe('function');

    // When building repo refs
    const refs = { 'refs/heads/main': 'abc123' };
    const arweaveMap = { abc123: 'arweave-tx-1' };
    const event = builders.buildRepoRefs('hello-toon', refs, arweaveMap);

    // Then it should return an UnsignedEvent with correct kind and tags
    expect(event.kind).toBe(30618);
    expect(event.tags).toEqual(
      expect.arrayContaining([
        ['d', 'hello-toon'],
        ['r', 'refs/heads/main', 'abc123'],
        ['HEAD', 'ref: refs/heads/main'],
      ])
    );
    // Should include arweave mapping tags
    expect(event.tags).toEqual(
      expect.arrayContaining([
        ['arweave', 'abc123', 'arweave-tx-1'],
      ])
    );
  });

  it('[P0] should export buildIssue for kind:1621', async () => {
    const builders = await import('../lib/event-builders.js');

    expect(typeof builders.buildIssue).toBe('function');

    const ownerPubkey = '55c2a467881059a942fdc6908b041273885b8720bfa8fcf2f5f9c20a73b0964d';
    const event = builders.buildIssue(ownerPubkey, 'hello-toon', 'Bug title', 'Bug body', ['bug']);

    expect(event.kind).toBe(1621);
    expect(event.content).toBe('Bug body');
    expect(event.tags).toEqual(
      expect.arrayContaining([
        ['a', `30617:${ownerPubkey}:hello-toon`],
        ['subject', 'Bug title'],
        ['t', 'bug'],
      ])
    );
    // Should include p tag for repo owner
    expect(event.tags).toEqual(
      expect.arrayContaining([
        ['p', ownerPubkey],
      ])
    );
  });

  it('[P0] should export buildComment for kind:1622', async () => {
    const builders = await import('../lib/event-builders.js');

    expect(typeof builders.buildComment).toBe('function');

    const ownerPubkey = '55c2a467881059a942fdc6908b041273885b8720bfa8fcf2f5f9c20a73b0964d';
    const issueEventId = 'deadbeef1234567890abcdef1234567890abcdef1234567890abcdef12345678';
    const authorPubkey = '7937ffc0c5a0238768da798d26394a33b554926d739c445fd508e36642ebc286';

    const event = builders.buildComment(
      ownerPubkey,
      'hello-toon',
      issueEventId,
      authorPubkey,
      'Comment body',
      'reply'
    );

    expect(event.kind).toBe(1622);
    expect(event.content).toBe('Comment body');
    // Should have 'a' tag referencing the repo
    expect(event.tags).toEqual(
      expect.arrayContaining([
        ['a', `30617:${ownerPubkey}:hello-toon`],
      ])
    );
    // Should have 'e' tag with reply marker
    const eTag = event.tags.find(
      (t: string[]) => t[0] === 'e' && t[1] === issueEventId
    );
    expect(eTag).toBeDefined();
    // Should have 'p' tag for author
    expect(event.tags).toEqual(
      expect.arrayContaining([
        ['p', authorPubkey],
      ])
    );
  });

  it('[P1] should export buildPatch for kind:1617', async () => {
    const builders = await import('../lib/event-builders.js');

    expect(typeof builders.buildPatch).toBe('function');

    const ownerPubkey = '55c2a467881059a942fdc6908b041273885b8720bfa8fcf2f5f9c20a73b0964d';
    const commits = [{ sha: 'abc123', parentSha: 'def456' }];

    const event = builders.buildPatch(
      ownerPubkey,
      'hello-toon',
      'Fix readme',
      commits,
      'feature/fix'
    );

    expect(event.kind).toBe(1617);
    expect(event.tags).toEqual(
      expect.arrayContaining([
        ['a', `30617:${ownerPubkey}:hello-toon`],
        ['commit', 'abc123'],
        ['parent-commit', 'def456'],
      ])
    );
  });

  it('[P1] should export buildStatus for kinds 1630-1633', async () => {
    const builders = await import('../lib/event-builders.js');

    expect(typeof builders.buildStatus).toBe('function');

    const targetEventId = 'deadbeef1234567890abcdef1234567890abcdef1234567890abcdef12345678';

    // Test each status kind
    for (const statusKind of [1630, 1631, 1632, 1633] as const) {
      const event = builders.buildStatus(targetEventId, statusKind);
      expect(event.kind).toBe(statusKind);
      expect(event.tags).toEqual(
        expect.arrayContaining([
          ['e', targetEventId],
        ])
      );
    }
  });

  it('[P1] should include p tag in buildStatus when targetPubkey is provided', async () => {
    const builders = await import('../lib/event-builders.js');

    const targetEventId = 'deadbeef1234567890abcdef1234567890abcdef1234567890abcdef12345678';
    const targetPubkey = '55c2a467881059a942fdc6908b041273885b8720bfa8fcf2f5f9c20a73b0964d';

    const event = builders.buildStatus(targetEventId, 1631, targetPubkey);

    expect(event.tags).toEqual(
      expect.arrayContaining([
        ['e', targetEventId],
        ['p', targetPubkey],
      ])
    );
  });

  it('[P1] should omit p tag in buildStatus when targetPubkey is not provided', async () => {
    const builders = await import('../lib/event-builders.js');

    const targetEventId = 'deadbeef1234567890abcdef1234567890abcdef1234567890abcdef12345678';

    const event = builders.buildStatus(targetEventId, 1630);

    const pTags = event.tags.filter((t: string[]) => t[0] === 'p');
    expect(pTags).toHaveLength(0);
  });

  it('[P1] should return UnsignedEvent (no id, no sig, no pubkey) from all builders', async () => {
    const builders = await import('../lib/event-builders.js');

    const event = builders.buildRepoAnnouncement('test', 'Test', 'Desc');

    // UnsignedEvent should not have id or sig (caller signs with finalizeEvent)
    expect((event as Record<string, unknown>).id).toBeUndefined();
    expect((event as Record<string, unknown>).sig).toBeUndefined();
    expect((event as Record<string, unknown>).pubkey).toBeUndefined();
  });

  it('[P1] should include created_at timestamp in all builders', async () => {
    const builders = await import('../lib/event-builders.js');

    const before = Math.floor(Date.now() / 1000);
    const event = builders.buildRepoAnnouncement('test', 'Test', 'Desc');
    const after = Math.floor(Date.now() / 1000);

    expect(event.created_at).toBeGreaterThanOrEqual(before);
    expect(event.created_at).toBeLessThanOrEqual(after);
  });

  it('[P1] should include subject and branch tag in buildPatch', async () => {
    const builders = await import('../lib/event-builders.js');

    const ownerPubkey = '55c2a467881059a942fdc6908b041273885b8720bfa8fcf2f5f9c20a73b0964d';
    const commits = [{ sha: 'abc123', parentSha: 'def456' }];

    const event = builders.buildPatch(ownerPubkey, 'hello-toon', 'Fix readme', commits, 'feature/fix');

    // Should include subject tag
    expect(event.tags).toEqual(
      expect.arrayContaining([['subject', 'Fix readme']])
    );
    // Should include branch as t tag
    expect(event.tags).toEqual(
      expect.arrayContaining([['t', 'feature/fix']])
    );
    // Should include p tag for repo owner
    expect(event.tags).toEqual(
      expect.arrayContaining([['p', ownerPubkey]])
    );
  });

  it('[P1] should omit branch tag when branchTag is not provided in buildPatch', async () => {
    const builders = await import('../lib/event-builders.js');

    const ownerPubkey = '55c2a467881059a942fdc6908b041273885b8720bfa8fcf2f5f9c20a73b0964d';
    const commits = [{ sha: 'abc123', parentSha: 'def456' }];

    const event = builders.buildPatch(ownerPubkey, 'hello-toon', 'Fix readme', commits);

    // Should NOT include a 't' tag when branchTag is undefined
    const tTags = event.tags.filter((t: string[]) => t[0] === 't');
    expect(tTags).toHaveLength(0);
  });

  it('[P1] should build issue with multiple labels as separate t tags', async () => {
    const builders = await import('../lib/event-builders.js');

    const ownerPubkey = '55c2a467881059a942fdc6908b041273885b8720bfa8fcf2f5f9c20a73b0964d';
    const event = builders.buildIssue(ownerPubkey, 'hello-toon', 'Multi-label', 'body', ['bug', 'urgent', 'help-wanted']);

    const tTags = event.tags.filter((t: string[]) => t[0] === 't');
    expect(tTags).toHaveLength(3);
    expect(tTags).toEqual(
      expect.arrayContaining([['t', 'bug'], ['t', 'urgent'], ['t', 'help-wanted']])
    );
  });

  it('[P1] should build issue with empty labels array', async () => {
    const builders = await import('../lib/event-builders.js');

    const ownerPubkey = '55c2a467881059a942fdc6908b041273885b8720bfa8fcf2f5f9c20a73b0964d';
    const event = builders.buildIssue(ownerPubkey, 'hello-toon', 'No labels', 'body');

    const tTags = event.tags.filter((t: string[]) => t[0] === 't');
    expect(tTags).toHaveLength(0);
  });

  it('[P1] should default to reply marker when marker is omitted in buildComment', async () => {
    const builders = await import('../lib/event-builders.js');

    const ownerPubkey = '55c2a467881059a942fdc6908b041273885b8720bfa8fcf2f5f9c20a73b0964d';
    const eventId = 'deadbeef1234567890abcdef1234567890abcdef1234567890abcdef12345678';
    const authorPubkey = '7937ffc0c5a0238768da798d26394a33b554926d739c445fd508e36642ebc286';

    // Call without explicit marker — should default to 'reply'
    const event = builders.buildComment(ownerPubkey, 'hello-toon', eventId, authorPubkey, 'Default marker');

    const eTag = event.tags.find((t: string[]) => t[0] === 'e' && t[1] === eventId);
    expect(eTag).toBeDefined();
    expect(eTag![3]).toBe('reply');
  });

  it('[P1] should build comment with root marker', async () => {
    const builders = await import('../lib/event-builders.js');

    const ownerPubkey = '55c2a467881059a942fdc6908b041273885b8720bfa8fcf2f5f9c20a73b0964d';
    const eventId = 'deadbeef1234567890abcdef1234567890abcdef1234567890abcdef12345678';
    const authorPubkey = '7937ffc0c5a0238768da798d26394a33b554926d739c445fd508e36642ebc286';

    const event = builders.buildComment(ownerPubkey, 'hello-toon', eventId, authorPubkey, 'Root comment', 'root');

    // e tag should have 'root' marker (4th element)
    const eTag = event.tags.find((t: string[]) => t[0] === 'e' && t[1] === eventId);
    expect(eTag).toBeDefined();
    expect(eTag![3]).toBe('root');
  });

  it('[P1] should build repo refs with multiple refs and arweave mappings', async () => {
    const builders = await import('../lib/event-builders.js');

    const refs = {
      'refs/heads/main': 'abc123',
      'refs/heads/dev': 'def456',
    };
    const arweaveMap = {
      abc123: 'arweave-tx-1',
      def456: 'arweave-tx-2',
    };

    const event = builders.buildRepoRefs('hello-toon', refs, arweaveMap);

    // Should have r tags for both refs
    expect(event.tags).toEqual(
      expect.arrayContaining([
        ['r', 'refs/heads/main', 'abc123'],
        ['r', 'refs/heads/dev', 'def456'],
      ])
    );
    // Should have arweave tags for both mappings
    expect(event.tags).toEqual(
      expect.arrayContaining([
        ['arweave', 'abc123', 'arweave-tx-1'],
        ['arweave', 'def456', 'arweave-tx-2'],
      ])
    );
  });
});
