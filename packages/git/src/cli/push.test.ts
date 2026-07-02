/**
 * `rig push` command tests.
 *
 * Daemon mode is mocked at the HTTP layer (a real in-process node:http server
 * behind the loopback conventions), standalone mode at the Publisher seam
 * (injected StandaloneContext). Covers: request payload shapes, mode
 * selection, confirm gating (--yes / non-TTY / interactive), table + JSON
 * rendering, structured error mapping, and git-config persistence against a
 * real fixture repository.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Publisher } from '../publisher.js';
import type { RemoteState } from '../remote-state.js';
import type {
  GitEstimateResponse,
  GitPushResponse,
} from '../routes.js';
import { readToonConfig } from './git-config.js';
import { runPush, selectRefspecs, type CliIo, type PushDeps } from './push.js';
import { GitRepoReader } from '../repo-reader.js';
import type { StandaloneContext } from './standalone-context.js';

const OWNER = 'ab'.repeat(32);
const TX_ID = 'x'.repeat(43);

// ---------------------------------------------------------------------------
// Fixture repo
// ---------------------------------------------------------------------------

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
    },
  }).trim();
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'toon-rig-push-'));
  git(['init', '--initial-branch=main'], dir);
  writeFileSync(join(dir, 'README.md'), '# demo\n');
  git(['add', '.'], dir);
  git(['commit', '-m', 'first'], dir);
  return dir;
}

// ---------------------------------------------------------------------------
// Fake daemon (real HTTP on loopback)
// ---------------------------------------------------------------------------

type RouteHandler = (body: unknown) => { status: number; body: unknown };

interface FakeDaemon {
  port: number;
  requests: { path: string; body: unknown }[];
  handlers: Partial<Record<'status' | 'estimate' | 'push', RouteHandler>>;
  close(): Promise<void>;
}

const HEALTHY_STATUS = {
  ready: true,
  identity: { nostrPubkey: OWNER },
  relay: { url: 'wss://relay.devnet.example' },
};

function startFakeDaemon(): Promise<FakeDaemon> {
  const requests: FakeDaemon['requests'] = [];
  const handlers: FakeDaemon['handlers'] = {};
  let server: Server;
  const daemon: FakeDaemon = {
    port: 0,
    requests,
    handlers,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      ),
  };
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        const body = raw === '' ? undefined : (JSON.parse(raw) as unknown);
        const route =
          req.url === '/status'
            ? 'status'
            : req.url === '/git/estimate'
              ? 'estimate'
              : req.url === '/git/push'
                ? 'push'
                : undefined;
        requests.push({ path: req.url ?? '', body });
        const handler = route ? handlers[route] : undefined;
        const result = handler
          ? handler(body)
          : route === 'status'
            ? { status: 200, body: HEALTHY_STATUS }
            : { status: 404, body: { error: 'not_found' } };
        res.writeHead(result.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result.body));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      daemon.port = (server.address() as AddressInfo).port;
      resolve(daemon);
    });
  });
}

// ---------------------------------------------------------------------------
// Wire fixtures
// ---------------------------------------------------------------------------

function fakePlan(
  overrides: Partial<GitEstimateResponse> = {}
): GitEstimateResponse {
  return {
    repoId: 'demo',
    refUpdates: [
      {
        refname: 'refs/heads/main',
        localSha: 'a'.repeat(40),
        remoteSha: null,
        kind: 'new',
      },
    ],
    newRefs: { 'refs/heads/main': 'a'.repeat(40) },
    headSymref: 'refs/heads/main',
    objects: [
      { sha: 'a'.repeat(40), type: 'commit', size: 200, isRefTip: true },
    ],
    knownShaToTxId: {},
    announceNeeded: true,
    announcement: { name: 'demo', description: '' },
    estimate: {
      objectCount: 1,
      totalObjectBytes: 200,
      uploadFee: '2000',
      eventCount: 2,
      eventFees: '2',
      totalFee: '2002',
    },
    ...overrides,
  };
}

function fakeResult(): GitPushResponse {
  const plan = fakePlan();
  return {
    repoId: plan.repoId,
    refUpdates: plan.refUpdates,
    uploads: [
      { sha: 'a'.repeat(40), txId: TX_ID, feePaid: '2000', skipped: false },
    ],
    announceReceipt: { eventId: 'e1'.repeat(32), feePaid: '1' },
    refsReceipt: { eventId: 'e2'.repeat(32), feePaid: '1' },
    arweaveMap: { ['a'.repeat(40)]: TX_ID },
    totalFeePaid: '2002',
    estimate: plan.estimate,
  };
}

// ---------------------------------------------------------------------------
// Deps harness
// ---------------------------------------------------------------------------

interface Harness {
  deps: PushDeps;
  out: string[];
  err: string[];
  confirms: string[];
}

function makeDeps(
  env: NodeJS.ProcessEnv,
  cwd: string,
  options: {
    interactive?: boolean;
    answer?: boolean;
    fetchImpl?: typeof fetch;
    loadStandalone?: PushDeps['loadStandalone'];
  } = {}
): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const confirms: string[] = [];
  const io: CliIo = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    isInteractive: options.interactive ?? false,
    confirm: async (question) => {
      confirms.push(question);
      return options.answer ?? false;
    },
  };
  const deps: PushDeps = {
    io,
    env,
    cwd,
    fetchImpl: options.fetchImpl ?? fetch,
    ...(options.loadStandalone
      ? { loadStandalone: options.loadStandalone }
      : {}),
  };
  return { deps, out, err, confirms };
}

const rejectingFetch = (async () => {
  throw new TypeError('fetch failed: ECONNREFUSED');
}) as typeof fetch;

// ---------------------------------------------------------------------------
// Standalone fakes (the Publisher seam)
// ---------------------------------------------------------------------------

function emptyRemoteState(overrides: Partial<RemoteState> = {}): RemoteState {
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
    ...overrides,
  };
}

interface FakeStandalone {
  context: StandaloneContext;
  uploads: { sha: string; size: number }[];
  published: { kind: number; relayUrls: string[] }[];
  remoteRequests: { ownerPubkey: string; repoId: string; relayUrls: string[] }[];
  stopped: boolean;
}

function makeStandalone(remoteState: RemoteState): FakeStandalone {
  const uploads: FakeStandalone['uploads'] = [];
  const published: FakeStandalone['published'] = [];
  const remoteRequests: FakeStandalone['remoteRequests'] = [];
  const publisher: Publisher = {
    getFeeRates: async () => ({ uploadFeePerByte: 10n, eventFee: 1n }),
    uploadGitObject: async (upload) => {
      uploads.push({ sha: upload.sha, size: upload.body.length });
      return { txId: TX_ID, feePaid: BigInt(upload.body.length) * 10n };
    },
    publishEvent: async (event, relayUrls) => {
      published.push({ kind: event.kind, relayUrls });
      return { eventId: 'e'.repeat(64), feePaid: 1n };
    },
  };
  const fake: FakeStandalone = {
    uploads,
    published,
    remoteRequests,
    stopped: false,
    context: {
      ownerPubkey: OWNER,
      publisher,
      defaultRelayUrls: ['wss://standalone-relay.example'],
      fetchRemote: async (args) => {
        remoteRequests.push(args);
        return remoteState;
      },
      stop: async () => {
        fake.stopped = true;
      },
    },
  };
  return fake;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let repoDir: string;
let homeDir: string;
let daemon: FakeDaemon;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  repoDir = makeRepo();
  homeDir = mkdtempSync(join(tmpdir(), 'toon-rig-pushhome-'));
  daemon = await startFakeDaemon();
  env = {
    TOON_CLIENT_HOME: homeDir,
    TOON_CLIENT_HTTP_PORT: String(daemon.port),
  };
});

afterEach(async () => {
  await daemon.close();
  rmSync(repoDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

describe('selectRefspecs', () => {
  it('defaults to the current branch and expands short names', async () => {
    git(['tag', 'v1'], repoDir);
    git(['branch', 'feature'], repoDir);
    const reader = new GitRepoReader(repoDir);
    expect(await selectRefspecs(reader, [], false, false)).toEqual([
      'refs/heads/main',
    ]);
    expect(await selectRefspecs(reader, ['feature', 'v1'], false, false)).toEqual([
      'refs/heads/feature',
      'refs/tags/v1',
    ]);
    expect(await selectRefspecs(reader, [], true, true)).toEqual([
      'refs/heads/feature',
      'refs/heads/main',
      'refs/tags/v1',
    ]);
    await expect(
      selectRefspecs(reader, ['nope'], false, false)
    ).rejects.toThrow(/matches no local branch or tag/);
  });
});

describe('daemon mode', () => {
  it('estimates, confirms via --yes, executes, and persists git config', async () => {
    daemon.handlers.estimate = () => ({ status: 200, body: fakePlan() });
    daemon.handlers.push = () => ({ status: 200, body: fakeResult() });
    const h = makeDeps(env, repoDir);

    const code = await runPush(['--yes', '--repo-id', 'demo'], h.deps);
    expect(code).toBe(0);

    const estimate = daemon.requests.find((r) => r.path === '/git/estimate');
    expect(estimate?.body).toMatchObject({
      repoPath: repoDir,
      repoId: 'demo',
      refspecs: ['refs/heads/main'],
      force: false,
    });
    expect(estimate?.body).not.toHaveProperty('relayUrls');
    expect(estimate?.body).not.toHaveProperty('confirm');

    const push = daemon.requests.find((r) => r.path === '/git/push');
    expect(push?.body).toMatchObject({
      repoPath: repoDir,
      repoId: 'demo',
      confirm: true,
    });

    // Confirm table + receipts rendering.
    const text = h.out.join('\n');
    expect(text).toContain('Push plan for repo "demo" (daemon mode)');
    expect(text).toContain('first push, will announce');
    expect(text).toContain('refs/heads/main');
    expect(text).toContain('permanent and non-refundable');
    expect(text).toContain('Total paid: 2,002 base units');
    expect(text).toContain(`ar:${TX_ID}`);

    // rig init-lite persistence after success.
    const config = await readToonConfig(repoDir);
    expect(config.repoId).toBe('demo');
    expect(config.owner).toBe(OWNER);
    expect(config.relays).toEqual(['wss://relay.devnet.example']);
  });

  it('passes --relay and --force through to the daemon request', async () => {
    daemon.handlers.estimate = () => ({ status: 200, body: fakePlan() });
    daemon.handlers.push = () => ({ status: 200, body: fakeResult() });
    const h = makeDeps(env, repoDir);
    const code = await runPush(
      [
        '--yes',
        '--force',
        '--repo-id',
        'demo',
        '--relay',
        'wss://one.example',
        '--relay',
        'wss://two.example',
      ],
      h.deps
    );
    expect(code).toBe(0);
    const estimate = daemon.requests.find((r) => r.path === '/git/estimate');
    expect(estimate?.body).toMatchObject({
      force: true,
      relayUrls: ['wss://one.example', 'wss://two.example'],
    });
    const config = await readToonConfig(repoDir);
    expect(config.relays).toEqual(['wss://one.example', 'wss://two.example']);
  });

  it('defaults repoId to the repo directory name', async () => {
    daemon.handlers.estimate = () => ({ status: 200, body: fakePlan() });
    daemon.handlers.push = () => ({ status: 200, body: fakeResult() });
    const h = makeDeps(env, repoDir);
    const code = await runPush(['--yes'], h.deps);
    expect(code).toBe(0);
    const estimate = daemon.requests.find((r) => r.path === '/git/estimate');
    expect((estimate?.body as { repoId: string }).repoId).toBe(
      repoDir.split('/').at(-1)
    );
  });

  it('short-circuits when every ref is up-to-date (no push, no fee)', async () => {
    daemon.handlers.estimate = () => ({
      status: 200,
      body: fakePlan({
        refUpdates: [
          {
            refname: 'refs/heads/main',
            localSha: 'a'.repeat(40),
            remoteSha: 'a'.repeat(40),
            kind: 'up-to-date',
          },
        ],
        objects: [],
      }),
    });
    const h = makeDeps(env, repoDir);
    const code = await runPush(['--yes', '--repo-id', 'demo'], h.deps);
    expect(code).toBe(0);
    expect(h.out.join('\n')).toContain('Everything up-to-date');
    expect(daemon.requests.some((r) => r.path === '/git/push')).toBe(false);
  });

  it('warns when git config toon.owner differs from the daemon identity', async () => {
    git(['config', 'toon.owner', 'cd'.repeat(32)], repoDir);
    daemon.handlers.estimate = () => ({ status: 200, body: fakePlan() });
    daemon.handlers.push = () => ({ status: 200, body: fakeResult() });
    const h = makeDeps(env, repoDir);
    const code = await runPush(['--yes', '--repo-id', 'demo'], h.deps);
    expect(code).toBe(0);
    expect(h.err.join('\n')).toContain('differs from');
  });
});

describe('confirm gating', () => {
  beforeEach(() => {
    daemon.handlers.estimate = () => ({ status: 200, body: fakePlan() });
    daemon.handlers.push = () => ({ status: 200, body: fakeResult() });
  });

  it('refuses without --yes when not a TTY', async () => {
    const h = makeDeps(env, repoDir, { interactive: false });
    const code = await runPush(['--repo-id', 'demo'], h.deps);
    expect(code).toBe(1);
    expect(h.err.join('\n')).toContain('--yes');
    expect(daemon.requests.some((r) => r.path === '/git/push')).toBe(false);
  });

  it('aborts when the interactive prompt is declined', async () => {
    const h = makeDeps(env, repoDir, { interactive: true, answer: false });
    const code = await runPush(['--repo-id', 'demo'], h.deps);
    expect(code).toBe(1);
    expect(h.confirms).toHaveLength(1);
    expect(h.confirms[0]).toContain('2002');
    expect(h.err.join('\n')).toContain('aborted');
    expect(daemon.requests.some((r) => r.path === '/git/push')).toBe(false);
  });

  it('executes when the interactive prompt is accepted', async () => {
    const h = makeDeps(env, repoDir, { interactive: true, answer: true });
    const code = await runPush(['--repo-id', 'demo'], h.deps);
    expect(code).toBe(0);
    expect(daemon.requests.some((r) => r.path === '/git/push')).toBe(true);
  });
});

describe('--json', () => {
  beforeEach(() => {
    daemon.handlers.estimate = () => ({ status: 200, body: fakePlan() });
    daemon.handlers.push = () => ({ status: 200, body: fakeResult() });
  });

  it('without --yes emits the plan only and does not execute', async () => {
    const h = makeDeps(env, repoDir);
    const code = await runPush(['--json', '--repo-id', 'demo'], h.deps);
    expect(code).toBe(0);
    const parsed = JSON.parse(h.out.join('\n')) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      command: 'push',
      mode: 'daemon',
      repoId: 'demo',
      executed: false,
      upToDate: false,
    });
    expect(parsed['plan']).toMatchObject({
      estimate: { totalFee: '2002' },
    });
    expect(parsed['hint']).toContain('--yes');
    expect(daemon.requests.some((r) => r.path === '/git/push')).toBe(false);
  });

  it('with --yes emits plan + receipts', async () => {
    const h = makeDeps(env, repoDir);
    const code = await runPush(['--json', '--yes', '--repo-id', 'demo'], h.deps);
    expect(code).toBe(0);
    const parsed = JSON.parse(h.out.join('\n')) as Record<string, unknown>;
    expect(parsed).toMatchObject({ executed: true });
    expect(parsed['result']).toMatchObject({
      totalFeePaid: '2002',
      refsReceipt: { eventId: 'e2'.repeat(32) },
    });
  });

  it('emits a machine-readable error envelope on failure', async () => {
    daemon.handlers.estimate = () => ({
      status: 402,
      body: { error: 'insufficient_gas', detail: 'no gas', retryable: true },
    });
    const h = makeDeps(env, repoDir);
    const code = await runPush(['--json', '--repo-id', 'demo'], h.deps);
    expect(code).toBe(1);
    const parsed = JSON.parse(h.out.join('\n')) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      command: 'push',
      error: 'insufficient_gas',
      status: 402,
    });
  });
});

describe('error mapping (daemon envelopes)', () => {
  it('409 non_fast_forward lists refs and suggests --force with a warning', async () => {
    daemon.handlers.estimate = () => ({
      status: 409,
      body: {
        error: 'non_fast_forward',
        detail: 'non-fast-forward update rejected',
        refs: [
          {
            refname: 'refs/heads/main',
            localSha: 'a'.repeat(40),
            remoteSha: 'b'.repeat(40),
          },
        ],
      },
    });
    const h = makeDeps(env, repoDir);
    const code = await runPush(['--yes', '--repo-id', 'demo'], h.deps);
    expect(code).toBe(1);
    const text = h.err.join('\n');
    expect(text).toContain('refs/heads/main');
    expect(text).toContain('--force');
    expect(text).toContain('WARNING');
  });

  it('413 oversize_objects lists paths+sizes and points at #235', async () => {
    daemon.handlers.estimate = () => ({
      status: 413,
      body: {
        error: 'oversize_objects',
        detail: '1 object(s) exceed the limit',
        objects: [
          { sha: 'c'.repeat(40), type: 'blob', size: 123456, path: 'assets/video.mp4' },
        ],
      },
    });
    const h = makeDeps(env, repoDir);
    const code = await runPush(['--yes', '--repo-id', 'demo'], h.deps);
    expect(code).toBe(1);
    const text = h.err.join('\n');
    expect(text).toContain('assets/video.mp4');
    expect(text).toContain('123456 bytes');
    expect(text).toContain('#235');
  });

  it('503 bootstrapping suggests retrying', async () => {
    daemon.handlers.estimate = () => ({
      status: 503,
      body: { error: 'bootstrapping', detail: 'channel coming up', retryable: true },
    });
    const h = makeDeps(env, repoDir);
    const code = await runPush(['--yes', '--repo-id', 'demo'], h.deps);
    expect(code).toBe(1);
    expect(h.err.join('\n')).toContain('Retry');
  });

  it('402 insufficient_gas points at the funding flows', async () => {
    daemon.handlers.estimate = () => ({
      status: 402,
      body: { error: 'insufficient_gas', detail: 'wallet has no gas', retryable: true },
    });
    const h = makeDeps(env, repoDir);
    const code = await runPush(['--yes', '--repo-id', 'demo'], h.deps);
    expect(code).toBe(1);
    const text = h.err.join('\n');
    expect(text).toContain('toon_fund_wallet');
    expect(text).toContain('toon_open_channel');
  });

  it('--daemon with no daemon running names the exact remediation', async () => {
    const h = makeDeps(env, repoDir, { fetchImpl: rejectingFetch });
    const code = await runPush(['--yes', '--daemon', '--repo-id', 'demo'], h.deps);
    expect(code).toBe(1);
    const text = h.err.join('\n');
    expect(text).toContain('toon-clientd');
    expect(text).toContain('--standalone');
  });

  it('neither daemon nor mnemonic names both options', async () => {
    const h = makeDeps(env, repoDir, { fetchImpl: rejectingFetch });
    const code = await runPush(['--yes', '--repo-id', 'demo'], h.deps);
    expect(code).toBe(1);
    const text = h.err.join('\n');
    expect(text).toContain('toon-clientd');
    expect(text).toContain('TOON_CLIENT_MNEMONIC');
  });
});

describe('standalone mode (Publisher seam)', () => {
  it('plans locally, executes through the publisher, and persists config', async () => {
    const fake = makeStandalone(emptyRemoteState());
    const h = makeDeps(env, repoDir, {
      fetchImpl: rejectingFetch,
      loadStandalone: async () => fake.context,
    });
    const code = await runPush(
      ['--standalone', '--yes', '--repo-id', 'demo'],
      h.deps
    );
    expect(code).toBe(0);

    // Remote state read for the standalone identity over the default relay.
    expect(fake.remoteRequests).toEqual([
      {
        ownerPubkey: OWNER,
        repoId: 'demo',
        relayUrls: ['wss://standalone-relay.example'],
      },
    ]);
    // First push of one commit: commit + root tree + README blob uploaded,
    // then kind:30617 announce + kind:30618 refs.
    expect(fake.uploads).toHaveLength(3);
    expect(fake.published.map((p) => p.kind)).toEqual([30617, 30618]);
    expect(fake.stopped).toBe(true);

    const text = h.out.join('\n');
    expect(text).toContain('standalone mode');
    expect(text).toContain('Refs event (kind:30618)');

    const config = await readToonConfig(repoDir);
    expect(config.owner).toBe(OWNER);
    expect(config.relays).toEqual(['wss://standalone-relay.example']);
  });

  it('is selected by default when the daemon is down and a mnemonic exists', async () => {
    const fake = makeStandalone(emptyRemoteState());
    const h = makeDeps(
      { ...env, TOON_CLIENT_MNEMONIC: 'test test test' },
      repoDir,
      { fetchImpl: rejectingFetch, loadStandalone: async () => fake.context }
    );
    const code = await runPush(['--yes', '--repo-id', 'demo'], h.deps);
    expect(code).toBe(0);
    expect(fake.published.map((p) => p.kind)).toEqual([30617, 30618]);
  });

  it('maps a local non-fast-forward plan to the --force suggestion', async () => {
    // Remote tip is a SHA this repo has never seen → not an ancestor.
    const fake = makeStandalone(
      emptyRemoteState({
        announced: true,
        refs: new Map([['refs/heads/main', 'd'.repeat(40)]]),
      })
    );
    const h = makeDeps(env, repoDir, {
      fetchImpl: rejectingFetch,
      loadStandalone: async () => fake.context,
    });
    const code = await runPush(
      ['--standalone', '--yes', '--repo-id', 'demo'],
      h.deps
    );
    expect(code).toBe(1);
    const text = h.err.join('\n');
    expect(text).toContain('non-fast-forward');
    expect(text).toContain('--force');
    expect(fake.uploads).toHaveLength(0);
    expect(fake.stopped).toBe(true);
  });

  it('surfaces the daemon-identity-conflict guard with a mode hint', async () => {
    const conflict = new Error(
      'toon-clientd is running with this identity'
    );
    conflict.name = 'DaemonIdentityConflictError';
    const h = makeDeps(env, repoDir, {
      fetchImpl: rejectingFetch,
      loadStandalone: async () => {
        throw conflict;
      },
    });
    const code = await runPush(
      ['--standalone', '--yes', '--repo-id', 'demo'],
      h.deps
    );
    expect(code).toBe(1);
    expect(h.err.join('\n')).toContain('--daemon');
  });
});

describe('usage', () => {
  it('rejects unknown flags with usage (exit 2)', async () => {
    const h = makeDeps(env, repoDir);
    const code = await runPush(['--frobnicate'], h.deps);
    expect(code).toBe(2);
    expect(h.err.join('\n')).toContain('Usage: rig push');
  });

  it('--help prints usage and exits 0', async () => {
    const h = makeDeps(env, repoDir);
    const code = await runPush(['--help'], h.deps);
    expect(code).toBe(0);
    expect(h.out.join('\n')).toContain('--force');
    expect(daemon.requests).toHaveLength(0);
  });
});
