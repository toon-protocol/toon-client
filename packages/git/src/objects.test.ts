/**
 * Unit tests for pure git object construction (objects.ts).
 *
 * Ported from packages/rig/tests/e2e/seed/__tests__/git-builder.test.ts
 * (#223) — pure-builder cases only; upload/network coverage stays with the
 * seed lib until the Publisher ticket (#226). SHA-1 vectors below were
 * generated with real `git hash-object -t <type> --stdin --literally`.
 */

import { describe, it, expect } from 'vitest';
import {
  MAX_OBJECT_SIZE,
  createGitBlob,
  createGitCommit,
  createGitTag,
  createGitTree,
  hashGitObject,
  type GitObjectType,
} from './objects.js';

const ALICE_PUBKEY =
  '55c2a467881059a942fdc6908b041273885b8720bfa8fcf2f5f9c20a73b0964d';

describe('createGitBlob', () => {
  it('computes the SHA-1 over the full envelope (matches git hash-object)', () => {
    // `printf 'hello world\n' | git hash-object -t blob --stdin`
    const result = createGitBlob('hello world\n');
    expect(result.sha).toBe('3b18e512dba79e4c8300dd08aeb37f8e728b8dad');
    expect(result.body).toBeInstanceOf(Buffer);
    expect(result.buffer).toBeInstanceOf(Buffer);
  });

  it('returns body (content only) separate from the full buffer', () => {
    const content = 'test content';
    const result = createGitBlob(content);

    // Body should be content only (no header)
    expect(result.body.toString('utf-8')).toBe(content);

    // Buffer should include header
    expect(result.buffer.length).toBeGreaterThan(result.body.length);
    expect(result.buffer.toString('utf-8')).toContain('blob ');
  });
});

describe('createGitTree', () => {
  const entries = [
    {
      mode: '100644',
      name: 'README.md',
      sha: 'a0423896973644771497bdc03eb99d5281615b51',
    },
    {
      mode: '100644',
      name: 'LICENSE',
      sha: 'b0423896973644771497bdc03eb99d5281615b52',
    },
  ];

  it('constructs a tree with byte-sorted entries and raw 20-byte SHAs', () => {
    const result = createGitTree(entries);

    expect(result.sha).toHaveLength(40);
    // Vector generated with real git (LICENSE sorts before README.md)
    expect(result.sha).toBe('ae0cb75f2c395ff83184e6dafbde3e93c5310307');

    const bodyStr = result.body.toString('binary');
    const licenseIdx = bodyStr.indexOf('LICENSE');
    const readmeIdx = bodyStr.indexOf('README.md');
    expect(licenseIdx).toBeLessThan(readmeIdx);

    // 2 entries × (7-byte "<mode> " + name + NUL + 20-byte raw sha)
    expect(result.body.length).toBe(
      entries.reduce(
        (n, e) => n + e.mode.length + 1 + e.name.length + 1 + 20,
        0
      )
    );
  });

  it('is order-independent (sorts internally)', () => {
    const reversed = createGitTree([...entries].reverse());
    expect(reversed.sha).toBe(createGitTree(entries).sha);
  });
});

describe('createGitCommit', () => {
  it('constructs a root commit matching git hash-object', () => {
    // Vector: `git hash-object -t commit --stdin --literally` over the same content
    const result = createGitCommit({
      treeSha: 'abcdef1234567890abcdef1234567890abcdef12',
      authorName: 'Alice',
      authorPubkey: ALICE_PUBKEY,
      message: 'Initial commit\n',
      timestamp: 1700000000,
    });

    expect(result.sha).toBe('ae569175e2b29ec3a8384c93ffd9102e21e83b7b');
    const bodyStr = result.body.toString('utf-8');
    expect(bodyStr).toContain('tree abcdef1234567890abcdef1234567890abcdef12');
    expect(bodyStr).toContain('author Alice');
    expect(bodyStr).toContain('@nostr>');
    expect(bodyStr).not.toContain('parent ');
  });

  it('includes the parent line when parentSha is provided', () => {
    const result = createGitCommit({
      treeSha: 'abcdef1234567890abcdef1234567890abcdef12',
      parentSha: '1111111111111111111111111111111111111111',
      authorName: 'Bob',
      authorPubkey:
        '7937ffc0c5a0238768da798d26394a33b554926d739c445fd508e36642ebc286',
      message: 'Second commit\n',
      timestamp: 1700000100,
    });

    expect(result.sha).toHaveLength(40);
    const bodyStr = result.body.toString('utf-8');
    expect(bodyStr).toContain(
      'parent 1111111111111111111111111111111111111111'
    );
    expect(bodyStr).toContain('author Bob');
  });
});

describe('createGitTag (annotated tag)', () => {
  it('constructs an annotated tag matching git hash-object', () => {
    // Vector: `git hash-object -t tag --stdin --literally` over the same content
    const result = createGitTag({
      objectSha: '1111111111111111111111111111111111111111',
      objectType: 'commit',
      tagName: 'v1.0.0',
      taggerName: 'Alice',
      taggerPubkey: ALICE_PUBKEY,
      message: 'Release v1.0.0\n',
      timestamp: 1700000000,
    });

    expect(result.sha).toBe('11a46d8ad553872b3fe18c552d3b03cf60685359');
    const bodyStr = result.body.toString('utf-8');
    expect(bodyStr).toContain(
      'object 1111111111111111111111111111111111111111'
    );
    expect(bodyStr).toContain('type commit');
    expect(bodyStr).toContain('tag v1.0.0');
    expect(bodyStr).toContain(`tagger Alice <${ALICE_PUBKEY}@nostr>`);
    expect(result.buffer.toString('utf-8')).toContain('tag ');
  });

  it("is part of the GitObjectType union ('tag')", () => {
    const type: GitObjectType = 'tag';
    const result = hashGitObject(type, Buffer.from('x'));
    expect(result.buffer.toString('utf-8')).toMatch(/^tag 1\0x$/);
  });
});

describe('hashGitObject', () => {
  it('hashes the envelope for every object type', () => {
    const types: GitObjectType[] = ['blob', 'tree', 'commit', 'tag'];
    for (const type of types) {
      const body = Buffer.from('content');
      const result = hashGitObject(type, body);
      expect(result.sha).toHaveLength(40);
      expect(result.buffer.toString('utf-8')).toBe(`${type} 7\0content`);
      expect(result.body).toBe(body);
    }
  });

  it('agrees with createGitBlob', () => {
    expect(hashGitObject('blob', Buffer.from('hello world\n')).sha).toBe(
      createGitBlob('hello world\n').sha
    );
  });
});

describe('MAX_OBJECT_SIZE', () => {
  it('is the 95KB free-tier safety margin (R10-005)', () => {
    expect(MAX_OBJECT_SIZE).toBe(95 * 1024);
  });
});
