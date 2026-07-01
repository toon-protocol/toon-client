/**
 * Unit tests for pure NIP-34 event builders (nip34-events.ts).
 *
 * Ported from packages/rig/tests/e2e/seed/__tests__/event-builders.test.ts
 * (#223), plus coverage for the new optional buildPatch `content` parameter.
 */

import { describe, it, expect } from 'vitest';
import {
  COMMENT_KIND,
  REPOSITORY_STATE_KIND,
  buildComment,
  buildIssue,
  buildPatch,
  buildRepoAnnouncement,
  buildRepoRefs,
  buildStatus,
} from './nip34-events.js';

const OWNER_PUBKEY =
  '55c2a467881059a942fdc6908b041273885b8720bfa8fcf2f5f9c20a73b0964d';
const AUTHOR_PUBKEY =
  '7937ffc0c5a0238768da798d26394a33b554926d739c445fd508e36642ebc286';
const EVENT_ID =
  'deadbeef1234567890abcdef1234567890abcdef1234567890abcdef12345678';

describe('buildRepoAnnouncement (kind:30617)', () => {
  it('builds a repo announcement with d/name/description tags', () => {
    const event = buildRepoAnnouncement(
      'hello-toon',
      'Hello TOON',
      'A demo repo'
    );

    expect(event.kind).toBe(30617);
    expect(event.tags).toEqual(
      expect.arrayContaining([
        ['d', 'hello-toon'],
        ['name', 'Hello TOON'],
        ['description', 'A demo repo'],
      ])
    );
  });

  it('returns an UnsignedEvent (no id, no sig, no pubkey)', () => {
    const event = buildRepoAnnouncement('test', 'Test', 'Desc');

    expect((event as Record<string, unknown>)['id']).toBeUndefined();
    expect((event as Record<string, unknown>)['sig']).toBeUndefined();
    expect((event as Record<string, unknown>)['pubkey']).toBeUndefined();
  });

  it('includes a created_at timestamp', () => {
    const before = Math.floor(Date.now() / 1000);
    const event = buildRepoAnnouncement('test', 'Test', 'Desc');
    const after = Math.floor(Date.now() / 1000);

    expect(event.created_at).toBeGreaterThanOrEqual(before);
    expect(event.created_at).toBeLessThanOrEqual(after);
  });
});

describe('buildRepoRefs (kind:30618)', () => {
  it('builds repo refs with r/HEAD/arweave tags', () => {
    const refs = { 'refs/heads/main': 'abc123' };
    const arweaveMap = { abc123: 'arweave-tx-1' };
    const event = buildRepoRefs('hello-toon', refs, arweaveMap);

    expect(event.kind).toBe(30618);
    expect(REPOSITORY_STATE_KIND).toBe(30618);
    expect(event.tags).toEqual(
      expect.arrayContaining([
        ['d', 'hello-toon'],
        ['r', 'refs/heads/main', 'abc123'],
        ['HEAD', 'ref: refs/heads/main'],
        ['arweave', 'abc123', 'arweave-tx-1'],
      ])
    );
  });

  it('supports multiple refs and arweave mappings', () => {
    const refs = {
      'refs/heads/main': 'abc123',
      'refs/heads/dev': 'def456',
    };
    const arweaveMap = {
      abc123: 'arweave-tx-1',
      def456: 'arweave-tx-2',
    };

    const event = buildRepoRefs('hello-toon', refs, arweaveMap);

    expect(event.tags).toEqual(
      expect.arrayContaining([
        ['r', 'refs/heads/main', 'abc123'],
        ['r', 'refs/heads/dev', 'def456'],
        ['arweave', 'abc123', 'arweave-tx-1'],
        ['arweave', 'def456', 'arweave-tx-2'],
      ])
    );
  });
});

describe('buildIssue (kind:1621)', () => {
  it('builds an issue with a/p/subject/t tags and body content', () => {
    const event = buildIssue(
      OWNER_PUBKEY,
      'hello-toon',
      'Bug title',
      'Bug body',
      ['bug']
    );

    expect(event.kind).toBe(1621);
    expect(event.content).toBe('Bug body');
    expect(event.tags).toEqual(
      expect.arrayContaining([
        ['a', `30617:${OWNER_PUBKEY}:hello-toon`],
        ['p', OWNER_PUBKEY],
        ['subject', 'Bug title'],
        ['t', 'bug'],
      ])
    );
  });

  it('builds an issue with multiple labels as separate t tags', () => {
    const event = buildIssue(
      OWNER_PUBKEY,
      'hello-toon',
      'Multi-label',
      'body',
      ['bug', 'urgent', 'help-wanted']
    );

    const tTags = event.tags.filter((t) => t[0] === 't');
    expect(tTags).toHaveLength(3);
    expect(tTags).toEqual(
      expect.arrayContaining([
        ['t', 'bug'],
        ['t', 'urgent'],
        ['t', 'help-wanted'],
      ])
    );
  });

  it('builds an issue with no labels by default', () => {
    const event = buildIssue(OWNER_PUBKEY, 'hello-toon', 'No labels', 'body');

    const tTags = event.tags.filter((t) => t[0] === 't');
    expect(tTags).toHaveLength(0);
  });
});

