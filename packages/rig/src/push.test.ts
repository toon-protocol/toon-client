/**
 * planPush/executePush tests against a REAL fixture repository (same pattern
 * as repo-reader.test.ts) + canned RemoteState objects and a mock Publisher.
 * No network anywhere: resolveMissing is injected, the Publisher is a mock.
 *
 * Fixture shape:
 *   main:        commit1 (README, src/a.ts) → commit2 (README edit, src/b.ts)
 *   feature/x:   commit3 (branched from commit2, adds src/c.ts)
 *   refs/tags/v1: annotated tag on commit1
 *   big:         commit4 (branched from commit1, adds big.bin ~200KB)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EMPTY_BLOB_SHA, hashGitObject, MAX_OBJECT_SIZE } from './objects.js';
import type { UnsignedEvent } from './nip34-events.js';
import type {
  FeeRates,
  GitObjectUpload,
  PublishReceipt,
  Publisher,
  UploadReceipt,
} from './publisher.js';
import { GitRepoReader } from './repo-reader.js';
import type { RemoteState } from './remote-state.js';
import {
  NonFastForwardError,
  OversizeObjectsError,
  executePush,
  planPush,
} from './push.js';

// ---------------------------------------------------------------------------
// Fixture repository
// ---------------------------------------------------------------------------

let repoDir: string;
let reader: GitRepoReader;
let commit1 = '';
let commit2 = '';
let featureCommit = '';
let tagSha = '';
/** Commit on the `empty` branch adding a zero-byte file + a real file. */
let emptyCommit = '';
/** Orphan commit whose root tree is the empty TREE object (allow-empty). */
let emptyTreeCommit = '';
/** All objects reachable from commit1 (the "remote already has these" set). */
let commit1Objects: string[] = [];
/** All objects reachable from main + feature/x + v1 tag (full first push). */
let allObjects: string[] = [];

const REPO_ID = 'push-fixture';
const RELAYS = ['wss://relay.test'];
const FEE_RATES: FeeRates = { uploadFeePerByte: 10n, eventFee: 500n };
const UNKNOWN_SHA = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@test',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@test',
      GIT_AUTHOR_DATE: '2026-01-02T03:04:05Z',
      GIT_COMMITTER_DATE: '2026-01-02T03:04:05Z',
    },
  }).trim();
}

/** SHAs of every object reachable from `revs`, via independent plumbing. */
function reachableObjects(revs: string[], cwd: string): string[] {
  const out = git(['rev-list', '--objects', ...revs], cwd);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split(' ')[0]!);
}

