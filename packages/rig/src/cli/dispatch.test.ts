/**
 * `rig` dispatch tests (#250): rig-owned verbs always win; EVERYTHING else
 * passes through to git with the exact argv tail and git's exit code.
 *
 * The git runner is injected at the GitRunner seam (the real spawn-based
 * passthrough is covered by the subprocess tests in git-passthrough.test.ts).
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { dispatch, USAGE, type DispatchDeps } from './dispatch.js';
import type { GitPassthroughOptions } from './git-passthrough.js';
import type { CliIo } from './push.js';

const HEX64 = '12'.repeat(32);

interface Harness {
  deps: DispatchDeps;
  out: string[];
  err: string[];
  gitCalls: { argv: string[]; options?: GitPassthroughOptions }[];
}

function makeHarness(gitExitCode = 0): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const gitCalls: Harness['gitCalls'] = [];
  const io: CliIo = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    isInteractive: false,
    confirm: async () => false,
  };
  const deps: DispatchDeps = {
    io,
    env: {},
    cwd: '/some/repo',
    runGit: async (argv, options) => {
      gitCalls.push({ argv, ...(options ? { options } : {}) });
      return gitExitCode;
    },
  };
  return { deps, out, err, gitCalls };
}

describe('dispatch precedence (rig-owned verbs never pass through)', () => {
  it.each([
    ['init'],
    ['remote'],
    ['push'],
    ['issue'],
    ['comment'],
    ['pr'],
    ['channel'],
    ['fund'],
    ['balance'],
  ])('rig %s --help is answered by rig, not git', async (verb) => {
    const h = makeHarness();
    expect(await dispatch([verb, '--help'], h.deps)).toBe(0);
    expect(h.gitCalls).toHaveLength(0);
    expect(h.out.join('\n')).toContain('rig');
  });

  it('owned verbs stay owned even with bad args (rig usage, no git)', async () => {
    for (const argv of [
      ['issue'],
      ['comment'],
      ['pr'],
      ['pr', 'bogus'],
      ['channel'],
      ['channel', 'bogus'],
    ]) {
      const h = makeHarness();
      expect(await dispatch(argv, h.deps)).toBe(2);
      expect(h.gitCalls).toHaveLength(0);
      expect(h.err.length).toBeGreaterThan(0);
    }
  });

  it('help lists rig commands and documents the git passthrough', async () => {
    for (const argv of [['help'], ['--help'], ['-h']]) {
      const h = makeHarness();
      expect(await dispatch(argv, h.deps)).toBe(0);
      const text = h.out.join('\n');
      expect(text).toContain('pr status');
      expect(text).toContain('channel list');
      expect(text).toContain('passed through to git');
      expect(text).toContain('`rig status` runs');
      expect(text).toContain('`git status`');
      expect(h.gitCalls).toHaveLength(0);
    }
    // The push-shadowing note: rig push is the TOON transport; plain git
    // push stays reachable by calling git directly.
    expect(USAGE).toContain('shadows git push');
    expect(USAGE).toContain('`git push` directly');
  });

  it('--version prints the package version, no git', async () => {
    const h = makeHarness();
    expect(await dispatch(['--version'], h.deps)).toBe(0);
    const pkg = createRequire(import.meta.url)('../../package.json') as {
      version: string;
    };
    expect(h.out).toEqual([`rig ${pkg.version}`]);
    expect(h.gitCalls).toHaveLength(0);
  });

  it('no arguments prints usage to stderr (exit 2), no git', async () => {
    const h = makeHarness();
    expect(await dispatch([], h.deps)).toBe(2);
    expect(h.err.join('\n')).toContain('Usage: rig <command>');
    expect(h.gitCalls).toHaveLength(0);
  });
});

describe('git passthrough dispatch', () => {
  it.each([
    [['status']],
    [['add', '-p']],
    [['commit', '-m', 'a message with spaces']],
    [['log', '--oneline']],
    [['diff']],
    [['branch']],
    [['checkout', 'main']],
    [['rebase', '-i', 'HEAD~2']],
  ])('rig %j lands in git verbatim', async (argv) => {
    const h = makeHarness();
    expect(await dispatch(argv, h.deps)).toBe(0);
    expect(h.gitCalls).toHaveLength(1);
    expect(h.gitCalls[0]?.argv).toEqual(argv);
  });

  it('preserves flag fidelity (formats, --grep with spaces, repeated flags)', async () => {
    const argv = ['log', '--format=%H %s', '--grep=a b', '-n', '1', '--', 'path with space'];
    const h = makeHarness();
    await dispatch(argv, h.deps);
    expect(h.gitCalls[0]?.argv).toEqual(argv);
  });

  it('propagates the git exit code exactly', async () => {
    for (const code of [1, 128]) {
      const h = makeHarness(code);
      expect(await dispatch(['status'], h.deps)).toBe(code);
    }
  });

  it('runs git in the caller cwd and wires stderr to the CLI io', async () => {
    const h = makeHarness();
    await dispatch(['status'], h.deps);
    const options = h.gitCalls[0]?.options;
    expect(options?.cwd).toBe('/some/repo');
    options?.err?.('boom');
    expect(h.err).toEqual(['boom']);
  });

  it('forwards deps.env to the git child (not ambient process.env)', async () => {
    // env is the same injectable seam as cwd: a caller that supplies a
    // sanitized environment must see the git child use IT, not process.env.
    const h = makeHarness();
    h.deps.env = { RIG_INJECTED_ENV: 'yes' };
    await dispatch(['status'], h.deps);
    expect(h.gitCalls[0]?.options?.env).toEqual({ RIG_INJECTED_ENV: 'yes' });
  });

  it('the OLD rig status <event-id> <state> shape passes to git too', async () => {
    // The NIP-34 status publish lives at `rig pr status` now (#250): the old
    // top-level spelling must NOT error about event-ids — it is git's.
    const h = makeHarness();
    expect(await dispatch(['status', HEX64, 'open'], h.deps)).toBe(0);
    expect(h.gitCalls[0]?.argv).toEqual(['status', HEX64, 'open']);
    expect(h.err).toEqual([]);
  });
});
