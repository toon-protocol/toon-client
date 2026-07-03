import { describe, it, expect } from 'vitest';
import { type NostrEvent } from '../types.js';
import {
  parseRepoAnnouncement,
  parseRepoRefs,
  parseIssue,
  parsePR,
  parseComment,
  resolvePRStatus,
  resolveIssueStatus,
  repoAuthorizedAuthors,
} from './nip34.js';
import {
  parseProfile,
  parseNote,
  parseThreadRefs,
  parseFollowList,
  parseReaction,
  parseRepost,
} from './social.js';
import {
  parseImeta,
  parseInlineMedia,
  parseFileMetadata,
  parseMediaPost,
} from './media.js';

function evt(partial: Partial<NostrEvent> & { kind: number }): NostrEvent {
  return {
    id: partial.id ?? 'id',
    pubkey: partial.pubkey ?? 'pk',
    created_at: partial.created_at ?? 1,
    kind: partial.kind,
    tags: partial.tags ?? [],
    content: partial.content ?? '',
    sig: partial.sig ?? 'sig',
  };
}

describe('nip34 parsers', () => {
  it('parses a repo announcement and rejects wrong kind', () => {
    const repo = parseRepoAnnouncement(
      evt({
        kind: 30617,
        tags: [
          ['d', 'my-repo'],
          ['name', 'My Repo'],
          ['r', 'HEAD', 'trunk'],
          ['clone', 'https://x/y.git'],
        ],
      })
    );
    expect(repo?.repoId).toBe('my-repo');
    expect(repo?.name).toBe('My Repo');
    expect(repo?.defaultBranch).toBe('trunk');
    expect(repo?.cloneUrls).toEqual(['https://x/y.git']);
    expect(parseRepoAnnouncement(evt({ kind: 1 }))).toBeNull();
  });

  it('parses refs + arweave map', () => {
    const refs = parseRepoRefs(
      evt({
        kind: 30618,
        tags: [
          ['d', 'my-repo'],
          ['r', 'main', 'abc'],
          ['arweave', 'abc', 'tx123'],
        ],
      })
    );
    expect(refs?.refs.get('main')).toBe('abc');
    expect(refs?.arweaveMap.get('abc')).toBe('tx123');
  });

  it('parses issue, PR, comment', () => {
    expect(parseIssue(evt({ kind: 1621, tags: [['subject', 'Bug']], content: 'x' }))?.title).toBe('Bug');
    expect(parsePR(evt({ kind: 1617, tags: [['commit', 'sha1']] }))?.commitShas).toEqual(['sha1']);
    expect(parseComment(evt({ kind: 1622, tags: [['e', 'parent']] }))?.parentEventId).toBe('parent');
    expect(parseComment(evt({ kind: 1622, tags: [] }))).toBeNull();
  });

  it('surfaces the PR body from the description tag; content stays the patch text', () => {
    const withBody = parsePR(
      evt({
        kind: 1617,
        tags: [
          ['subject', 'Add feature'],
          ['description', 'Why: the feature was missing.'],
        ],
        content: 'From abc123 Mon Sep 17 00:00:00 2001\n',
      })
    );
    expect(withBody?.description).toBe('Why: the feature was missing.');
    expect(withBody?.content).toBe('From abc123 Mon Sep 17 00:00:00 2001\n');
    // No tag → no description field (renderers fall back to the patch text).
    expect(parsePR(evt({ kind: 1617, tags: [] }))?.description).toBeUndefined();
  });

  it('resolves PR + issue status by latest AUTHORIZED event', () => {
    const owner = 'a'.repeat(64);
    const authorized = [owner];
    const status = resolvePRStatus(
      'pr1',
      [
        evt({ kind: 1630, pubkey: owner, created_at: 1, tags: [['e', 'pr1']] }),
        evt({ kind: 1632, pubkey: owner, created_at: 5, tags: [['e', 'pr1']] }),
      ],
      authorized
    );
    expect(status).toBe('closed');
    expect(
      resolveIssueStatus(
        'i1',
        [evt({ kind: 1632, pubkey: owner, tags: [['e', 'i1']] })],
        authorized
      )
    ).toBe('closed');
    expect(resolveIssueStatus('i1', [], authorized)).toBe('open');
  });

  it('parses the maintainers tag and combines with the owner (#287)', () => {
    const m1 = 'b'.repeat(64);
    const m2 = 'c'.repeat(64);
    const repo = parseRepoAnnouncement(
      evt({
        kind: 30617,
        pubkey: 'a'.repeat(64),
        tags: [
          ['d', 'my-repo'],
          ['name', 'My Repo'],
          ['maintainers', m1, m2, 'NOT-HEX'],
        ],
      })
    );
    expect(repo?.maintainers).toEqual([m1, m2]);
    const authorized = repoAuthorizedAuthors(repo!);
    expect(authorized.has('a'.repeat(64))).toBe(true); // owner (implicit)
    expect(authorized.has(m1)).toBe(true);
    expect(authorized.has(m2)).toBe(true);
    // No tag → owner-only authority.
    const bare = parseRepoAnnouncement(
      evt({ kind: 30617, pubkey: 'a'.repeat(64), tags: [['d', 'r']] })
    );
    expect(bare?.maintainers).toEqual([]);
  });

  it('ignores UNAUTHORIZED status events (spoof regression, #287)', () => {
    const owner = 'a'.repeat(64);
    const maintainer = 'b'.repeat(64);
    const stranger = 'f'.repeat(64);
    const authorized = new Set([owner, maintainer]);

    // A funded stranger publishes a LATER draft status — it must NOT win.
    const prStatus = resolvePRStatus(
      'pr1',
      [
        evt({ kind: 1630, pubkey: owner, created_at: 1, tags: [['e', 'pr1']] }),
        evt({
          kind: 1633,
          pubkey: stranger,
          created_at: 99,
          tags: [['e', 'pr1']],
        }),
      ],
      authorized
    );
    expect(prStatus).toBe('open'); // stranger's draft ignored

    // A declared maintainer's status DOES move state.
    const byMaintainer = resolvePRStatus(
      'pr1',
      [
        evt({ kind: 1630, pubkey: owner, created_at: 1, tags: [['e', 'pr1']] }),
        evt({
          kind: 1632,
          pubkey: maintainer,
          created_at: 5,
          tags: [['e', 'pr1']],
        }),
      ],
      authorized
    );
    expect(byMaintainer).toBe('closed');

    // An unauthorized close event does NOT close an issue.
    expect(
      resolveIssueStatus(
        'i1',
        [evt({ kind: 1632, pubkey: stranger, tags: [['e', 'i1']] })],
        authorized
      )
    ).toBe('open');
    // The owner's close does.
    expect(
      resolveIssueStatus(
        'i1',
        [evt({ kind: 1632, pubkey: owner, tags: [['e', 'i1']] })],
        authorized
      )
    ).toBe('closed');
  });
});