beforeAll(() => {
  repoDir = mkdtempSync(join(tmpdir(), 'toon-push-fixture-'));
  git(['init', '--initial-branch=main'], repoDir);

  writeFileSync(join(repoDir, 'README.md'), '# push fixture\n');
  mkdirSync(join(repoDir, 'src'));
  writeFileSync(join(repoDir, 'src', 'a.ts'), 'export const a = 1;\n');
  git(['add', '.'], repoDir);
  git(['commit', '-m', 'first'], repoDir);
  commit1 = git(['rev-parse', 'HEAD'], repoDir);
  git(['tag', '-a', 'v1', '-m', 'version one'], repoDir);
  tagSha = git(['rev-parse', 'refs/tags/v1'], repoDir);

  writeFileSync(join(repoDir, 'README.md'), '# push fixture\n\nedited\n');
  writeFileSync(join(repoDir, 'src', 'b.ts'), 'export const b = 2;\n');
  git(['add', '.'], repoDir);
  git(['commit', '-m', 'second'], repoDir);
  commit2 = git(['rev-parse', 'HEAD'], repoDir);

  git(['checkout', '-b', 'feature/x'], repoDir);
  writeFileSync(join(repoDir, 'src', 'c.ts'), 'export const c = 3;\n');
  git(['add', '.'], repoDir);
  git(['commit', '-m', 'feature'], repoDir);
  featureCommit = git(['rev-parse', 'HEAD'], repoDir);

  // Oversize branch: one blob just over MAX_OBJECT_SIZE, from commit1.
  git(['checkout', '-b', 'big', commit1], repoDir);
  writeFileSync(join(repoDir, 'big.bin'), Buffer.alloc(MAX_OBJECT_SIZE + 1, 7));
  git(['add', 'big.bin'], repoDir);
  git(['commit', '-m', 'big blob'], repoDir);

  // Empty-file branch: one zero-byte file (the git empty blob) + a real file,
  // from commit1. Exercises the empty-blob skip/synthesize path.
  git(['checkout', '-b', 'empty', commit1], repoDir);
  writeFileSync(join(repoDir, 'empty.txt'), '');
  writeFileSync(join(repoDir, 'filled.txt'), 'not empty\n');
  git(['add', '.'], repoDir);
  git(['commit', '-m', 'empty + filled'], repoDir);
  emptyCommit = git(['rev-parse', 'HEAD'], repoDir);

  // Empty-TREE branch: an orphan commit with no files, whose root tree is the
  // git empty-tree object (4b825dc6…) — a zero-byte object that is NOT the
  // empty blob and must NOT be skipped by the empty-blob special case.
  git(['checkout', '--orphan', 'emptytree'], repoDir);
  git(['rm', '-rf', '--quiet', '.'], repoDir);
  git(['commit', '--allow-empty', '-m', 'empty tree'], repoDir);
  emptyTreeCommit = git(['rev-parse', 'HEAD'], repoDir);

  git(['checkout', 'main'], repoDir);

  commit1Objects = reachableObjects([commit1], repoDir);
  allObjects = reachableObjects(['main', 'feature/x', 'refs/tags/v1'], repoDir);

  reader = new GitRepoReader(repoDir);
});

