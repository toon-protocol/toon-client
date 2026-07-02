/**
 * The #265 strict `--json` stdout enforcement matrix: EVERY rig-owned
 * command runs in `--json` mode through the SAME composition ./rig.ts uses
 * (isJsonInvocation → stdout guard → makeCliIo → dispatch →
 * ensureSingleJsonDoc), and the full captured stdout must parse as EXACTLY
 * one JSON document — `JSON.parse` of the whole stream, which throws on any
 * extra non-whitespace bytes. This is the regression guard that keeps
 * `rig … --json | jq` pipelines working.
 *
 * The noisy paths are exercised DELIBERATELY to prove chatter lands on
 * stderr: third-party `[Bootstrap] …` writes to process.stdout (the #260
 * addendum — the embedded client's core logs via console.log, i.e. a
 * process.stdout.write), the kind:10032 discovery fallback warning (#264),
 * the deprecated TOON_CLIENT_MNEMONIC alias warning, and the `toon.relay`
 * migration nudge.
 *
 * The git passthrough is EXEMPT and pinned as such: `--json` is not a rig
 * global flag, so `rig --json status` and `rig status --json` pass the exact
 * argv to git (inherited stdio, no guard, no envelope).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { Console } from 'node:console';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Publisher } from '../publisher.js';
import type { RemoteState } from '../remote-state.js';
import { dispatch, type DispatchDeps } from './dispatch.js';
import { writeToonConfig } from './git-config.js';
import {
  isJsonInvocation,
  makeCliIo,
  redirectStdoutToStderr,
  RIG_OWNED_VERBS,
} from './output.js';
import type {
  LoadStandalone,
  StandaloneContext,
} from './standalone-context.js';

const OWNER = 'ab'.repeat(32);
const HEX64 = '12'.repeat(32);
const TX_ID = 'x'.repeat(43);
/** Standard BIP-39 test vector phrase (public; never funded). */
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

// ---------------------------------------------------------------------------
// Fixtures
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

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

function makeRepo(): string {
  const dir = makeTempDir('toon-rig-json-');
  git(['init', '--initial-branch=main'], dir);
  writeFileSync(join(dir, 'README.md'), '# demo\n');
  git(['add', '.'], dir);
  git(['commit', '-m', 'first'], dir);
  return dir;
}

function emptyRemoteState(): RemoteState {
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
  };
}

/**
 * A DELIBERATELY NOISY standalone loader: on load it writes `[Bootstrap] …`
 * straight to process.stdout — exactly what the embedded client's core does
 * via console.log (#260) — and fires the #264 discovery-fallback warning
 * through the warn seam. In `--json` mode both must surface on stderr.
 */
function makeNoisyStandalone(): { load: LoadStandalone } {
  const publisher: Publisher = {
    getFeeRates: async () => ({ uploadFeePerByte: 10n, eventFee: 1n }),
    uploadGitObject: async (upload) => ({
      txId: TX_ID,
      feePaid: BigInt(upload.body.length) * 10n,
    }),
    publishEvent: async () => ({ eventId: 'e'.repeat(64), feePaid: 1n }),
  };
  const context: StandaloneContext = {
    ownerPubkey: OWNER,
    identitySource: 'env',
    identitySourceLabel: 'RIG_MNEMONIC env',
    publisher,
    defaultRelayUrls: ['wss://relay.example'],
    fetchRemote: async () => emptyRemoteState(),
    money: {
      openChannel: async () => ({
        channelId: '0xchannel',
        resumed: false,
        destination: 'g.proxy',
        chain: 'evm:31337',
        peerId: 'peer-1',
        depositTotal: '1000',
      }),
      closeChannel: async (record) => ({
        channelId: record.channelId,
        closedAt: '1000',
        settleableAt: '2000',
      }),
      settleChannel: async (record) => ({ channelId: record.channelId }),
      walletBalances: async () => [
        {
          chain: 'evm',
          address: '0x' + '1'.repeat(40),
          amount: '424242',
          asset: 'USDC',
          assetScale: 6,
        },
      ],
    },
    stop: async () => undefined,
  };
  return {
    load: async (options) => {
      // Third-party stdout noise (vitest intercepts the global console, so
      // write the way console.log ultimately does: through the stream —
      // directly and via a stream-bound Console instance).
      process.stdout.write('[Bootstrap] Connecting to wss://relay.example...\n');
      new Console(process.stdout).log('[Bootstrap] Query filter:', '{"kinds":[10032]}');
      // The #264 discovery-fallback warning through the warn seam.
      options.warn(
        'rig: no payment-peer announce (kind:10032) found on wss://relay.example — falling back to the genesis peer seed'
      );
      return context;
    },
  };
}

