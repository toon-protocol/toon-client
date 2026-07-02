/**
 * Tests for the read-path download layer (#278): SHA-1 verification doubling
 * as type discovery, the gateway fallback chain, the parallel-download
 * concurrency cap, integrity rejection, and object-graph closure walking
 * (including the gitlink carve-out).
 */

import { describe, it, expect } from 'vitest';
import {
  createGitBlob,
  createGitCommit,
  createGitTree,
  createGitTag,
} from './objects.js';
import {
  downloadGitObjects,
  fetchTxBytes,
  ObjectIntegrityError,
  referencedShas,
  verifyObjectBody,
  walkClosure,
  type FetchedObject,
  type FetchLike,
} from './object-fetch.js';

const TX = (n: number): string => String(n).padStart(43, 'x');

function ok(bytes: Uint8Array): ReturnType<FetchLike> {
  const copy = bytes.slice();
  return Promise.resolve({
    ok: true,
    arrayBuffer: async () =>
      copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength),
  });
}

const notOk = (): ReturnType<FetchLike> =>
  Promise.resolve({ ok: false, arrayBuffer: async () => new ArrayBuffer(0) });

// ---------------------------------------------------------------------------
// Fixtures: a tiny consistent object graph built with the write-path builders
// ---------------------------------------------------------------------------

const blob = createGitBlob('hello, toon\n');
const tree = createGitTree([
  { mode: '100644', name: 'hello.txt', sha: blob.sha },
]);
const rootCommit = createGitCommit({
  treeSha: tree.sha,
  authorName: 'A',
  authorPubkey: 'ab'.repeat(32),
  message: 'root',
  timestamp: 1700000000,
});
const childCommit = createGitCommit({
  treeSha: tree.sha,
  parentSha: rootCommit.sha,
  authorName: 'A',
  authorPubkey: 'ab'.repeat(32),
  message: 'child',
  timestamp: 1700000001,
});
const tag = createGitTag({
  objectSha: childCommit.sha,
  objectType: 'commit',
  tagName: 'v1',
  taggerName: 'A',
  taggerPubkey: 'ab'.repeat(32),
  message: 'release',
  timestamp: 1700000002,
});

function fetched(
  o: { sha: string; body: Buffer },
  type: FetchedObject['type']
): FetchedObject {
  return { sha: o.sha, type, body: o.body };
}

// ---------------------------------------------------------------------------
// verifyObjectBody
// ---------------------------------------------------------------------------

