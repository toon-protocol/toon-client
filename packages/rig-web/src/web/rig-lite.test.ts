/**
 * rig-lite parser tests — the node-testable core of the single-file
 * free-tier Arweave build (../../lite/rig-lite.js): bech32 owner handling,
 * NIP-34 event parsing, git tree/commit decoding, SHA-1 body verification,
 * and the mini-markdown renderer's escaping.
 */

import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  hexToNpub,
  ownerToHex,
  parseCommit,
  parseRefsEvent,
  parseTree,
  renderMarkdown,
  verifyBody,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-expect-error plain JS module without type declarations (by design)
} from '../../lite/rig-lite.js';

// A real (pubkey, npub) pair produced by nostr-tools nip19.
const HEX = 'de4a6ded7d0c4d240bbac9ef0bbcd950ccc8dfb9b2f7d3d5e41a4e150a9106f2';
const NPUB = 'npub1me9xmmtap3xjgza6e8hsh0xe2rxv3haektma840yrf8p2z53qmeq65a5y6';

describe('owner encoding', () => {
  it('decodes an npub and passes hex through', () => {
    expect(ownerToHex(NPUB)).toBe(HEX);
    expect(ownerToHex(HEX)).toBe(HEX);
    expect(ownerToHex(HEX.toUpperCase())).toBe(HEX);
  });

  it('round-trips hex → npub → hex', () => {
    expect(hexToNpub(HEX)).toBe(NPUB);
    expect(ownerToHex(hexToNpub(HEX))).toBe(HEX);
  });

  it('rejects garbage and bad checksums', () => {
    expect(ownerToHex('not-an-owner')).toBeNull();
    expect(ownerToHex(NPUB.slice(0, -1) + (NPUB.endsWith('7') ? '8' : '7'))).toBeNull();
  });
});

describe('event parsing', () => {
  it('parses refs, HEAD, and the arweave map from a kind:30618 event', () => {
    const { refs, head, arweave } = parseRefsEvent({
      tags: [
        ['d', 'demo'],
        ['r', 'refs/heads/main', 'a'.repeat(40)],
        ['r', 'refs/tags/v1', 'b'.repeat(40)],
        ['HEAD', 'ref: refs/heads/main'],
        ['arweave', 'a'.repeat(40), 'T'.repeat(43)],
      ],
    });
    expect(refs.get('refs/heads/main')).toBe('a'.repeat(40));
    expect(refs.get('refs/tags/v1')).toBe('b'.repeat(40));
    expect(head).toBe('refs/heads/main');
    expect(arweave.get('a'.repeat(40))).toBe('T'.repeat(43));
  });

  it('falls back to the first ref when HEAD is absent', () => {
    const { head } = parseRefsEvent({
      tags: [['r', 'refs/heads/dev', 'c'.repeat(40)]],
    });
    expect(head).toBe('refs/heads/dev');
  });
});

describe('git object parsing', () => {
  function treeBody(entries: { mode: string; name: string; sha: string }[]): Uint8Array {
    const parts: number[] = [];
    const enc = new TextEncoder();
    for (const e of entries) {
      parts.push(...enc.encode(`${e.mode} ${e.name}`), 0);
      for (let i = 0; i < 40; i += 2) parts.push(parseInt(e.sha.slice(i, i + 2), 16));
    }
    return new Uint8Array(parts);
  }

  it('parses tree entries and sorts directories first', () => {
    const body = treeBody([
      { mode: '100644', name: 'README.md', sha: '11'.repeat(20) },
      { mode: '40000', name: 'src', sha: '22'.repeat(20) },
      { mode: '100644', name: 'a.txt', sha: '33'.repeat(20) },
    ]);
    const entries = parseTree(body);
    // Directories first, then files in locale order (case-insensitive).
    expect(entries.map((e: { name: string }) => e.name)).toEqual(['src', 'a.txt', 'README.md']);
    expect(entries[0]).toMatchObject({ isTree: true, sha: '22'.repeat(20) });
  });

  it('parses a commit: tree, parents, author, date, message', () => {
    const body = new TextEncoder().encode(
      `tree ${'aa'.repeat(20)}\n` +
        `parent ${'bb'.repeat(20)}\n` +
        'author Jane Dev <jane@dev> 1752000000 +0000\n' +
        'committer Jane Dev <jane@dev> 1752000000 +0000\n' +
        '\n' +
        'feat: the thing\n\nbody text\n'
    );
    const commit = parseCommit(body);
    expect(commit.tree).toBe('aa'.repeat(20));
    expect(commit.parents).toEqual(['bb'.repeat(20)]);
    expect(commit.author).toBe('Jane Dev');
    expect(commit.date?.getTime()).toBe(1752000000000);
    expect(commit.message.split('\n')[0]).toBe('feat: the thing');
  });

  it('verifyBody authenticates a body by discovering its type', async () => {
    const body = new TextEncoder().encode('hello rig-lite\n');
    // git blob sha: sha1("blob 15\0hello rig-lite\n")
    const envelope = new TextEncoder().encode(`blob ${body.length}\0hello rig-lite\n`);
    const digest = await crypto.subtle.digest('SHA-1', envelope);
    const sha = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    expect(await verifyBody(sha, body)).toBe('blob');
    expect(await verifyBody('0'.repeat(40), body)).toBeNull();
  });
});

describe('mini markdown', () => {
  it('renders headings, lists, fences, inline code, and links', () => {
    const html = renderMarkdown(
      '# Title\n\nSome *em* and **strong** and `code`.\n\n- one\n- two\n\n```\nraw < block\n```\n\n[site](https://example.com)'
    );
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<em>em</em>');
    expect(html).toContain('<strong>strong</strong>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain('<pre><code>raw &lt; block</code></pre>');
    expect(html).toContain('<a href="https://example.com"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('escapes HTML everywhere (no script injection through a README)', () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\n# <img onerror=x>');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(escapeHtml('<&">')).toBe('&lt;&amp;&quot;&gt;');
  });
});
