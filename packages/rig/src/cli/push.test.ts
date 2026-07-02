/**
 * `rig push` command tests (standalone-only since #248).
 *
 * The publisher is mocked at the Publisher seam (injected StandaloneContext).
 * Covers: refspec selection, the "run `rig init` first" unconfigured error,
 * confirm gating (--yes / non-TTY / interactive), table + JSON rendering
 * (incl. the identity source report), structured error mapping, the
 * single-relay guard, the #249 remote resolution (origin default, named
 * remote positional, unknown-name / no-origin errors, toon.relay fallback +
 * nudge, multi-URL refusal before payment), and that pushing never writes
 * git config.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Publisher } from '../publisher.js';
import type { RemoteState } from '../remote-state.js';
import { readToonConfig, writeToonConfig } from './git-config.js';
import { runPush, selectRefspecs, type CliIo, type PushDeps } from './push.js';
import { GitRepoReader } from '../repo-reader.js';
import type {
  StandaloneContext,
  StandaloneLoadOptions,
} from './standalone-context.js';

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
    loadStandalone?: PushDeps['loadStandalone'];
  } = {}
): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const confirms: string[] = [];
  const io: CliIo = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    // The machine document lands in the same `out` stream the pre-#265
    // assertions read (production routes it to the real stdout).
    emitJson: (payload) => out.push(JSON.stringify(payload, null, 2)),
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
    ...(options.loadStandalone
      ? { loadStandalone: options.loadStandalone }
      : {}),
  };
  return { deps, out, err, confirms };
}

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
  loadedWith: StandaloneLoadOptions[];
  stopped: boolean;
  load: PushDeps['loadStandalone'];
}

function makeStandalone(remoteState: RemoteState): FakeStandalone {
  const uploads: FakeStandalone['uploads'] = [];
  const published: FakeStandalone['published'] = [];
  const remoteRequests: FakeStandalone['remoteRequests'] = [];
  const loadedWith: FakeStandalone['loadedWith'] = [];
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
    loadedWith,
    stopped: false,
    load: async (options) => {
      loadedWith.push(options);
      return fake.context;
    },
    context: {
      ownerPubkey: OWNER,
      identitySource: 'env',
      identitySourceLabel: 'RIG_MNEMONIC env',
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
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  repoDir = makeRepo();
  homeDir = mkdtempSync(join(tmpdir(), 'toon-rig-pushhome-'));
  env = { TOON_CLIENT_HOME: homeDir };
});

afterEach(() => {
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

describe('unconfigured repo (rig init required)', () => {
  it('errors with the init remediation when no repo id is configured', async () => {
    const fake = makeStandalone(emptyRemoteState());
    const h = makeDeps(env, repoDir, { loadStandalone: fake.load });
    const code = await runPush(['--yes'], h.deps);
    expect(code).toBe(1);
    const text = h.err.join('\n');
    expect(text).toContain('rig init');
    expect(text).toContain('--repo-id');
    // Failed before loading the publisher — nothing fetched, uploaded, paid.
    expect(fake.loadedWith).toHaveLength(0);
    expect(fake.uploads).toHaveLength(0);
    expect(fake.published).toHaveLength(0);
  });

  it('--json emits the machine-readable unconfigured envelope', async () => {
    const h = makeDeps(env, repoDir, {
      loadStandalone: makeStandalone(emptyRemoteState()).load,
    });
    const code = await runPush(['--yes', '--json'], h.deps);
    expect(code).toBe(1);
    expect(JSON.parse(h.out.join('\n'))).toMatchObject({
      command: 'push',
      error: 'unconfigured_repo_address',
    });
  });

  it('--repo-id keeps working without any git config (flag override)', async () => {
    const fake = makeStandalone(emptyRemoteState());
    const h = makeDeps(env, repoDir, { loadStandalone: fake.load });
    const code = await runPush(
      ['--yes', '--repo-id', 'demo', '--relay', 'wss://adhoc.example'],
      h.deps
    );
    expect(code).toBe(0);
    expect(fake.published.map((p) => p.kind)).toEqual([30617, 30618]);
  });
});

describe('standalone push (Publisher seam)', () => {
  beforeEach(async () => {
    await writeToonConfig(repoDir, { repoId: 'demo', owner: OWNER });
    git(['remote', 'add', 'origin', 'wss://origin-relay.example'], repoDir);
  });

  it('plans locally, executes through the publisher, and passes env/cwd/warn to the loader', async () => {
    const fake = makeStandalone(emptyRemoteState());
    const h = makeDeps(env, repoDir, { loadStandalone: fake.load });

    const code = await runPush(['--yes'], h.deps);
    expect(code).toBe(0);

    // Loader receives the command environment (identity chain inputs).
    expect(fake.loadedWith).toHaveLength(1);
    expect(fake.loadedWith[0]?.env).toBe(env);
    expect(fake.loadedWith[0]?.cwd).toBe(repoDir);
    expect(typeof fake.loadedWith[0]?.warn).toBe('function');

    // Remote state read for the standalone identity over the origin remote.
    expect(fake.remoteRequests).toEqual([
      {
        ownerPubkey: OWNER,
        repoId: 'demo',
        relayUrls: ['wss://origin-relay.example'],
      },
    ]);
    // First push of one commit: commit + root tree + README blob uploaded,
    // then kind:30617 announce + kind:30618 refs.
    expect(fake.uploads).toHaveLength(3);
    expect(fake.published.map((p) => p.kind)).toEqual([30617, 30618]);
    expect(fake.stopped).toBe(true);

    const text = h.out.join('\n');
    expect(text).toContain('Push plan for repo "demo"');
    expect(text).toContain('first push, will announce');
    expect(text).toContain('refs/heads/main');
    expect(text).toContain('permanent and non-refundable');
    expect(text).toContain(`Identity: ${OWNER} (from RIG_MNEMONIC env)`);
    expect(text).toContain('Refs event (kind:30618)');
    expect(text).toContain(`ar:${TX_ID}`);
  });

  it('never writes git config as a push side effect', async () => {
    const before = await readToonConfig(repoDir);
    const fake = makeStandalone(emptyRemoteState());
    const h = makeDeps(env, repoDir, { loadStandalone: fake.load });
    const code = await runPush(
      ['--yes', '--repo-id', 'other', '--relay', 'wss://chosen.example'],
      h.deps
    );
    expect(code).toBe(0);
    // repoId/relay overrides applied to the push but NOT persisted.
    expect(await readToonConfig(repoDir)).toEqual(before);
    expect(fake.published[0]?.relayUrls).toEqual(['wss://chosen.example']);
  });

  it('short-circuits when every ref is up-to-date (no publish, no fee)', async () => {
    const headSha = git(['rev-parse', 'HEAD'], repoDir);
    const fake = makeStandalone(
      emptyRemoteState({
        announced: true,
        refs: new Map([['refs/heads/main', headSha]]),
        headSymref: 'refs/heads/main',
      })
    );
    const h = makeDeps(env, repoDir, { loadStandalone: fake.load });
    const code = await runPush(['--yes'], h.deps);
    expect(code).toBe(0);
    expect(h.out.join('\n')).toContain('Everything up-to-date');
    expect(fake.uploads).toHaveLength(0);
    expect(fake.published).toHaveLength(0);
  });

  it('warns when git config toon.owner differs from the active identity', async () => {
    await writeToonConfig(repoDir, { owner: 'cd'.repeat(32) });
    const fake = makeStandalone(emptyRemoteState());
    const h = makeDeps(env, repoDir, { loadStandalone: fake.load });
    const code = await runPush(['--yes'], h.deps);
    expect(code).toBe(0);
    const text = h.err.join('\n');
    expect(text).toContain('differs from');
    expect(text).toContain('rig init');
  });

  it('refuses >1 explicit --relay before fetching, uploading, or paying', async () => {
    const fake = makeStandalone(emptyRemoteState());
    const h = makeDeps(env, repoDir, { loadStandalone: fake.load });
    const code = await runPush(
      ['--yes', '--relay', 'wss://one.example', '--relay', 'wss://two.example'],
      h.deps
    );
    expect(code).toBe(1);
    const text = h.err.join('\n');
    expect(text).toContain('single relay');
    expect(text).toContain('wss://one.example');
    expect(text).toContain('Nothing was uploaded or paid');
    // Refused before ANY network or payment activity — the publisher (and
    // its identity chain / nonce guard) is never even loaded.
    expect(fake.loadedWith).toHaveLength(0);
    expect(fake.remoteRequests).toHaveLength(0);
    expect(fake.uploads).toHaveLength(0);
    expect(fake.published).toHaveLength(0);
  });

  it('refuses a multi-valued toon.relay git config before money moves', async () => {
    git(['remote', 'remove', 'origin'], repoDir); // fall back to toon.relay
    await writeToonConfig(repoDir, {
      relays: ['wss://one.example', 'wss://two.example'],
    });
    const fake = makeStandalone(emptyRemoteState());
    const h = makeDeps(env, repoDir, { loadStandalone: fake.load });
    const code = await runPush(['--yes'], h.deps);
    expect(code).toBe(1);
    const text = h.err.join('\n');
    expect(text).toContain('single relay');
    expect(text).toContain('rig remote add origin');
    expect(fake.loadedWith).toHaveLength(0);
    expect(fake.remoteRequests).toHaveLength(0);
    expect(fake.uploads).toHaveLength(0);
    expect(fake.published).toHaveLength(0);
  });

  it('maps a local non-fast-forward plan to the --force suggestion', async () => {
    // Remote tip is a SHA this repo has never seen → not an ancestor.
    const fake = makeStandalone(
      emptyRemoteState({
        announced: true,
        refs: new Map([['refs/heads/main', 'd'.repeat(40)]]),
      })
    );
    const h = makeDeps(env, repoDir, { loadStandalone: fake.load });
    const code = await runPush(['--yes'], h.deps);
    expect(code).toBe(1);
    const text = h.err.join('\n');
    expect(text).toContain('non-fast-forward');
    expect(text).toContain('--force');
    expect(fake.uploads).toHaveLength(0);
    expect(fake.stopped).toBe(true);
  });

  it('surfaces the nonce-guard daemon-identity conflict with the MCP hint', async () => {
    const conflict = new Error('toon-clientd is running with this identity');
    conflict.name = 'DaemonIdentityConflictError';
    const h = makeDeps(env, repoDir, {
      loadStandalone: async () => {
        throw conflict;
      },
    });
    const code = await runPush(['--yes'], h.deps);
    expect(code).toBe(1);
    const text = h.err.join('\n');
    expect(text).toContain('toon-clientd is running');
    expect(text).toContain('toon_git_*');
  });

  it('surfaces the missing-identity remediation from the loader', async () => {
    const { MissingIdentityError } = await import('./identity.js');
    const h = makeDeps(env, repoDir, {
      loadStandalone: async () => {
        throw new MissingIdentityError(join(homeDir, 'config.json'));
      },
    });
    const code = await runPush(['--yes'], h.deps);
    expect(code).toBe(1);
    const text = h.err.join('\n');
    expect(text).toContain('RIG_MNEMONIC environment variable');
    expect(text).toContain('.env');
    expect(text).toContain(join(homeDir, 'config.json'));
  });
});

describe('remote resolution (#249)', () => {
  beforeEach(async () => {
    await writeToonConfig(repoDir, { repoId: 'demo', owner: OWNER });
  });

  it('pushes to a named remote: `rig push <remote> <refspec>`', async () => {
    git(['remote', 'add', 'origin', 'wss://origin-relay.example'], repoDir);
    git(['remote', 'add', 'stage', 'wss://stage-relay.example'], repoDir);
    const fake = makeStandalone(emptyRemoteState());
    const h = makeDeps(env, repoDir, { loadStandalone: fake.load });
    const code = await runPush(['stage', 'main', '--yes'], h.deps);
    expect(code).toBe(0);
    // The first positional was consumed as the remote, the second as refspec.
    expect(fake.remoteRequests[0]?.relayUrls).toEqual([
      'wss://stage-relay.example',
    ]);
    expect(fake.published.map((p) => p.relayUrls)).toEqual([
      ['wss://stage-relay.example'],
      ['wss://stage-relay.example'],
    ]);
  });

  it('treats a non-remote first positional as a refspec (origin default)', async () => {
    git(['remote', 'add', 'origin', 'wss://origin-relay.example'], repoDir);
    const fake = makeStandalone(emptyRemoteState());
    const h = makeDeps(env, repoDir, { loadStandalone: fake.load });
    const code = await runPush(['main', '--yes'], h.deps);
    expect(code).toBe(0);
    expect(fake.remoteRequests[0]?.relayUrls).toEqual([
      'wss://origin-relay.example',
    ]);
  });

  it('errors when the first positional is neither a remote nor a ref', async () => {
    git(['remote', 'add', 'origin', 'wss://origin-relay.example'], repoDir);
    const fake = makeStandalone(emptyRemoteState());
    const h = makeDeps(env, repoDir, { loadStandalone: fake.load });
    const code = await runPush(['upstream', 'main', '--yes'], h.deps);
    expect(code).toBe(1);
    const text = h.err.join('\n');
    expect(text).toContain('neither a configured remote nor a local branch/tag');
    expect(text).toContain('rig remote add upstream');
    expect(fake.loadedWith).toHaveLength(0);
    expect(fake.published).toHaveLength(0);
  });

  it('errors "no origin configured" when no remote resolves (before payment)', async () => {
    const fake = makeStandalone(emptyRemoteState());
    const h = makeDeps(env, repoDir, { loadStandalone: fake.load });
    const code = await runPush(['--yes'], h.deps);
    expect(code).toBe(1);
    const text = h.err.join('\n');
    expect(text).toContain('no origin configured');
    expect(text).toContain('rig remote add origin <relay-url>');
    expect(fake.loadedWith).toHaveLength(0);
    expect(fake.uploads).toHaveLength(0);
    expect(fake.published).toHaveLength(0);
  });

  it('falls back to deprecated toon.relay with a one-line migration nudge', async () => {
    await writeToonConfig(repoDir, { relays: ['wss://legacy.example'] });
    const fake = makeStandalone(emptyRemoteState());
    const h = makeDeps(env, repoDir, { loadStandalone: fake.load });
    const code = await runPush(['--yes'], h.deps);
    expect(code).toBe(0);
    expect(fake.published.map((p) => p.relayUrls)).toEqual([
      ['wss://legacy.example'],
      ['wss://legacy.example'],
    ]);
    const nudges = h.err.filter((l) => l.includes('toon.relay'));
    expect(nudges).toHaveLength(1);
    expect(nudges[0]).toContain('deprecated');
    expect(nudges[0]).toContain('rig remote add origin wss://legacy.example');
  });

  it('refuses a multi-URL origin remote BEFORE any payment', async () => {
    git(['remote', 'add', 'origin', 'wss://one.example'], repoDir);
    git(['remote', 'set-url', '--add', 'origin', 'wss://two.example'], repoDir);
    const fake = makeStandalone(emptyRemoteState());
    const h = makeDeps(env, repoDir, { loadStandalone: fake.load });
    const code = await runPush(['--yes'], h.deps);
    expect(code).toBe(1);
    const text = h.err.join('\n');
    expect(text).toContain('one relay URL per remote');
    expect(text).toContain('git remote set-url origin');
    expect(fake.loadedWith).toHaveLength(0);
    expect(fake.uploads).toHaveLength(0);
    expect(fake.published).toHaveLength(0);
  });

  it('--relay bypasses the configured remotes (documented ad-hoc override)', async () => {
    git(['remote', 'add', 'origin', 'wss://origin-relay.example'], repoDir);
    const fake = makeStandalone(emptyRemoteState());
    const h = makeDeps(env, repoDir, { loadStandalone: fake.load });
    const code = await runPush(
      ['main', '--yes', '--relay', 'wss://adhoc.example'],
      h.deps
    );
    expect(code).toBe(0);
    expect(fake.published[0]?.relayUrls).toEqual(['wss://adhoc.example']);
  });
});

describe('confirm gating', () => {
  beforeEach(async () => {
    await writeToonConfig(repoDir, { repoId: 'demo', owner: OWNER });
    git(['remote', 'add', 'origin', 'wss://origin-relay.example'], repoDir);
  });

  it('refuses without --yes when not a TTY', async () => {
    const fake = makeStandalone(emptyRemoteState());
    const h = makeDeps(env, repoDir, {
      interactive: false,
      loadStandalone: fake.load,
    });
    const code = await runPush([], h.deps);
    expect(code).toBe(1);
    expect(h.err.join('\n')).toContain('--yes');
    expect(fake.uploads).toHaveLength(0);
    expect(fake.published).toHaveLength(0);
  });

  it('aborts when the interactive prompt is declined', async () => {
    const fake = makeStandalone(emptyRemoteState());
    const h = makeDeps(env, repoDir, {
      interactive: true,
      answer: false,
      loadStandalone: fake.load,
    });
    const code = await runPush([], h.deps);
    expect(code).toBe(1);
    expect(h.confirms).toHaveLength(1);
    expect(h.err.join('\n')).toContain('aborted');
    expect(fake.published).toHaveLength(0);
  });

  it('executes when the interactive prompt is accepted', async () => {
    const fake = makeStandalone(emptyRemoteState());
    const h = makeDeps(env, repoDir, {
      interactive: true,
      answer: true,
      loadStandalone: fake.load,
    });
    const code = await runPush([], h.deps);
    expect(code).toBe(0);
    expect(fake.published.map((p) => p.kind)).toEqual([30617, 30618]);
  });
});

describe('--json', () => {
  beforeEach(async () => {
    await writeToonConfig(repoDir, { repoId: 'demo', owner: OWNER });
    git(['remote', 'add', 'origin', 'wss://origin-relay.example'], repoDir);
  });

  it('without --yes emits the plan (with identity) and does not execute', async () => {
    const fake = makeStandalone(emptyRemoteState());
    const h = makeDeps(env, repoDir, { loadStandalone: fake.load });
    const code = await runPush(['--json'], h.deps);
    expect(code).toBe(0);
    const parsed = JSON.parse(h.out.join('\n')) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      command: 'push',
      repoId: 'demo',
      identity: {
        pubkey: OWNER,
        source: 'env',
        sourceLabel: 'RIG_MNEMONIC env',
      },
      executed: false,
      upToDate: false,
    });
    expect(parsed['plan']).toHaveProperty('estimate');
    expect(parsed['hint']).toContain('--yes');
    expect(fake.uploads).toHaveLength(0);
    expect(fake.published).toHaveLength(0);
  });

  it('with --yes emits plan + receipts', async () => {
    const fake = makeStandalone(emptyRemoteState());
    const h = makeDeps(env, repoDir, { loadStandalone: fake.load });
    const code = await runPush(['--json', '--yes'], h.deps);
    expect(code).toBe(0);
    const parsed = JSON.parse(h.out.join('\n')) as Record<string, unknown>;
    expect(parsed).toMatchObject({ executed: true });
    expect(parsed['result']).toMatchObject({
      refsReceipt: { eventId: 'e'.repeat(64) },
    });
  });
});

describe('usage', () => {
  it('rejects unknown flags with usage (exit 2)', async () => {
    const h = makeDeps(env, repoDir);
    const code = await runPush(['--frobnicate'], h.deps);
    expect(code).toBe(2);
    expect(h.err.join('\n')).toContain('Usage: rig push');
  });

  it('the removed --daemon/--standalone mode flags are hard errors', async () => {
    for (const flag of ['--daemon', '--standalone']) {
      const h = makeDeps(env, repoDir);
      expect(await runPush([flag], h.deps)).toBe(2);
      expect(h.err.join('\n')).toContain('Usage: rig push');
    }
  });

  it('--help prints usage (mentioning rig init) and exits 0', async () => {
    const h = makeDeps(env, repoDir);
    const code = await runPush(['--help'], h.deps);
    expect(code).toBe(0);
    const text = h.out.join('\n');
    expect(text).toContain('--force');
    expect(text).toContain('rig init');
    expect(text).not.toContain('--daemon');
  });
});