describe('verifyObjectBody', () => {
  it.each([
    ['blob', blob],
    ['tree', tree],
    ['commit', childCommit],
    ['tag', tag],
  ] as const)('discovers the %s type by envelope SHA match', (type, object) => {
    const verified = verifyObjectBody(object.sha, new Uint8Array(object.body));
    expect(verified).not.toBeNull();
    expect(verified?.type).toBe(type);
    expect(verified?.sha).toBe(object.sha);
  });

  it('rejects tampered content (no type matches)', () => {
    const tampered = Buffer.from(blob.body);
    tampered[0] = (tampered[0] as number) ^ 0xff;
    expect(verifyObjectBody(blob.sha, new Uint8Array(tampered))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// fetchTxBytes (gateway fallback chain)
// ---------------------------------------------------------------------------

describe('fetchTxBytes', () => {
  it('falls back to the next gateway on failure and returns the first success', async () => {
    const urls: string[] = [];
    const fetchFn: FetchLike = (url) => {
      urls.push(url);
      if (url.startsWith('https://one.example')) return notOk();
      if (url.startsWith('https://two.example')) throw new Error('boom');
      return ok(new Uint8Array([1, 2, 3]));
    };
    const bytes = await fetchTxBytes(TX(1), {
      gateways: [
        'https://one.example',
        'https://two.example',
        'https://three.example',
      ],
      fetchFn,
    });
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(urls).toEqual([
      `https://one.example/${TX(1)}`,
      `https://two.example/${TX(1)}`,
      `https://three.example/${TX(1)}`,
    ]);
  });

  it('returns null when every gateway fails', async () => {
    const bytes = await fetchTxBytes(TX(2), {
      gateways: ['https://one.example', 'https://two.example'],
      fetchFn: notOk,
    });
    expect(bytes).toBeNull();
  });

  it('rejects malformed txIds without any request', async () => {
    let called = 0;
    const bytes = await fetchTxBytes('not-a-txid', {
      gateways: ['https://one.example'],
      fetchFn: () => {
        called++;
        return notOk();
      },
    });
    expect(bytes).toBeNull();
    expect(called).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// downloadGitObjects
// ---------------------------------------------------------------------------

describe('downloadGitObjects', () => {
  const store = new Map<string, Buffer>([
    [TX(1), blob.body],
    [TX(2), tree.body],
    [TX(3), childCommit.body],
  ]);
  const gatewayFetch: FetchLike = (url) => {
    const txId = url.split('/').pop() as string;
    const body = store.get(txId);
    return body ? ok(new Uint8Array(body)) : notOk();
  };

  it('downloads, verifies, and types a batch; reports unavailable ones', async () => {
    const result = await downloadGitObjects(
      [
        [blob.sha, TX(1)],
        [tree.sha, TX(2)],
        [childCommit.sha, TX(3)],
        ['ff'.repeat(20), TX(9)], // not in the store
      ],
      { gateways: ['https://gw.example'], fetchFn: gatewayFetch }
    );
    expect(result.objects.get(blob.sha)?.type).toBe('blob');
    expect(result.objects.get(tree.sha)?.type).toBe('tree');
    expect(result.objects.get(childCommit.sha)?.type).toBe('commit');
    expect(result.unavailable).toEqual([{ sha: 'ff'.repeat(20), txId: TX(9) }]);
  });

  it('throws ObjectIntegrityError when a body does not match its SHA', async () => {
    await expect(
      downloadGitObjects([[blob.sha, TX(2)]], {
        gateways: ['https://gw.example'],
        fetchFn: gatewayFetch, // serves the TREE body for the blob's SHA
      })
    ).rejects.toThrow(ObjectIntegrityError);
  });

  it('caps concurrent downloads', async () => {
    let inFlight = 0;
    let peak = 0;
    const slowFetch: FetchLike = async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return ok(new Uint8Array(blob.body));
    };
    const entries: [string, string][] = Array.from({ length: 12 }, (_, i) => [
      blob.sha,
      TX(i),
    ]);
    await downloadGitObjects(entries, {
      gateways: ['https://gw.example'],
      fetchFn: slowFetch,
      concurrency: 3,
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// referencedShas + walkClosure
// ---------------------------------------------------------------------------

describe('referencedShas', () => {
  it('extracts tree + parents from commits', () => {
    expect(referencedShas(fetched(childCommit, 'commit'))).toEqual([
      tree.sha,
      rootCommit.sha,
    ]);
  });

  it('extracts entry SHAs from trees but skips gitlinks', () => {
    const submodule = createGitTree([
      { mode: '100644', name: 'a.txt', sha: blob.sha },
      { mode: '160000', name: 'vendored', sha: 'ee'.repeat(20) },
    ]);
    expect(referencedShas(fetched(submodule, 'tree'))).toEqual([blob.sha]);
  });

  it('extracts the tagged object from tags and nothing from blobs', () => {
    expect(referencedShas(fetched(tag, 'tag'))).toEqual([childCommit.sha]);
    expect(referencedShas(fetched(blob, 'blob'))).toEqual([]);
  });
});

describe('walkClosure', () => {
  const objects = new Map<string, FetchedObject>([
    [blob.sha, fetched(blob, 'blob')],
    [tree.sha, fetched(tree, 'tree')],
    [rootCommit.sha, fetched(rootCommit, 'commit')],
    [childCommit.sha, fetched(childCommit, 'commit')],
    [tag.sha, fetched(tag, 'tag')],
  ]);

  it('reaches the full graph from a tag tip with nothing missing', () => {
    const result = walkClosure([tag.sha], objects);
    expect(result.missing).toEqual([]);
    expect(result.reachable).toEqual(
      new Set([tag.sha, childCommit.sha, rootCommit.sha, tree.sha, blob.sha])
    );
  });

  it('reports reachable-but-absent SHAs as missing', () => {
    const withoutBlob = new Map(objects);
    withoutBlob.delete(blob.sha);
    const result = walkClosure([childCommit.sha], withoutBlob);
    expect(result.missing).toEqual([blob.sha]);
  });

  it('does not descend into locally-present objects (fetch delta)', () => {
    // Only the child commit was downloaded; its parent + tree are local.
    const delta = new Map([[childCommit.sha, fetched(childCommit, 'commit')]]);
    const present = new Set([rootCommit.sha, tree.sha]);
    const result = walkClosure([childCommit.sha], delta, present);
    expect(result.missing).toEqual([]);
    expect(result.reachable).toEqual(new Set([childCommit.sha]));
  });
});