describe('social parsers', () => {
  it('parses profile JSON and rejects bad JSON', () => {
    const p = parseProfile(evt({ kind: 0, content: '{"name":"alice","nip05":"a@b"}' }));
    expect(p?.name).toBe('alice');
    expect(p?.nip05).toBe('a@b');
    expect(parseProfile(evt({ kind: 0, content: 'not json' }))).toBeNull();
  });

  it('resolves NIP-10 thread refs (marked + positional)', () => {
    const marked = parseThreadRefs([
      ['e', 'root', '', 'root'],
      ['e', 'parent', '', 'reply'],
      ['p', 'pk1'],
    ]);
    expect(marked.rootId).toBe('root');
    expect(marked.replyToId).toBe('parent');
    expect(marked.mentionedPubkeys).toEqual(['pk1']);

    const positional = parseThreadRefs([
      ['e', 'a'],
      ['e', 'b'],
    ]);
    expect(positional.rootId).toBe('a');
    expect(positional.replyToId).toBe('b');
  });

  it('flags replies and top-level notes', () => {
    expect(parseNote(evt({ kind: 1, content: 'hi' }))?.isReply).toBe(false);
    expect(parseNote(evt({ kind: 1, tags: [['e', 'x', '', 'reply']] }))?.isReply).toBe(true);
  });

  it('parses follow list, reaction, repost', () => {
    expect(parseFollowList(evt({ kind: 3, tags: [['p', 'a'], ['p', 'b']] }))?.follows).toEqual(['a', 'b']);
    const r = parseReaction(evt({ kind: 7, content: '+', tags: [['e', 'tgt'], ['p', 'auth']] }));
    expect(r?.targetEventId).toBe('tgt');
    expect(r?.content).toBe('+');
    const rp = parseRepost(evt({ kind: 16, tags: [['e', 'orig'], ['k', '1']] }));
    expect(rp?.repostedEventId).toBe('orig');
    expect(rp?.repostedKind).toBe(1);
  });
});

describe('media parsers', () => {
  it('parses an imeta tag with multi-word alt', () => {
    const v = parseImeta(['imeta', 'url https://ar/x', 'm image/png', 'x deadbeef', 'dim 4x2', 'alt a cat']);
    expect(v?.url).toBe('https://ar/x');
    expect(v?.mime).toBe('image/png');
    expect(v?.hash).toBe('deadbeef');
    expect(v?.dim).toBe('4x2');
    expect(v?.alt).toBe('a cat');
    expect(parseImeta(['p', 'x'])).toBeNull();
  });

  it('extracts inline media from a note', () => {
    const variants = parseInlineMedia(
      evt({ kind: 1, content: 'see pic', tags: [['imeta', 'url https://ar/a']] })
    );
    expect(variants).toHaveLength(1);
    expect(variants[0]?.url).toBe('https://ar/a');
  });

  it('parses NIP-94 file metadata', () => {
    const f = parseFileMetadata(
      evt({ kind: 1063, content: 'cap', tags: [['url', 'https://ar/f'], ['m', 'video/mp4'], ['size', '123']] })
    );
    expect(f?.url).toBe('https://ar/f');
    expect(f?.mime).toBe('video/mp4');
    expect(f?.size).toBe(123);
    expect(parseFileMetadata(evt({ kind: 1063, tags: [] }))).toBeNull();
  });

  it('parses picture (20) and short video (22) posts', () => {
    const pic = parseMediaPost(
      evt({ kind: 20, tags: [['title', 'Sunset'], ['imeta', 'url https://ar/p'], ['t', 'nature']] })
    );
    expect(pic?.mediaType).toBe('picture');
    expect(pic?.short).toBe(false);
    expect(pic?.title).toBe('Sunset');
    expect(pic?.variants[0]?.url).toBe('https://ar/p');
    expect(pic?.hashtags).toEqual(['nature']);

    const vid = parseMediaPost(evt({ kind: 22, tags: [['duration', '15']] }));
    expect(vid?.mediaType).toBe('video');
    expect(vid?.short).toBe(true);
    expect(vid?.durationSec).toBe(15);

    expect(parseMediaPost(evt({ kind: 1 }))).toBeNull();
  });
});
