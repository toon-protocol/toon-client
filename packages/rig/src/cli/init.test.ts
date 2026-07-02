/**
 * `rig init` tests (#248, #249): happy path, idempotent re-run, --repo-id
 * override, missing-identity remediation, not-a-git-repo hint, the
 * toon.relay → origin-remote migration, and the --json report — against a
 * real fixture repository and the real identity chain (RIG_MNEMONIC / .env /
 * shared config).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { deriveNostrKeyFromMnemonic } from '@toon-protocol/client';
import { readToonConfig, writeToonConfig } from './git-config.js';
import { runInit } from './init.js';
import type { CliIo } from './push.js';

const PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PUBKEY = deriveNostrKeyFromMnemonic(PHRASE).pubkey;

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

let repoDir: string;
let homeDir: string;

beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), 'toon-rig-init-'));
  git(['init', '--initial-branch=main'], repoDir);
  homeDir = mkdtempSync(join(tmpdir(), 'toon-rig-inithome-'));
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

interface Harness {
  deps: { io: CliIo; env: NodeJS.ProcessEnv; cwd: string };
  out: string[];
  err: string[];
}

function makeDeps(env: Record<string, string>, cwd = repoDir): Harness {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    deps: {
      io: {
        out: (line) => out.push(line),
        err: (line) => err.push(line),
        isInteractive: false,
        confirm: async () => false,
      },
      env: { TOON_CLIENT_HOME: homeDir, ...env },
      cwd,
    },
  };
}

describe('rig init', () => {
  it('writes toon.repoid (dir basename) + toon.owner and reports the source', async () => {
    const h = makeDeps({ RIG_MNEMONIC: PHRASE });
    const code = await runInit([], h.deps);
    expect(code).toBe(0);

    const config = await readToonConfig(repoDir);
    expect(config.repoId).toBe(basename(repoDir));
    expect(config.owner).toBe(PUBKEY);

    const text = h.out.join('\n');
    expect(text).toContain(`Initialized rig for ${repoDir}`);
    expect(text).toContain(`Identity: ${PUBKEY} (from RIG_MNEMONIC env)`);
    expect(text).toContain(`toon.repoid = ${basename(repoDir)}`);
    expect(text).toContain(`toon.owner  = ${PUBKEY}`);
    // No relay yet → the origins follow-up step.
    expect(text).toContain('No relay configured');
    expect(text).toContain('rig remote add origin <relay-url>');
    // The phrase itself never appears anywhere.
    expect(text).not.toContain('abandon');
    expect(h.err.join('\n')).not.toContain('abandon');
  });

  it('writes to the repo-LOCAL git config only', async () => {
    const h = makeDeps({ RIG_MNEMONIC: PHRASE });
    expect(await runInit([], h.deps)).toBe(0);
    expect(git(['config', '--local', 'toon.owner'], repoDir)).toBe(PUBKEY);
    // Nothing rig-related lands in any repo FILE (mnemonic stays out of the
    // worktree; .git/config is where git config --local lives).
    expect(git(['status', '--porcelain'], repoDir)).toBe('');
  });

  it('--repo-id overrides the basename default', async () => {
    const h = makeDeps({ RIG_MNEMONIC: PHRASE });
    expect(await runInit(['--repo-id', 'custom-id'], h.deps)).toBe(0);
    expect((await readToonConfig(repoDir)).repoId).toBe('custom-id');
  });

  it('is idempotent: re-running keeps the configured repoid and reports', async () => {
    const h1 = makeDeps({ RIG_MNEMONIC: PHRASE });
    expect(await runInit(['--repo-id', 'kept'], h1.deps)).toBe(0);

    const h2 = makeDeps({ RIG_MNEMONIC: PHRASE });
    expect(await runInit([], h2.deps)).toBe(0);
    const config = await readToonConfig(repoDir);
    expect(config.repoId).toBe('kept'); // NOT clobbered back to the basename
    expect(config.owner).toBe(PUBKEY);
    const text = h2.out.join('\n');
    expect(text).toContain('toon.repoid = kept (unchanged)');
    expect(text).toContain('(unchanged)');
  });

  it('updates a stale owner to the active identity and notes the change', async () => {
    await writeToonConfig(repoDir, { owner: 'cd'.repeat(32) });
    const h = makeDeps({ RIG_MNEMONIC: PHRASE });
    expect(await runInit([], h.deps)).toBe(0);
    expect((await readToonConfig(repoDir)).owner).toBe(PUBKEY);
    expect(h.out.join('\n')).toContain(`(was ${'cd'.repeat(32)})`);
  });

  it('migrates a v0.1 toon.relay to a real origin remote (key kept readable)', async () => {
    await writeToonConfig(repoDir, { relays: ['wss://relay.example'] });
    const h = makeDeps({ RIG_MNEMONIC: PHRASE });
    expect(await runInit([], h.deps)).toBe(0);
    // A REAL git remote was created from the deprecated key…
    expect(git(['remote', 'get-url', 'origin'], repoDir)).toBe(
      'wss://relay.example'
    );
    // …and the old key stays readable (fallback until v0.3).
    expect(git(['config', '--get-all', 'toon.relay'], repoDir)).toBe(
      'wss://relay.example'
    );
    const text = h.out.join('\n');
    expect(text).toContain('origin      = wss://relay.example');
    expect(text).toContain('migrated from git config toon.relay');
    expect(text).toContain('removed in v0.3');
    expect(text).toContain('Ready: `rig push`');
    expect(text).not.toContain('No relay configured');
  });

  it('reports an existing relay origin without migrating anything', async () => {
    git(['remote', 'add', 'origin', 'wss://relay.example'], repoDir);
    const h = makeDeps({ RIG_MNEMONIC: PHRASE });
    expect(await runInit([], h.deps)).toBe(0);
    const text = h.out.join('\n');
    expect(text).toContain('origin      = wss://relay.example');
    expect(text).not.toContain('migrated');
    expect(text).toContain('Ready: `rig push`');
    expect(text).not.toContain('No relay configured');
  });

  it('does not migrate onto an existing non-relay origin (guides instead)', async () => {
    git(['remote', 'add', 'origin', 'git@github.com:a/b.git'], repoDir);
    await writeToonConfig(repoDir, { relays: ['wss://relay.example'] });
    const h = makeDeps({ RIG_MNEMONIC: PHRASE });
    expect(await runInit([], h.deps)).toBe(0);
    // The GitHub origin was NOT clobbered.
    expect(git(['remote', 'get-url', 'origin'], repoDir)).toBe(
      'git@github.com:a/b.git'
    );
    const text = h.out.join('\n');
    expect(text).toContain('toon.relay  = wss://relay.example (deprecated)');
    expect(text).toContain('rig remote add toon');
  });

  it('does not auto-migrate a multi-valued toon.relay (asks the user to pick)', async () => {
    await writeToonConfig(repoDir, {
      relays: ['wss://one.example', 'wss://two.example'],
    });
    const h = makeDeps({ RIG_MNEMONIC: PHRASE });
    expect(await runInit([], h.deps)).toBe(0);
    expect(git(['remote'], repoDir)).toBe('');
    const text = h.out.join('\n');
    expect(text).toContain('2 values');
    expect(text).toContain('rig remote add origin <relay-url>');
  });

  it('resolves the identity from a project .env (source reported)', async () => {
    writeFileSync(join(repoDir, '.env'), `RIG_MNEMONIC="${PHRASE}"\n`);
    const h = makeDeps({});
    expect(await runInit([], h.deps)).toBe(0);
    expect(h.out.join('\n')).toContain(
      `Identity: ${PUBKEY} (from ${join(repoDir, '.env')})`
    );
    expect((await readToonConfig(repoDir)).owner).toBe(PUBKEY);
  });

  it('errors with the three-option remediation when no identity exists', async () => {
    const h = makeDeps({});
    expect(await runInit([], h.deps)).toBe(1);
    const text = h.err.join('\n');
    expect(text).toContain('no identity found');
    expect(text).toContain('RIG_MNEMONIC environment variable');
    expect(text).toContain('.env');
    expect(text).toContain(join(homeDir, 'config.json'));
    // Nothing was written.
    expect((await readToonConfig(repoDir)).owner).toBeUndefined();
  });

  it('errors with a `git init` hint outside a git repository (never auto-runs it)', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'toon-rig-norepo-'));
    try {
      const h = makeDeps({ RIG_MNEMONIC: PHRASE }, bare);
      expect(await runInit([], h.deps)).toBe(1);
      const text = h.err.join('\n');
      expect(text).toContain('not a git repository');
      expect(text).toContain('git init');
      expect(execFileSync('ls', ['-A', bare], { encoding: 'utf-8' }).trim()).toBe('');
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('--json emits the machine-readable report', async () => {
    const h = makeDeps({ RIG_MNEMONIC: PHRASE });
    expect(await runInit(['--json', '--repo-id', 'demo'], h.deps)).toBe(0);
    const parsed = JSON.parse(h.out.join('\n')) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      command: 'init',
      repoRoot: repoDir,
      repoId: 'demo',
      owner: PUBKEY,
      identity: { source: 'env', sourceLabel: 'RIG_MNEMONIC env', pubkey: PUBKEY },
      relays: [],
      relayConfigured: false,
      remotes: [],
      origin: null,
      migratedToonRelay: false,
      changed: { repoId: true, owner: true },
    });
    expect(JSON.stringify(parsed)).not.toContain('abandon');

    // Idempotent re-run reports no changes.
    const h2 = makeDeps({ RIG_MNEMONIC: PHRASE });
    expect(await runInit(['--json'], h2.deps)).toBe(0);
    expect(JSON.parse(h2.out.join('\n'))).toMatchObject({
      repoId: 'demo',
      changed: { repoId: false, owner: false },
    });
  });

  it('--json reports the toon.relay migration', async () => {
    await writeToonConfig(repoDir, { relays: ['wss://relay.example'] });
    const h = makeDeps({ RIG_MNEMONIC: PHRASE });
    expect(await runInit(['--json'], h.deps)).toBe(0);
    expect(JSON.parse(h.out.join('\n'))).toMatchObject({
      relays: ['wss://relay.example'],
      relayConfigured: true,
      remotes: [{ name: 'origin', urls: ['wss://relay.example'] }],
      origin: 'wss://relay.example',
      migratedToonRelay: true,
    });
  });

  it('--json emits an error envelope on failure', async () => {
    const h = makeDeps({});
    expect(await runInit(['--json'], h.deps)).toBe(1);
    expect(JSON.parse(h.out.join('\n'))).toMatchObject({
      command: 'init',
      error: 'missing_identity',
    });
  });

  it('rejects unknown flags with usage (exit 2)', async () => {
    const h = makeDeps({ RIG_MNEMONIC: PHRASE });
    expect(await runInit(['--frobnicate'], h.deps)).toBe(2);
    expect(h.err.join('\n')).toContain('Usage: rig init');
  });

  it('--help prints usage and exits 0 without writing anything', async () => {
    const h = makeDeps({});
    expect(await runInit(['--help'], h.deps)).toBe(0);
    expect(h.out.join('\n')).toContain('--repo-id');
    expect((await readToonConfig(repoDir)).owner).toBeUndefined();
  });
});
