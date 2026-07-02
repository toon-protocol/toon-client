/**
 * `/git/*` route tests (epic #222, ticket #227).
 *
 * Same wiring as routes.test.ts (Fastify inject → registerRoutes → ClientRunner
 * with a fake ToonClient), plus:
 *   - a REAL fixture git repository (the push.test.ts pattern) so planning
 *     exercises actual plumbing — no network, just local `git`;
 *   - an injected `fetchRemoteState` (via `gitDeps`) so no relay socket is
 *     ever opened;
 *   - a fake client whose `publishEvent` answers store writes
 *     (`proxyPath: '/store'`) with a FULFILL HTTP envelope carrying an
 *     Arweave txId, mirroring the deployed payment-proxy contract.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import type { NostrEvent, EventTemplate } from 'nostr-tools/pure';
import { MAX_OBJECT_SIZE, type RemoteState } from '@toon-protocol/rig';
import { registerRoutes } from './routes.js';
import { ClientRunner, type ToonClientLike } from './client-runner.js';
import type { ResolvedDaemonConfig } from './config.js';
import { RelaySubscription } from '../relay-subscription.js';

// ---------------------------------------------------------------------------
// Fixture repository (real git, no network)
// ---------------------------------------------------------------------------

let repoDir: string;
let commit1 = '';
let commit2 = '';
/** SHAs reachable from commit1 (what a previous push already stored). */
let commit1Objects: string[] = [];
/** SHAs reachable from main (commit2). */
let mainObjects: string[] = [];
/** sha → body size for every object reachable from main. */
const sizeBySha = new Map<string, number>();

const UNKNOWN_SHA = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
const OWNER = 'ab'.repeat(32);
const REPO_ADDR = { ownerPubkey: OWNER, repoId: 'fixture-repo' };

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

function reachableObjects(revs: string[]): string[] {
  return git(['rev-list', '--objects', ...revs], repoDir)
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split(' ')[0]!);
}

beforeAll(() => {
  repoDir = mkdtempSync(join(tmpdir(), 'toon-git-routes-fixture-'));
  git(['init', '--initial-branch=main'], repoDir);

  writeFileSync(join(repoDir, 'README.md'), '# git routes fixture\n');
  git(['add', '.'], repoDir);
  git(['commit', '-m', 'first'], repoDir);
  commit1 = git(['rev-parse', 'HEAD'], repoDir);

  writeFileSync(join(repoDir, 'a.ts'), 'export const a = 1;\n');
  git(['add', '.'], repoDir);
  git(['commit', '-m', 'second'], repoDir);
  commit2 = git(['rev-parse', 'HEAD'], repoDir);

  // Oversize branch: one blob just over the 95KB v1 limit.
  git(['checkout', '-b', 'big', commit1], repoDir);
  writeFileSync(join(repoDir, 'big.bin'), Buffer.alloc(MAX_OBJECT_SIZE + 1, 7));
  git(['add', 'big.bin'], repoDir);
  git(['commit', '-m', 'big blob'], repoDir);
  git(['checkout', 'main'], repoDir);

  commit1Objects = reachableObjects([commit1]);
  mainObjects = reachableObjects([commit2]);
  for (const sha of mainObjects) {
    const size = Number(git(['cat-file', '-s', sha], repoDir));
    sizeBySha.set(sha, size);
  }
});

afterAll(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Canned remote state + fake client
// ---------------------------------------------------------------------------

function cannedRemote(
  partial: Partial<Omit<RemoteState, 'resolveMissing'>> = {}
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
    resolveMissing: async () => new Map(),
    ...partial,
  };
}

/** Deterministic 43-char base64url Arweave txId for a fixture SHA. */
function txIdFor(sha: string): string {
  return `${sha}AAA`; // 40 hex + 3 pad = 43 chars, all in [A-Za-z0-9_-]
}

/** FULFILL data: the payment-proxy's verbatim HTTP response, base64. */
function storeFulfill(txId: string): string {
  const body = JSON.stringify({ accept: true, txId });
  return Buffer.from(
    `HTTP/1.1 200 OK\r\ncontent-length: ${body.length}\r\n\r\n${body}`
  ).toString('base64');
}