// ---------------------------------------------------------------------------
// The rig.ts composition, with captured streams
// ---------------------------------------------------------------------------

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Run one invocation exactly like ./rig.ts does — jsonMode detection, the
 * process-level stdout guard, makeCliIo, dispatch, ensureSingleJsonDoc —
 * with the real stdout/stderr captured instead of written to the terminal.
 */
/** Hermetic default: no daemon detected (never probes the real loopback). */
const NO_DAEMON: NonNullable<DispatchDeps['probeDaemon']> = async () => ({
  baseUrl: 'http://127.0.0.1:8787',
  reachable: false,
});

async function run(
  argv: string[],
  opts: {
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    loadStandalone?: LoadStandalone;
    probeDaemon?: DispatchDeps['probeDaemon'];
    runGit?: DispatchDeps['runGit'];
  } = {}
): Promise<RunResult> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const jsonMode = isJsonInvocation(argv);
  const guard = redirectStdoutToStderr((text) => {
    stdoutChunks.push(text);
  });
  const stderrSpy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation(((chunk: unknown) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as never);
  try {
    const io = makeCliIo({
      jsonMode,
      writeStdout: guard.write,
      writeStderr: (text) => stderrChunks.push(text),
      isInteractive: false,
      confirm: async () => false,
    });
    const code = await dispatch(argv, {
      io,
      env: opts.env ?? {},
      cwd: opts.cwd ?? makeTempDir('toon-rig-json-cwd-'),
      probeDaemon: opts.probeDaemon ?? NO_DAEMON,
      ...(opts.loadStandalone ? { loadStandalone: opts.loadStandalone } : {}),
      ...(opts.runGit ? { runGit: opts.runGit } : {}),
    });
    io.ensureSingleJsonDoc(code);
    return {
      stdout: stdoutChunks.join(''),
      stderr: stderrChunks.join(''),
      code,
    };
  } finally {
    guard.restore();
    stderrSpy.mockRestore();
  }
}

/**
 * THE #265 assertion: the whole captured stdout is exactly one JSON document
 * (JSON.parse of the full stream throws on any extra non-whitespace bytes).
 */