describe('buildComment (kind:1622)', () => {
  it('builds a comment with a/e/p tags', () => {
    const event = buildComment(
      OWNER_PUBKEY,
      'hello-toon',
      EVENT_ID,
      AUTHOR_PUBKEY,
      'Comment body',
      'reply'
    );

    expect(event.kind).toBe(1622);
    expect(COMMENT_KIND).toBe(1622);
    expect(event.content).toBe('Comment body');
    expect(event.tags).toEqual(
      expect.arrayContaining([
        ['a', `30617:${OWNER_PUBKEY}:hello-toon`],
        ['p', AUTHOR_PUBKEY],
      ])
    );
    const eTag = event.tags.find((t) => t[0] === 'e' && t[1] === EVENT_ID);
    expect(eTag).toBeDefined();
  });

  it("defaults to the 'reply' marker when marker is omitted", () => {
    const event = buildComment(
      OWNER_PUBKEY,
      'hello-toon',
      EVENT_ID,
      AUTHOR_PUBKEY,
      'Default marker'
    );

    const eTag = event.tags.find((t) => t[0] === 'e' && t[1] === EVENT_ID);
    expect(eTag).toBeDefined();
    expect(eTag?.[3]).toBe('reply');
  });

  it("builds a comment with the 'root' marker", () => {
    const event = buildComment(
      OWNER_PUBKEY,
      'hello-toon',
      EVENT_ID,
      AUTHOR_PUBKEY,
      'Root comment',
      'root'
    );

    const eTag = event.tags.find((t) => t[0] === 'e' && t[1] === EVENT_ID);
    expect(eTag).toBeDefined();
    expect(eTag?.[3]).toBe('root');
  });
});

describe('buildPatch (kind:1617)', () => {
  const commits = [{ sha: 'abc123', parentSha: 'def456' }];

  it('builds a patch with a/p/subject/commit/parent-commit/t tags', () => {
    const event = buildPatch(
      OWNER_PUBKEY,
      'hello-toon',
      'Fix readme',
      commits,
      'feature/fix'
    );

    expect(event.kind).toBe(1617);
    expect(event.tags).toEqual(
      expect.arrayContaining([
        ['a', `30617:${OWNER_PUBKEY}:hello-toon`],
        ['p', OWNER_PUBKEY],
        ['subject', 'Fix readme'],
        ['commit', 'abc123'],
        ['parent-commit', 'def456'],
        ['t', 'feature/fix'],
      ])
    );
  });

  it('omits the branch t tag when branchTag is not provided', () => {
    const event = buildPatch(OWNER_PUBKEY, 'hello-toon', 'Fix readme', commits);

    const tTags = event.tags.filter((t) => t[0] === 't');
    expect(tTags).toHaveLength(0);
  });

  it('defaults to empty content (seed pipeline behavior)', () => {
    const event = buildPatch(OWNER_PUBKEY, 'hello-toon', 'Fix readme', commits);

    expect(event.content).toBe('');
  });

  it('carries real git format-patch text when content is provided', () => {
    const patchText = [
      'From abc123 Mon Sep 17 00:00:00 2001',
      'From: Alice <alice@nostr>',
      'Subject: [PATCH] Fix readme',
      '',
      '--- a/README.md',
      '+++ b/README.md',
      '@@ -1 +1 @@',
      '-hello',
      '+hello world',
      '',
    ].join('\n');

    const event = buildPatch(
      OWNER_PUBKEY,
      'hello-toon',
      'Fix readme',
      commits,
      'feature/fix',
      patchText
    );

    expect(event.kind).toBe(1617);
    expect(event.content).toBe(patchText);
    // Tags are unaffected by content
    expect(event.tags).toEqual(
      expect.arrayContaining([
        ['subject', 'Fix readme'],
        ['commit', 'abc123'],
        ['t', 'feature/fix'],
      ])
    );
  });
});

describe('buildStatus (kinds 1630-1633)', () => {
  it('builds each status kind with an e tag', () => {
    for (const statusKind of [1630, 1631, 1632, 1633] as const) {
      const event = buildStatus(EVENT_ID, statusKind);
      expect(event.kind).toBe(statusKind);
      expect(event.tags).toEqual(expect.arrayContaining([['e', EVENT_ID]]));
    }
  });

  it('includes a p tag when targetPubkey is provided', () => {
    const event = buildStatus(EVENT_ID, 1631, OWNER_PUBKEY);

    expect(event.tags).toEqual(
      expect.arrayContaining([
        ['e', EVENT_ID],
        ['p', OWNER_PUBKEY],
      ])
    );
  });

  it('omits the p tag when targetPubkey is not provided', () => {
    const event = buildStatus(EVENT_ID, 1630);

    const pTags = event.tags.filter((t) => t[0] === 'p');
    expect(pTags).toHaveLength(0);
  });
});