interface RecordedPublish {
  event: NostrEvent;
  options?: {
    destination?: string;
    claim?: unknown;
    ilpAmount?: bigint;
    proxyPath?: string;
  };
}

/** Happy-path fake client; store writes answer with an Arweave FULFILL. */
class FakeClient implements ToonClientLike {
  peerNegotiations = new Map<string, unknown>();
  nonce = 0;
  signedCount = 0;
  publishes: RecordedPublish[] = [];
  storeFailure?: string;

  async start(): Promise<{ peersDiscovered: number; mode: string }> {
    return { peersDiscovered: 0, mode: 'http' };
  }
  async stop(): Promise<void> {}
  getPublicKey(): string {
    return OWNER;
  }
  getEvmAddress(): string | undefined {
    return '0x1';
  }
  getSolanaAddress(): string | undefined {
    return undefined;
  }
  getMinaAddress(): string | undefined {
    return undefined;
  }
  getNetworkStatus(): undefined {
    return undefined;
  }
  async publishEvent(
    event: NostrEvent,
    options?: RecordedPublish['options']
  ): Promise<{ success: boolean; eventId?: string; data?: string; error?: string }> {
    this.publishes.push({ event, ...(options ? { options } : {}) });
    if (options?.proxyPath === '/store') {
      if (this.storeFailure) return { success: false, error: this.storeFailure };
      const sha = event.tags.find((t) => t[0] === 'Git-SHA')?.[1] ?? 'no-sha';
      return {
        success: true,
        eventId: event.id,
        data: storeFulfill(txIdFor(sha)),
      };
    }
    return { success: true, eventId: event.id };
  }
  async signBalanceProof(): Promise<unknown> {
    this.nonce += 1;
    return {};
  }
  signEvent(template: EventTemplate): NostrEvent {
    this.signedCount += 1;
    return {
      id: `signed-${template.kind}-${this.signedCount}`,
      pubkey: this.getPublicKey(),
      sig: '0xsig',
      created_at: template.created_at,
      kind: template.kind,
      tags: template.tags,
      content: template.content,
    };
  }
  async uploadBlob(): Promise<{ success: boolean; txId?: string }> {
    return { success: true, txId: 'tx-unused' };
  }
  async openChannel(): Promise<string> {
    return 'chan-1';
  }
  getTrackedChannels(): string[] {
    return ['chan-1'];
  }
  getChannelNonce(): number {
    return this.nonce;
  }
  getChannelCumulativeAmount(): bigint {
    return BigInt(this.nonce);
  }
  getChannelDepositTotal(): bigint {
    return 100_000_000n;
  }
  async getBalances(): Promise<never[]> {
    return [];
  }
  async depositToChannel(
    channelId: string
  ): Promise<{ channelId: string; depositTotal: string }> {
    return { channelId, depositTotal: '0' };
  }
  async closeChannel(
    channelId: string
  ): Promise<{ channelId: string; closedAt: string; settleableAt: string }> {
    return { channelId, closedAt: '0', settleableAt: '0' };
  }
  async settleChannel(channelId: string): Promise<{ channelId: string }> {
    return { channelId };
  }
  getChannelCloseState(): 'open' {
    return 'open';
  }
  getSettleableAt(): bigint | undefined {
    return undefined;
  }
  async sendSwapPacket(): Promise<{ accepted: boolean }> {
    return { accepted: true };
  }
  h402Fetch = vi.fn(async (): Promise<Response> => new Response('ok'));
}

function config(): ResolvedDaemonConfig {
  return {
    httpPort: 0,
    relayUrl: 'ws://relay.test',
    hasUplink: true,
    destination: 'g.proxy',
    publishDestination: 'g.proxy.relay',
    storeDestination: 'g.proxy.store',
    feePerEvent: 1n,
    chain: 'evm',
    apexChannelStorePath: join(tmpdir(), `toon-git-routes-apex-${process.pid}.json`),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    toonClientConfig: { btpUrl: 'ws://apex/btp' } as any,
  };
}