afterAll(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Canned RemoteState + mock Publisher
// ---------------------------------------------------------------------------

/** Canned RemoteState: resolveMissing serves ONLY from an extra hint map. */
function cannedRemote(
  partial: Partial<Omit<RemoteState, 'resolveMissing'>> = {},
  resolvable = new Map<string, string>()
): RemoteState {
  return {
    announced: false,
    refs: new Map(),
    headSymref: null,
    shaToTxId: new Map(),
    refsEvent: null,
    announceEvent: null,
    name: null,
    description: null,
    relays: [],
    maintainers: [],
    ...partial,
    resolveMissing: async (shas: string[]) => {
      const out = new Map<string, string>();
      for (const sha of shas) {
        const txId = resolvable.get(sha);
        if (txId) out.set(sha, txId);
      }
      return out;
    },
  };
}

class MockPublisher implements Publisher {
  uploads: GitObjectUpload[] = [];
  published: { event: UnsignedEvent; relayUrls: string[] }[] = [];
  /** Throw on the Nth (0-based) upload call to simulate a crash. */
  failOnUploadIndex = -1;

  async getFeeRates(): Promise<FeeRates> {
    return FEE_RATES;
  }

  async uploadGitObject(upload: GitObjectUpload): Promise<UploadReceipt> {
    if (this.uploads.length === this.failOnUploadIndex) {
      throw new Error('simulated upload crash');
    }
    this.uploads.push(upload);
    return {
      txId: `tx-${upload.sha}`,
      feePaid: BigInt(upload.body.length) * FEE_RATES.uploadFeePerByte,
    };
  }

  async publishEvent(
    event: UnsignedEvent,
    relayUrls: string[]
  ): Promise<PublishReceipt> {
    this.published.push({ event, relayUrls });
    return { eventId: `ev-${this.published.length}`, feePaid: FEE_RATES.eventFee };
  }
}

function tagValues(event: UnsignedEvent, name: string): string[][] {
  return event.tags.filter((t) => t[0] === name).map((t) => t.slice(1));
}

// ---------------------------------------------------------------------------
// planPush
// ---------------------------------------------------------------------------

describe('planPush', () => {
  it('first push: all refs new, full object graph, announce fee included', async () => {
    const remote = cannedRemote();
    const plan = await planPush({
      repoReader: reader,
      remoteState: remote,
      feeRates: FEE_RATES,
      repoId: REPO_ID,
      refs: ['refs/heads/main', 'refs/heads/feature/x', 'refs/tags/v1'],
      announcement: { name: 'Push Fixture', description: 'a test repo' },
    });

    expect(plan.refUpdates).toHaveLength(3);
    for (const update of plan.refUpdates) {
      expect(update.kind).toBe('new');
      expect(update.remoteSha).toBeNull();
    }

    // Delta = every object reachable from the three tips.
    const plannedShas = plan.objects.map((o) => o.sha).sort();
    expect(plannedShas).toEqual([...new Set(allObjects)].sort());

    // Ref state: HEAD target (main) first, all pushed refs present.
    expect(Object.keys(plan.newRefs)[0]).toBe('refs/heads/main');
    expect(plan.headSymref).toBe('refs/heads/main');
    expect(plan.newRefs['refs/heads/feature/x']).toBe(featureCommit);
    expect(plan.newRefs['refs/tags/v1']).toBe(tagSha);

    // Fees: Σ bytes × rate + 2 events (announce + refs).
    const totalBytes = plan.objects.reduce((sum, o) => sum + o.size, 0);
    expect(plan.estimate.objectCount).toBe(plan.objects.length);
    expect(plan.estimate.totalObjectBytes).toBe(totalBytes);
    expect(plan.estimate.uploadFee).toBe(BigInt(totalBytes) * 10n);
    expect(plan.announceNeeded).toBe(true);
    expect(plan.estimate.eventCount).toBe(2);
    expect(plan.estimate.eventFees).toBe(1000n);
    expect(plan.estimate.totalFee).toBe(BigInt(totalBytes) * 10n + 1000n);
    expect(plan.announcement).toEqual({ name: 'Push Fixture', description: 'a test repo' });

    // Sizes are real: the README blob's size matches its content.
    const readmeSha = git(['rev-parse', 'main:README.md'], repoDir);
    const readme = plan.objects.find((o) => o.sha === readmeSha);
    expect(readme?.size).toBe(Buffer.byteLength('# push fixture\n\nedited\n'));
    expect(readme?.path).toBe('README.md');
    expect(readme?.type).toBe('blob');
  });

  it('incremental fast-forward: only the new objects, no announce fee', async () => {
    // Remote has commit1 on main, with every commit1 object already mapped.
    const remote = cannedRemote({
      announced: true,
      refs: new Map([['refs/heads/main', commit1]]),
      headSymref: 'refs/heads/main',
      shaToTxId: new Map(commit1Objects.map((sha) => [sha, `old-${sha}`])),
    });
    const plan = await planPush({
      repoReader: reader,
      remoteState: remote,
      feeRates: FEE_RATES,
      repoId: REPO_ID,
      refs: ['refs/heads/main'],
    });

    expect(plan.refUpdates).toEqual([
      {
        refname: 'refs/heads/main',
        localSha: commit2,
        remoteSha: commit1,
        kind: 'fast-forward',
      },
    ]);

    // Delta = objects of commit2 not reachable from commit1.
    const expected = allObjects.filter(
      (sha) => !commit1Objects.includes(sha)
    );
    const expectedMain = reachableObjects([commit2, `^${commit1}`], repoDir);
    expect(plan.objects.map((o) => o.sha).sort()).toEqual(
      [...new Set(expectedMain)].sort()
    );
    // Sanity: the delta is a subset of "all minus commit1's".
    for (const o of plan.objects) expect(expected).toContain(o.sha);

    expect(plan.announceNeeded).toBe(false);
    expect(plan.estimate.eventCount).toBe(1);
    expect(plan.estimate.eventFees).toBe(500n);

    // Prior hints are carried into the plan for the cumulative merge.
    for (const sha of commit1Objects) {
      expect(plan.knownShaToTxId.get(sha)).toBe(`old-${sha}`);
    }
  });

  it('up-to-date ref: nothing to upload, refs event still planned', async () => {
    const remote = cannedRemote({
      announced: true,
      refs: new Map([['refs/heads/main', commit2]]),
      headSymref: 'refs/heads/main',
    });
    const plan = await planPush({
      repoReader: reader,
      remoteState: remote,
      feeRates: FEE_RATES,
      repoId: REPO_ID,
      refs: ['refs/heads/main'],
    });

    expect(plan.refUpdates[0]?.kind).toBe('up-to-date');
    expect(plan.objects).toEqual([]);
    expect(plan.estimate.totalFee).toBe(500n); // just the refs event
    expect(plan.newRefs['refs/heads/main']).toBe(commit2);
  });

  it('non-fast-forward without force throws NonFastForwardError with data', async () => {
    // Remote main is AHEAD of local main (featureCommit descends commit2).
    const remote = cannedRemote({
      announced: true,
      refs: new Map([['refs/heads/main', featureCommit]]),
    });
    const promise = planPush({
      repoReader: reader,
      remoteState: remote,
      feeRates: FEE_RATES,
      repoId: REPO_ID,
      refs: ['refs/heads/main'],
    });
    await expect(promise).rejects.toBeInstanceOf(NonFastForwardError);
    await expect(promise).rejects.toMatchObject({
      refs: [
        {
          refname: 'refs/heads/main',
          localSha: commit2,
          remoteSha: featureCommit,
        },
      ],
    });
  });

  it('non-fast-forward with force classifies as forced', async () => {
    const remote = cannedRemote({
      announced: true,
      refs: new Map([['refs/heads/main', featureCommit]]),
    });
    const plan = await planPush({
      repoReader: reader,
      remoteState: remote,
      feeRates: FEE_RATES,
      repoId: REPO_ID,
      refs: ['refs/heads/main'],
      force: true,
    });
    expect(plan.refUpdates[0]?.kind).toBe('forced');
    expect(plan.newRefs['refs/heads/main']).toBe(commit2);
  });

  it('remote tip unknown locally counts as non-fast-forward', async () => {
    const remote = cannedRemote({
      announced: true,
      refs: new Map([['refs/heads/main', UNKNOWN_SHA]]),
    });
    await expect(
      planPush({
        repoReader: reader,
        remoteState: remote,
        feeRates: FEE_RATES,
        repoId: REPO_ID,
        refs: ['refs/heads/main'],
      })
    ).rejects.toBeInstanceOf(NonFastForwardError);
  });

  it('oversize object is a hard error carrying path + size', async () => {
    const remote = cannedRemote();
    const promise = planPush({
      repoReader: reader,
      remoteState: remote,
      feeRates: FEE_RATES,
      repoId: REPO_ID,
      refs: ['refs/heads/big'],
    });
    await expect(promise).rejects.toBeInstanceOf(OversizeObjectsError);
    try {
      await promise;
    } catch (err) {
      const oversize = err as OversizeObjectsError;
      expect(oversize.objects).toHaveLength(1);
      expect(oversize.objects[0]).toMatchObject({
        type: 'blob',
        size: MAX_OBJECT_SIZE + 1,
        path: 'big.bin',
      });
      expect(oversize.message).toContain('big.bin');
      expect(oversize.message).toContain(String(MAX_OBJECT_SIZE + 1));
    }
  });

  it('resolveMissing rescues SHAs the arweave tags do not cover', async () => {
    // Remote knows the commit1 tip ref but its tag map lost two objects —
    // the injected resolver (standing in for GraphQL) finds one of them.
    const lostShas = commit1Objects.slice(0, 2);
    const remote = cannedRemote(
      {
        announced: true,
        refs: new Map([['refs/heads/main', commit1]]),
        shaToTxId: new Map(
          commit1Objects
            .filter((sha) => !lostShas.includes(sha))
            .map((sha) => [sha, `old-${sha}`])
        ),
      },
      new Map([[lostShas[0]!, 'resolved-tx']])
    );

    // Force-push feature/x over main so commit1's objects re-enter the
    // delta computation? No — push a NEW ref pointing at commit1 so all of
    // commit1's objects are in the delta while the remote tip set is empty.
    const remoteNoTips = cannedRemote(
      {
        announced: true,
        shaToTxId: remote.shaToTxId,
      },
      new Map([[lostShas[0]!, 'resolved-tx']])
    );
    git(['branch', '-f', 'resolve-me', commit1], repoDir);
    const plan = await planPush({
      repoReader: reader,
      remoteState: remoteNoTips,
      feeRates: FEE_RATES,
      repoId: REPO_ID,
      refs: ['refs/heads/resolve-me'],
    });

    const plannedShas = plan.objects.map((o) => o.sha);
    // The resolver-found SHA is NOT re-uploaded and lands in the known map…
    expect(plannedShas).not.toContain(lostShas[0]);
    expect(plan.knownShaToTxId.get(lostShas[0]!)).toBe('resolved-tx');
    // …while the genuinely missing one IS uploaded.
    expect(plannedShas).toContain(lostShas[1]);
  });

  it('rejects refs that do not exist locally', async () => {
    await expect(
      planPush({
        repoReader: reader,
        remoteState: cannedRemote(),
        feeRates: FEE_RATES,
        repoId: REPO_ID,
        refs: ['refs/heads/nope'],
      })
    ).rejects.toThrow(/does not exist locally/);
  });

  it('orders ref-tip objects last', async () => {
    const plan = await planPush({
      repoReader: reader,
      remoteState: cannedRemote(),
      feeRates: FEE_RATES,
      repoId: REPO_ID,
      refs: ['refs/heads/main', 'refs/tags/v1'],
    });
    const tips = new Set([commit2, tagSha]);
    const tipIndexes = plan.objects
      .map((o, i) => (tips.has(o.sha) ? i : -1))
      .filter((i) => i !== -1);
    const nonTipIndexes = plan.objects
      .map((o, i) => (tips.has(o.sha) ? -1 : i))
      .filter((i) => i !== -1);
    expect(Math.min(...tipIndexes)).toBeGreaterThan(
      Math.max(...nonTipIndexes)
    );
    for (const o of plan.objects) {
      expect(o.isRefTip).toBe(tips.has(o.sha));
    }
  });
});

// ---------------------------------------------------------------------------
// executePush
// ---------------------------------------------------------------------------

describe('executePush', () => {
  it('first push: uploads all, announces before the refs event, sums fees', async () => {
    const remote = cannedRemote();
    const plan = await planPush({
      repoReader: reader,
      remoteState: remote,
      feeRates: FEE_RATES,
      repoId: REPO_ID,
      refs: ['refs/heads/main', 'refs/tags/v1'],
      announcement: { name: 'Push Fixture', description: 'a test repo' },
    });
    const publisher = new MockPublisher();
    const result = await executePush({
      plan,
      publisher,
      remoteState: remote,
      repoReader: reader,
      relayUrls: RELAYS,
    });

    // Every planned object uploaded exactly once, tips last, bodies intact
    // (re-hashing the uploaded body reproduces the SHA).
    expect(publisher.uploads.map((u) => u.sha)).toEqual(
      plan.objects.map((o) => o.sha)
    );
    expect(publisher.uploads.at(-1)!.sha).toBe(
      plan.objects.at(-1)!.sha
    );
    expect(plan.objects.at(-1)!.isRefTip).toBe(true);
    for (const upload of publisher.uploads) {
      expect(hashGitObject(upload.type, upload.body).sha).toBe(upload.sha);
      expect(upload.repoId).toBe(REPO_ID);
    }

    // Announce (30617) first, then ONE refs event (30618).
    expect(publisher.published.map((p) => p.event.kind)).toEqual([
      30617, 30618,
    ]);
    expect(publisher.published[0]!.relayUrls).toEqual(RELAYS);
    const announce = publisher.published[0]!.event;
    expect(tagValues(announce, 'd')[0]).toEqual([REPO_ID]);
    expect(tagValues(announce, 'name')[0]).toEqual(['Push Fixture']);

    const refsEvent = publisher.published[1]!.event;
    expect(tagValues(refsEvent, 'd')[0]).toEqual([REPO_ID]);
    const rTags = new Map(tagValues(refsEvent, 'r').map(([k, v]) => [k, v]));
    expect(rTags.get('refs/heads/main')).toBe(commit2);
    expect(rTags.get('refs/tags/v1')).toBe(tagSha);
    expect(tagValues(refsEvent, 'HEAD')[0]).toEqual(['ref: refs/heads/main']);
    const arweaveTags = new Map(
      tagValues(refsEvent, 'arweave').map(([k, v]) => [k, v])
    );
    for (const o of plan.objects) {
      expect(arweaveTags.get(o.sha)).toBe(`tx-${o.sha}`);
    }

    // Result bookkeeping + fee accumulation match the estimate exactly.
    expect(result.announceReceipt).not.toBeNull();
    expect(result.uploads.every((u) => !u.skipped)).toBe(true);
    expect(result.totalFeePaid).toBe(plan.estimate.totalFee);
    expect(result.arweaveMap.size).toBe(plan.objects.length);
  });

  it('cumulative merge: prior arweave hints and unrelated remote refs survive', async () => {
    const remote = cannedRemote({
      announced: true,
      refs: new Map([
        ['refs/heads/main', commit1],
        // A ref we are NOT pushing, whose tip we don't even have locally.
        ['refs/heads/legacy', UNKNOWN_SHA],
      ]),
      headSymref: 'refs/heads/main',
      shaToTxId: new Map([
        ...commit1Objects.map((sha) => [sha, `old-${sha}`] as [string, string]),
        // A hint for an object that predates our local clone entirely.
        ['1111111111111111111111111111111111111111', 'ancient-tx'],
      ]),
    });
    const plan = await planPush({
      repoReader: reader,
      remoteState: remote,
      feeRates: FEE_RATES,
      repoId: REPO_ID,
      refs: ['refs/heads/main'],
    });
    const publisher = new MockPublisher();
    const result = await executePush({
      plan,
      publisher,
      remoteState: remote,
      repoReader: reader,
      relayUrls: RELAYS,
    });

    // No announce (already announced) — exactly one 30618.
    expect(publisher.published.map((p) => p.event.kind)).toEqual([30618]);
    const refsEvent = publisher.published[0]!.event;

    // r tags = FULL new state: pushed main + preserved legacy ref.
    const rTags = new Map(tagValues(refsEvent, 'r').map(([k, v]) => [k, v]));
    expect(rTags.get('refs/heads/main')).toBe(commit2);
    expect(rTags.get('refs/heads/legacy')).toBe(UNKNOWN_SHA);

    // arweave tags = MERGE of old hints + new uploads (nothing dropped).
    const arweaveTags = new Map(
      tagValues(refsEvent, 'arweave').map(([k, v]) => [k, v])
    );
    expect(
      arweaveTags.get('1111111111111111111111111111111111111111')
    ).toBe('ancient-tx');
    for (const sha of commit1Objects) {
      expect(arweaveTags.get(sha)).toBe(`old-${sha}`);
    }
    for (const upload of publisher.uploads) {
      expect(arweaveTags.get(upload.sha)).toBe(`tx-${upload.sha}`);
    }
    expect(result.totalFeePaid).toBe(plan.estimate.totalFee);
  });

  it('crash-resume: a second run skips SHAs the previous attempt paid for', async () => {
    const remote = cannedRemote();
    const plan = await planPush({
      repoReader: reader,
      remoteState: remote,
      feeRates: FEE_RATES,
      repoId: REPO_ID,
      refs: ['refs/heads/main'],
    });

    // First attempt crashes after 3 successful uploads.
    const crashing = new MockPublisher();
    crashing.failOnUploadIndex = 3;
    await expect(
      executePush({
        plan,
        publisher: crashing,
        remoteState: remote,
        repoReader: reader,
        relayUrls: RELAYS,
      })
    ).rejects.toThrow('simulated upload crash');
    expect(crashing.uploads).toHaveLength(3);
    expect(crashing.published).toHaveLength(0); // no refs event advertised

    // Resume: fresh remote state now resolves the 3 paid uploads (as the
    // real flow would via GraphQL / re-fetched tags).
    const paid = new Map(
      crashing.uploads.map((u) => [u.sha, `tx-${u.sha}`] as [string, string])
    );
    const freshRemote = cannedRemote({ shaToTxId: paid });
    const publisher = new MockPublisher();
    const result = await executePush({
      plan,
      publisher,
      remoteState: freshRemote,
      repoReader: reader,
      relayUrls: RELAYS,
    });

    // The paid SHAs were not re-uploaded (not paid again)…
    const reuploaded = publisher.uploads.map((u) => u.sha);
    for (const sha of paid.keys()) expect(reuploaded).not.toContain(sha);
    expect(publisher.uploads).toHaveLength(plan.objects.length - 3);

    // …but they still appear in the result (skipped, fee 0) and the map.
    for (const sha of paid.keys()) {
      const step = result.uploads.find((u) => u.sha === sha)!;
      expect(step).toMatchObject({ txId: `tx-${sha}`, feePaid: 0n, skipped: true });
      expect(result.arweaveMap.get(sha)).toBe(`tx-${sha}`);
    }

    // Fees: only the remaining uploads + both events were paid.
    const skippedBytes = plan.objects
      .filter((o) => paid.has(o.sha))
      .reduce((sum, o) => sum + o.size, 0);
    expect(result.totalFeePaid).toBe(
      plan.estimate.totalFee - BigInt(skippedBytes) * FEE_RATES.uploadFeePerByte
    );

    // Announce still happened exactly once across the two attempts.
    expect(publisher.published.map((p) => p.event.kind)).toEqual([
      30617, 30618,
    ]);
  });

  it('resume after announce: fresh announced=true suppresses a second 30617', async () => {
    const remote = cannedRemote();
    const plan = await planPush({
      repoReader: reader,
      remoteState: remote,
      feeRates: FEE_RATES,
      repoId: REPO_ID,
      refs: ['refs/heads/main'],
    });
    // Simulate: previous attempt uploaded everything + announced, then died
    // before the refs event.
    const freshRemote = cannedRemote({
      announced: true,
      shaToTxId: new Map(
        plan.objects.map((o) => [o.sha, `tx-${o.sha}`] as [string, string])
      ),
    });
    const publisher = new MockPublisher();
    const result = await executePush({
      plan,
      publisher,
      remoteState: freshRemote,
      repoReader: reader,
      relayUrls: RELAYS,
    });

    expect(publisher.uploads).toHaveLength(0);
    expect(publisher.published.map((p) => p.event.kind)).toEqual([30618]);
    expect(result.announceReceipt).toBeNull();
    expect(result.totalFeePaid).toBe(FEE_RATES.eventFee); // one event only
  });
});

// ---------------------------------------------------------------------------
// Empty (zero-byte) blob handling (#310)
// ---------------------------------------------------------------------------

describe('empty-blob handling', () => {
  it('excludes the empty blob from the upload set and reports the skip', async () => {
    const plan = await planPush({
      repoReader: reader,
      remoteState: cannedRemote(),
      feeRates: FEE_RATES,
      repoId: REPO_ID,
      refs: ['refs/heads/empty'],
    });

    // The tree references the empty blob, but it is NOT scheduled for upload.
    const uploadShas = plan.objects.map((o) => o.sha);
    expect(uploadShas).not.toContain(EMPTY_BLOB_SHA);
    expect(plan.skippedEmptyObjects.map((o) => o.sha)).toEqual([
      EMPTY_BLOB_SHA,
    ]);
    expect(plan.estimate.skippedEmptyCount).toBe(1);
    // The non-empty sibling blob IS uploaded.
    const filledSha = hashGitObject(
      'blob',
      Buffer.from('not empty\n')
    ).sha;
    expect(uploadShas).toContain(filledSha);
    // The empty blob has no txId and is never added to the arweave map.
    expect(plan.knownShaToTxId.has(EMPTY_BLOB_SHA)).toBe(false);
    // Its zero body contributes nothing to the fee.
    const totalBytes = plan.objects.reduce((sum, o) => sum + o.size, 0);
    expect(plan.estimate.totalObjectBytes).toBe(totalBytes);
    expect(plan.estimate.uploadFee).toBe(BigInt(totalBytes) * 10n);
  });

  it('executePush never uploads the empty blob (Publisher.uploadGitObject not called for it)', async () => {
    const plan = await planPush({
      repoReader: reader,
      remoteState: cannedRemote(),
      feeRates: FEE_RATES,
      repoId: REPO_ID,
      refs: ['refs/heads/empty'],
    });
    const publisher = new MockPublisher();
    const result = await executePush({
      plan,
      publisher,
      remoteState: cannedRemote(),
      repoReader: reader,
      relayUrls: RELAYS,
    });

    // The empty blob is never handed to the Publisher…
    expect(publisher.uploads.map((u) => u.sha)).not.toContain(EMPTY_BLOB_SHA);
    // …and never appears in the receipts or the published arweave map.
    expect(result.uploads.map((u) => u.sha)).not.toContain(EMPTY_BLOB_SHA);
    expect(result.arweaveMap.has(EMPTY_BLOB_SHA)).toBe(false);

    const refsEvent = publisher.published.find((p) => p.event.kind === 30618);
    if (!refsEvent) throw new Error('expected a kind:30618 refs event');
    const arweaveTags = tagValues(refsEvent.event, 'arweave');
    expect(arweaveTags.some((t) => t[0] === EMPTY_BLOB_SHA)).toBe(false);
  });

  it('does NOT skip the empty TREE object (only the empty blob is special-cased)', async () => {
    const plan = await planPush({
      repoReader: reader,
      remoteState: cannedRemote(),
      feeRates: FEE_RATES,
      repoId: REPO_ID,
      refs: ['refs/heads/emptytree'],
    });

    // The empty-tree object is zero bytes too, but it is NOT the empty blob —
    // it must be scheduled for upload, never silently dropped.
    const emptyTreeSha = hashGitObject('tree', Buffer.alloc(0)).sha;
    expect(emptyTreeSha).toBe('4b825dc642cb6eb9a060e54bf8d69288fbee4904');
    expect(plan.objects.map((o) => o.sha)).toContain(emptyTreeSha);
    expect(plan.skippedEmptyObjects).toHaveLength(0);
    expect(plan.estimate.skippedEmptyCount).toBe(0);
    // Sanity: the branch really does carry the empty tree.
    expect(reachableObjects([emptyTreeCommit], repoDir)).toContain(emptyTreeSha);
  });

  it('pushes the non-empty objects and skips ONLY the empty one', async () => {
    const plan = await planPush({
      repoReader: reader,
      remoteState: cannedRemote(),
      feeRates: FEE_RATES,
      repoId: REPO_ID,
      refs: ['refs/heads/empty'],
    });
    const publisher = new MockPublisher();
    await executePush({
      plan,
      publisher,
      remoteState: cannedRemote(),
      repoReader: reader,
      relayUrls: RELAYS,
    });

    // Every reachable non-empty object was uploaded exactly once.
    const reachable = reachableObjects([emptyCommit], repoDir).filter(
      (sha) => sha !== EMPTY_BLOB_SHA
    );
    const uploaded = publisher.uploads.map((u) => u.sha).sort();
    expect(uploaded).toEqual([...new Set(reachable)].sort());
    // No upload carried an empty body (which is what the store rejects).
    for (const upload of publisher.uploads) {
      expect(upload.body.length).toBeGreaterThan(0);
    }
  });
});