function parseSingleJsonDoc(result: RunResult): Record<string, unknown> {
  expect(result.stdout.trim()).not.toBe('');
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// The command matrix
// ---------------------------------------------------------------------------

describe('strict --json stdout: every rig-owned command emits exactly one JSON document', () => {
  it('init --json (deprecated TOON_CLIENT_MNEMONIC alias warns on stderr)', async () => {
    const repo = makeRepo();
    const home = makeTempDir('toon-rig-json-home-');
    const result = await run(['init', '--json'], {
      env: { TOON_CLIENT_HOME: home, TOON_CLIENT_MNEMONIC: TEST_MNEMONIC },
      cwd: repo,
    });
    expect(result.code).toBe(0);
    const doc = parseSingleJsonDoc(result);
    expect(doc['command']).toBe('init');
    expect(result.stderr).toContain('TOON_CLIENT_MNEMONIC is deprecated');
    // The WARNING line must not leak to stdout (the identity's sourceLabel
    // legitimately names the deprecated alias inside the JSON document).
    expect(result.stdout).not.toContain('rename the variable to RIG_MNEMONIC');
  });

  it('remote add/list/remove --json (toon.relay shadow note goes to stderr)', async () => {
    const repo = makeRepo();
    git(['config', 'toon.relay', 'ws://old.example'], repo);

    const added = await run(
      ['remote', 'add', 'origin', 'wss://relay.example', '--json'],
      { cwd: repo }
    );
    expect(added.code).toBe(0);
    expect(parseSingleJsonDoc(added)).toMatchObject({
      command: 'remote',
      action: 'add',
      name: 'origin',
      url: 'wss://relay.example',
    });
    expect(added.stderr).toContain('toon.relay');
    expect(added.stdout).not.toContain('Added remote');

    const listed = await run(['remote', 'list', '--json'], { cwd: repo });
    expect(listed.code).toBe(0);
    const listDoc = parseSingleJsonDoc(listed);
    expect(listDoc['command']).toBe('remote');
    expect(listDoc['remotes']).toHaveLength(1);

    // Error path: duplicate add → error envelope on stdout, detail on stderr.
    const dup = await run(
      ['remote', 'add', 'origin', 'wss://other.example', '--json'],
      { cwd: repo }
    );
    expect(dup.code).toBe(1);
    expect(parseSingleJsonDoc(dup)).toMatchObject({
      command: 'remote',
      error: 'remote_exists',
      remote: 'origin',
    });
    expect(dup.stderr).toContain('already exists');

    const removed = await run(['remote', 'remove', 'origin', '--json'], {
      cwd: repo,
    });
    expect(removed.code).toBe(0);
    expect(parseSingleJsonDoc(removed)).toMatchObject({
      command: 'remote',
      action: 'remove',
      name: 'origin',
    });
  });

  it('push --json estimate: [Bootstrap] stdout noise, discovery warning, and the toon.relay nudge all land on stderr', async () => {
    const repo = makeRepo();
    await writeToonConfig(repo, { repoId: 'demo', owner: OWNER });
    git(['config', 'toon.relay', 'ws://legacy.example'], repo); // deprecated fallback → nudge
    const result = await run(['push', '--json'], {
      cwd: repo,
      loadStandalone: makeNoisyStandalone().load,
    });
    expect(result.code).toBe(0);
    const doc = parseSingleJsonDoc(result);
    expect(doc).toMatchObject({ command: 'push', executed: false });
    // Every #260/#264 chatter source is present — and ONLY on stderr.
    expect(result.stderr).toContain('[Bootstrap]');
    expect(result.stderr).toContain('kind:10032');
    expect(result.stderr).toContain('toon.relay is deprecated');
    expect(result.stdout).not.toContain('[Bootstrap]');
    expect(result.stdout).not.toContain('deprecated');
  });

  it('push --json --yes executes and still emits exactly one document', async () => {
    const repo = makeRepo();
    await writeToonConfig(repo, { repoId: 'demo', owner: OWNER });
    git(['config', 'toon.relay', 'ws://legacy.example'], repo);
    const result = await run(['push', '--json', '--yes'], {
      cwd: repo,
      loadStandalone: makeNoisyStandalone().load,
    });
    expect(result.code).toBe(0);
    const doc = parseSingleJsonDoc(result);
    expect(doc).toMatchObject({ command: 'push', executed: true });
    expect(result.stdout).not.toContain('[Bootstrap]');
  });

  it('push --json error path: one error envelope on stdout, human detail on stderr', async () => {
    const repo = makeRepo(); // no toon.repoid configured
    const result = await run(['push', '--json'], {
      cwd: repo,
      loadStandalone: makeNoisyStandalone().load,
    });
    expect(result.code).toBe(1);
    expect(parseSingleJsonDoc(result)).toMatchObject({
      command: 'push',
      error: 'unconfigured_repo_address',
    });
    expect(result.stderr).toContain('rig init');
  });

  it('push --json usage error: the backstop envelope keeps stdout parseable (exit 2)', async () => {
    const result = await run(['push', '--json', '--definitely-not-a-flag'], {
      cwd: makeRepo(),
    });
    expect(result.code).toBe(2);
    const doc = parseSingleJsonDoc(result);
    expect(doc['error']).toBe('error');
    expect(doc['exitCode']).toBe(2);
    expect(result.stderr).toContain('--definitely-not-a-flag');
  });

  it('push --help --json: usage goes to stderr, stdout still parses', async () => {
    const result = await run(['push', '--help', '--json'], { cwd: makeRepo() });
    expect(result.code).toBe(0);
    parseSingleJsonDoc(result);
    expect(result.stderr).toContain('Usage: rig push');
  });

  it.each([
    [['issue', 'create', '--title', 'T', '--body', 'B'], 'issue'],
    [['comment', HEX64, '--body', 'B'], 'comment'],
    [['pr', 'status', HEX64, 'applied'], 'pr status'],
  ])('%j --json emits one parseable envelope', async (argv, command) => {
    const result = await run(
      [
        ...argv,
        '--repo-id',
        'demo',
        '--owner',
        OWNER,
        '--relay',
        'wss://relay.example',
        '--json',
      ],
      { loadStandalone: makeNoisyStandalone().load }
    );
    expect(result.code).toBe(0);
    expect(parseSingleJsonDoc(result)).toMatchObject({
      command,
      executed: false, // no --yes → pure estimate
    });
    expect(result.stderr).toContain('[Bootstrap]');
    expect(result.stdout).not.toContain('[Bootstrap]');
  });

  it('pr create --json --yes publishes a patch file and emits one envelope', async () => {
    const dir = makeTempDir('toon-rig-json-patch-');
    const patchPath = join(dir, 'series.patch');
    writeFileSync(patchPath, 'From 1234 Mon Sep 17 00:00:00 2001\npatch body\n');
    const result = await run(
      [
        'pr',
        'create',
        '--title',
        'T',
        '--patch-file',
        patchPath,
        '--repo-id',
        'demo',
        '--owner',
        OWNER,
        '--relay',
        'wss://relay.example',
        '--json',
        '--yes',
      ],
      { loadStandalone: makeNoisyStandalone().load }
    );
    expect(result.code).toBe(0);
    expect(parseSingleJsonDoc(result)).toMatchObject({
      command: 'pr',
      executed: true,
    });
  });

  it('channel list/open/close/settle --json each emit one document', async () => {
    const home = makeTempDir('toon-rig-json-home-');
    const env = { TOON_CLIENT_HOME: home };
    const noisy = makeNoisyStandalone().load;

    const list = await run(['channel', 'list', '--json'], { env });
    expect(list.code).toBe(0);
    expect(parseSingleJsonDoc(list)).toMatchObject({
      command: 'channel list',
      channels: [],
    });

    const open = await run(['channel', 'open', '--json'], {
      env,
      loadStandalone: noisy,
    });
    expect(open.code).toBe(0);
    expect(parseSingleJsonDoc(open)).toMatchObject({
      command: 'channel open',
      executed: false, // no --yes → pure plan
    });
    expect(open.stderr).toContain('[Bootstrap]');
    expect(open.stdout).not.toContain('[Bootstrap]');

    // close/settle on an unrecorded channel: error envelope, exit 1.
    for (const [step, command] of [
      ['close', 'channel close'],
      ['settle', 'channel settle'],
    ] as const) {
      const result = await run(['channel', step, '0xnope', '--json'], {
        env,
        loadStandalone: noisy,
      });
      expect(result.code).toBe(1);
      expect(parseSingleJsonDoc(result)).toMatchObject({
        command,
        error: 'error',
      });
      expect(result.stderr).toContain('no recorded channel');
    }
  });

  it('fund --json (no faucet network): guidance envelope; alias warning on stderr', async () => {
    const home = makeTempDir('toon-rig-json-home-');
    const result = await run(['fund', '--json'], {
      env: { TOON_CLIENT_HOME: home, TOON_CLIENT_MNEMONIC: TEST_MNEMONIC },
      cwd: makeTempDir('toon-rig-json-cwd-'),
    });
    expect(result.code).toBe(0);
    expect(parseSingleJsonDoc(result)).toMatchObject({
      command: 'fund',
      funded: false,
    });
    expect(result.stderr).toContain('TOON_CLIENT_MNEMONIC is deprecated');
    expect(result.stdout).not.toContain('rename the variable to RIG_MNEMONIC');
  });

  it('balance --json emits one document with the noisy loader', async () => {
    const home = makeTempDir('toon-rig-json-home-');
    const result = await run(['balance', '--json'], {
      env: { TOON_CLIENT_HOME: home },
      loadStandalone: makeNoisyStandalone().load,
    });
    expect(result.code).toBe(0);
    const doc = parseSingleJsonDoc(result);
    expect(doc).toMatchObject({ command: 'balance' });
    expect(result.stderr).toContain('[Bootstrap]');
    expect(result.stdout).not.toContain('[Bootstrap]');
  });
});

// ---------------------------------------------------------------------------
// Git passthrough exemption (`--json` is not a rig global flag)
// ---------------------------------------------------------------------------

describe('git passthrough is exempt from the --json contract', () => {
  it('rig --json status passes the WHOLE argv to git verbatim (no guard, no envelope)', async () => {
    const gitCalls: string[][] = [];
    const result = await run(['--json', 'status'], {
      runGit: async (argv) => {
        gitCalls.push(argv);
        return 129;
      },
    });
    expect(gitCalls).toEqual([['--json', 'status']]);
    expect(result.code).toBe(129);
    expect(result.stdout).toBe(''); // no envelope: git owns the streams
  });

  it('rig status --json is `git status --json` verbatim', async () => {
    const gitCalls: string[][] = [];
    const result = await run(['status', '--json'], {
      runGit: async (argv) => {
        gitCalls.push(argv);
        return 0;
      },
    });
    expect(gitCalls).toEqual([['status', '--json']]);
    expect(result.stdout).toBe('');
  });

  it('isJsonInvocation draws exactly the ownership boundary', () => {
    expect(isJsonInvocation(['push', '--json'])).toBe(true);
    expect(isJsonInvocation(['push', '--yes', '--json'])).toBe(true);
    expect(isJsonInvocation(['channel', 'list', '--json'])).toBe(true);
    expect(isJsonInvocation(['push'])).toBe(false);
    expect(isJsonInvocation(['push', '--', '--json'])).toBe(false);
    expect(isJsonInvocation(['--json', 'status'])).toBe(false);
    expect(isJsonInvocation(['status', '--json'])).toBe(false);
    expect(isJsonInvocation([])).toBe(false);
  });

  it('RIG_OWNED_VERBS matches the dispatch switch (owned verbs never reach git)', async () => {
    for (const verb of RIG_OWNED_VERBS) {
      const gitCalls: string[][] = [];
      await run([verb, '--help'], {
        runGit: async (argv) => {
          gitCalls.push(argv);
          return 0;
        },
      });
      expect(gitCalls, `rig ${verb} must not pass through to git`).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// The stdout guard itself
// ---------------------------------------------------------------------------

describe('redirectStdoutToStderr', () => {
  it('reroutes every process.stdout write to stderr; only guard.write reaches stdout', () => {
    const real: string[] = [];
    const stderrChunks: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(((chunk: unknown) => {
        stderrChunks.push(String(chunk));
        return true;
      }) as never);
    const guard = redirectStdoutToStderr((text) => {
      real.push(text);
    });
    try {
      process.stdout.write('[Bootstrap] direct write\n');
      new Console(process.stdout).log('[Bootstrap] via console %s', 'formatted');
      guard.write('{"machine":true}\n');
    } finally {
      guard.restore();
      stderrSpy.mockRestore();
    }
    expect(real).toEqual(['{"machine":true}\n']);
    expect(stderrChunks.join('')).toContain('[Bootstrap] direct write');
    expect(stderrChunks.join('')).toContain('[Bootstrap] via console formatted');
  });

  it('restore() reinstates the original writer', () => {
    const original = process.stdout.write;
    const guard = redirectStdoutToStderr(() => undefined);
    expect(process.stdout.write).not.toBe(original);
    guard.restore();
    expect(process.stdout.write).toBe(original);
  });
});