function fakeRelay(): RelaySubscription {
  return new RelaySubscription({
    relayUrl: 'ws://relay.test',
    wsFactory: () => ({ send: () => {}, close: () => {}, on: () => {} }),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('/git/* control API routes', () => {
  let app: FastifyInstance;
  let runner: ClientRunner;
  let client: FakeClient;
  let remote: RemoteState;
  let fetchRemote: ReturnType<typeof vi.fn>;

  async function build(ready = true, remoteState = cannedRemote()): Promise<void> {
    client = new FakeClient();
    remote = remoteState;
    fetchRemote = vi.fn(async () => remote);
    runner = new ClientRunner({
      config: config(),
      createClient: () => client,
      createRelay: fakeRelay,
      gitDeps: {
        fetchRemoteState: fetchRemote as unknown as never,
      },
    });
    if (ready) await runner.bootstrap();
    app = Fastify();
    registerRoutes(app, runner);
    await app.ready();
  }

  afterEach(async () => {
    await app?.close();
  });

  // ── /git/estimate ──────────────────────────────────────────────────────────

  it('estimates a first push: full delta, announce included, string fees', async () => {
    await build();
    const res = await app.inject({
      method: 'POST',
      url: '/git/estimate',
      payload: {
        repoPath: repoDir,
        repoId: 'fixture-repo',
        refspecs: ['refs/heads/main'],
      },
    });
    expect(res.statusCode).toBe(200);
    const plan = res.json();

    expect(plan.repoId).toBe('fixture-repo');
    expect(plan.announceNeeded).toBe(true);
    expect(plan.refUpdates).toEqual([
      { refname: 'refs/heads/main', localSha: commit2, remoteSha: null, kind: 'new' },
    ]);
    expect(plan.newRefs).toEqual({ 'refs/heads/main': commit2 });
    expect(plan.headSymref).toBe('refs/heads/main');
    expect(plan.knownShaToTxId).toEqual({});

    // Full first-push delta, priced at bytes × 10 + 2 events × feePerEvent(1).
    const shas = plan.objects.map((o: { sha: string }) => o.sha).sort();
    expect(shas).toEqual([...mainObjects].sort());
    const totalBytes = mainObjects.reduce((sum, sha) => sum + sizeBySha.get(sha)!, 0);
    expect(plan.estimate).toEqual({
      objectCount: mainObjects.length,
      totalObjectBytes: totalBytes,
      uploadFee: String(totalBytes * 10),
      eventCount: 2,
      eventFees: '2',
      totalFee: String(totalBytes * 10 + 2),
    });

    // Remote state was read for the daemon identity on the default relay.
    expect(fetchRemote).toHaveBeenCalledWith({
      relayUrls: ['ws://relay.test'],
      ownerPubkey: OWNER,
      repoId: 'fixture-repo',
    });
    // An estimate never pays.
    expect(client.publishes).toHaveLength(0);
  });

  it('rejects a missing repoPath/repoId with 400', async () => {
    await build();
    const res = await app.inject({
      method: 'POST',
      url: '/git/estimate',
      payload: { repoId: 'fixture-repo' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_git_request');
  });

  it('rejects a non-existent repoPath with 400 invalid_payload', async () => {
    await build();
    const res = await app.inject({
      method: 'POST',
      url: '/git/estimate',
      payload: { repoPath: join(tmpdir(), 'no-such-dir-227'), repoId: 'r' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_payload' });
    expect(res.json().detail).toContain('does not exist');
  });

  it('maps a non-git directory to 400 git_error', async () => {
    await build();
    const dir = mkdtempSync(join(tmpdir(), 'toon-not-a-repo-'));
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/git/estimate',
        payload: { repoPath: dir, repoId: 'r' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('git_error');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('maps a non-fast-forward plan to 409 with the structured refs', async () => {
    await build(true, cannedRemote({
      announced: true,
      refs: new Map([['refs/heads/main', UNKNOWN_SHA]]),
    }));
    const res = await app.inject({
      method: 'POST',
      url: '/git/estimate',
      payload: { repoPath: repoDir, repoId: 'fixture-repo', refspecs: ['refs/heads/main'] },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: 'non_fast_forward',
      refs: [
        { refname: 'refs/heads/main', localSha: commit2, remoteSha: UNKNOWN_SHA },
      ],
    });
  });

  it('maps oversize objects to 413 with path + size', async () => {
    await build();
    const res = await app.inject({
      method: 'POST',
      url: '/git/estimate',
      payload: { repoPath: repoDir, repoId: 'fixture-repo', refspecs: ['refs/heads/big'] },
    });
    expect(res.statusCode).toBe(413);
    const body = res.json();
    expect(body.error).toBe('oversize_objects');
    expect(body.objects).toHaveLength(1);
    expect(body.objects[0]).toMatchObject({
      type: 'blob',
      size: MAX_OBJECT_SIZE + 1,
      path: 'big.bin',
    });
  });

  it('returns 503 bootstrapping while the apex is not ready', async () => {
    await build(false);
    const res = await app.inject({
      method: 'POST',
      url: '/git/estimate',
      payload: { repoPath: repoDir, repoId: 'fixture-repo' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: 'bootstrapping', retryable: true });
  });

  // ── /git/push ──────────────────────────────────────────────────────────────

  it('rejects a push without confirm:true (400, no spend)', async () => {
    await build();
    const res = await app.inject({
      method: 'POST',
      url: '/git/push',
      payload: { repoPath: repoDir, repoId: 'fixture-repo' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toContain('confirm');
    expect(client.publishes).toHaveLength(0);
  });

  it('executes a confirmed first push: kind:5094 uploads + 30617/30618 publishes', async () => {
    await build();
    const res = await app.inject({
      method: 'POST',
      url: '/git/push',
      payload: {
        repoPath: repoDir,
        repoId: 'fixture-repo',
        refspecs: ['refs/heads/main'],
        confirm: true,
        announcement: { name: 'Fixture', description: 'a repo' },
      },
    });
    expect(res.statusCode).toBe(200);
    const result = res.json();

    // Per-object receipts: paid at bytes × 10, txId decoded from the FULFILL.
    expect(result.uploads).toHaveLength(mainObjects.length);
    for (const step of result.uploads) {
      expect(step.skipped).toBe(false);
      expect(step.txId).toBe(txIdFor(step.sha));
      expect(step.feePaid).toBe(String(sizeBySha.get(step.sha)! * 10));
    }

    // Store writes: one kind:5094 per object, Git-tagged, routed to the store.
    const storeWrites = client.publishes.filter(
      (p) => p.options?.proxyPath === '/store'
    );
    expect(storeWrites).toHaveLength(mainObjects.length);
    for (const write of storeWrites) {
      expect(write.event.kind).toBe(5094);
      expect(write.options?.destination).toBe('g.proxy.store');
      const tags = new Map(write.event.tags.map((t) => [t[0], t.slice(1)]));
      expect(tags.get('Repo')).toEqual(['fixture-repo']);
      expect(tags.get('Git-SHA')?.[0]).toMatch(/^[0-9a-f]{40}$/);
      expect(['blob', 'tree', 'commit']).toContain(tags.get('Git-Type')?.[0]);
      expect(tags.get('bid')?.[1]).toBe('usdc');
      expect(write.options?.ilpAmount).toBeDefined();
    }

    // Relay publishes: announcement first, then ONE cumulative refs event —
    // both through the publish destination (never the store).
    const relayWrites = client.publishes.filter(
      (p) => p.options?.proxyPath === undefined
    );
    expect(relayWrites.map((p) => p.event.kind)).toEqual([30617, 30618]);
    for (const write of relayWrites) {
      expect(write.options?.destination).toBe('g.proxy.relay');
    }
    const announce = relayWrites[0]!.event;
    expect(announce.tags).toContainEqual(['d', 'fixture-repo']);
    expect(announce.tags).toContainEqual(['name', 'Fixture']);
    const refsEvent = relayWrites[1]!.event;
    expect(refsEvent.tags).toContainEqual(['d', 'fixture-repo']);
    expect(refsEvent.tags).toContainEqual(['r', 'refs/heads/main', commit2]);
    expect(refsEvent.tags).toContainEqual(['HEAD', 'ref: refs/heads/main']);
    for (const sha of mainObjects) {
      expect(refsEvent.tags).toContainEqual(['arweave', sha, txIdFor(sha)]);
    }

    expect(result.announceReceipt).toEqual({
      eventId: relayWrites[0]!.event.id,
      feePaid: '1',
    });
    expect(result.refsReceipt).toEqual({
      eventId: relayWrites[1]!.event.id,
      feePaid: '1',
    });

    // Total = Σ upload fees + 2 events × feePerEvent(1) — matches the estimate.
    const totalBytes = mainObjects.reduce((sum, sha) => sum + sizeBySha.get(sha)!, 0);
    expect(result.totalFeePaid).toBe(String(totalBytes * 10 + 2));
    expect(result.estimate.totalFee).toBe(result.totalFeePaid);
  });

  it('second push is delta-only: known objects are not re-paid, no re-announce', async () => {
    const shaToTxId = new Map(commit1Objects.map((sha) => [sha, txIdFor(sha)]));
    await build(true, cannedRemote({
      announced: true,
      refs: new Map([['refs/heads/main', commit1]]),
      headSymref: 'refs/heads/main',
      shaToTxId,
    }));
    const res = await app.inject({
      method: 'POST',
      url: '/git/push',
      payload: {
        repoPath: repoDir,
        repoId: 'fixture-repo',
        refspecs: ['refs/heads/main'],
        confirm: true,
      },
    });
    expect(res.statusCode).toBe(200);
    const result = res.json();

    const deltaCount = mainObjects.length - commit1Objects.length;
    expect(result.uploads).toHaveLength(deltaCount);
    expect(result.announceReceipt).toBeNull();
    expect(
      client.publishes.filter((p) => p.options?.proxyPath === '/store')
    ).toHaveLength(deltaCount);
    // The cumulative refs event still carries the PRIOR sha→txId hints.
    const refsEvent = client.publishes.at(-1)!.event;
    expect(refsEvent.kind).toBe(30618);
    for (const sha of commit1Objects) {
      expect(refsEvent.tags).toContainEqual(['arweave', sha, txIdFor(sha)]);
    }
  });

  it('surfaces a store rejection as 502 with the failing SHA', async () => {
    await build();
    client.storeFailure = 'store exploded';
    const res = await app.inject({
      method: 'POST',
      url: '/git/push',
      payload: {
        repoPath: repoDir,
        repoId: 'fixture-repo',
        refspecs: ['refs/heads/main'],
        confirm: true,
      },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('rejected');
    expect(res.json().detail).toContain('store exploded');
  });

  // ── /git/issue ─────────────────────────────────────────────────────────────

  it('publishes a kind:1621 issue with a/p/subject/label tags', async () => {
    await build();
    const res = await app.inject({
      method: 'POST',
      url: '/git/issue',
      payload: {
        repoAddr: REPO_ADDR,
        title: 'Bug: it breaks',
        body: 'Steps to reproduce…',
        labels: ['bug', 'p1'],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ kind: 1621, feePaid: '1' });

    const published = client.publishes.at(-1)!.event;
    expect(published.kind).toBe(1621);
    expect(published.content).toBe('Steps to reproduce…');
    expect(published.tags).toContainEqual(['a', `30617:${OWNER}:fixture-repo`]);
    expect(published.tags).toContainEqual(['p', OWNER]);
    expect(published.tags).toContainEqual(['subject', 'Bug: it breaks']);
    expect(published.tags).toContainEqual(['t', 'bug']);
    expect(published.tags).toContainEqual(['t', 'p1']);
    expect(client.publishes.at(-1)!.options?.destination).toBe('g.proxy.relay');
  });

  it('rejects an issue with a malformed repoAddr with 400', async () => {
    await build();
    const res = await app.inject({
      method: 'POST',
      url: '/git/issue',
      payload: {
        repoAddr: { ownerPubkey: 'not-hex', repoId: 'fixture-repo' },
        title: 't',
        body: 'b',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toContain('ownerPubkey');
  });

  // ── /git/comment ───────────────────────────────────────────────────────────

  it('publishes a kind:1622 comment threading onto the target event', async () => {
    await build();
    const res = await app.inject({
      method: 'POST',
      url: '/git/comment',
      payload: {
        repoAddr: REPO_ADDR,
        rootEventId: 'issue-event-1',
        body: 'agreed',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ kind: 1622 });
    const published = client.publishes.at(-1)!.event;
    expect(published.tags).toContainEqual(['a', `30617:${OWNER}:fixture-repo`]);
    expect(published.tags).toContainEqual(['e', 'issue-event-1', '', 'root']);
    // `p` defaults to the repo owner when the target author is not supplied.
    expect(published.tags).toContainEqual(['p', OWNER]);
  });

  // ── /git/patch ─────────────────────────────────────────────────────────────

  it('publishes a kind:1617 patch from literal patchText', async () => {
    await build();
    const res = await app.inject({
      method: 'POST',
      url: '/git/patch',
      payload: {
        repoAddr: REPO_ADDR,
        title: 'Add a.ts',
        patchText: 'From 0000 Mon Sep 17 00:00:00 2001\n…diff…',
        commits: [{ sha: commit2, parentSha: commit1 }],
        branch: 'feature/a',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ kind: 1617 });
    const published = client.publishes.at(-1)!.event;
    expect(published.content).toContain('…diff…');
    expect(published.tags).toContainEqual(['subject', 'Add a.ts']);
    expect(published.tags).toContainEqual(['commit', commit2]);
    expect(published.tags).toContainEqual(['parent-commit', commit1]);
    expect(published.tags).toContainEqual(['t', 'feature/a']);
  });

  it('publishes a kind:1617 patch with REAL format-patch content from repoPath+range', async () => {
    await build();
    const res = await app.inject({
      method: 'POST',
      url: '/git/patch',
      payload: {
        repoAddr: REPO_ADDR,
        title: 'second commit as patch',
        repoPath: repoDir,
        range: `${commit1}..${commit2}`,
      },
    });
    expect(res.statusCode).toBe(200);
    const published = client.publishes.at(-1)!.event;
    expect(published.kind).toBe(1617);
    expect(published.content).toContain('Subject: [PATCH] second');
    expect(published.content).toContain('+export const a = 1;');
  });

  it('rejects a patch supplying BOTH patchText and repoPath+range (and neither)', async () => {
    await build();
    const both = await app.inject({
      method: 'POST',
      url: '/git/patch',
      payload: {
        repoAddr: REPO_ADDR,
        title: 't',
        patchText: 'x',
        repoPath: repoDir,
        range: `${commit1}..${commit2}`,
      },
    });
    expect(both.statusCode).toBe(400);
    const neither = await app.inject({
      method: 'POST',
      url: '/git/patch',
      payload: { repoAddr: REPO_ADDR, title: 't' },
    });
    expect(neither.statusCode).toBe(400);
  });

  // ── /git/status ────────────────────────────────────────────────────────────

  it('publishes the right status kind with target + repo tags', async () => {
    await build();
    const res = await app.inject({
      method: 'POST',
      url: '/git/status',
      payload: {
        repoAddr: REPO_ADDR,
        targetEventId: 'patch-event-9',
        status: 'applied',
        targetPubkey: 'cd'.repeat(32),
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ kind: 1631 });
    const published = client.publishes.at(-1)!.event;
    expect(published.kind).toBe(1631);
    expect(published.tags).toContainEqual(['e', 'patch-event-9']);
    expect(published.tags).toContainEqual(['p', 'cd'.repeat(32)]);
    expect(published.tags).toContainEqual(['a', `30617:${OWNER}:fixture-repo`]);
  });

  it.each([
    ['open', 1630],
    ['closed', 1632],
    ['draft', 1633],
  ])('maps status %s to kind %i', async (status, kind) => {
    await build();
    const res = await app.inject({
      method: 'POST',
      url: '/git/status',
      payload: { repoAddr: REPO_ADDR, targetEventId: 'e9', status },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().kind).toBe(kind);
  });

  it('rejects an unknown status value with 400', async () => {
    await build();
    const res = await app.inject({
      method: 'POST',
      url: '/git/status',
      payload: { repoAddr: REPO_ADDR, targetEventId: 'e9', status: 'merged' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toContain('open | applied | closed | draft');
  });
});
