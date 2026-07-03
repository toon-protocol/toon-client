/**
 * `toon.*` git-config persistence tests against a real fixture repository.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initGitRepository,
  readToonConfig,
  resolveRepoRoot,
  writeToonConfig,
} from './git-config.js';

let repoDir: string;

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

beforeAll(() => {
  repoDir = mkdtempSync(join(tmpdir(), 'toon-rig-config-'));
  git(['init', '--initial-branch=main'], repoDir);
});

afterAll(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

describe('resolveRepoRoot', () => {
  it('resolves the worktree root from a nested cwd', async () => {
    const nested = join(repoDir, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    // Realpath both sides: on macOS/tmpfs the repo dir may be a symlink.
    const root = await resolveRepoRoot(nested);
    expect(git(['rev-parse', '--show-toplevel'], nested)).toBe(root);
  });

  it('throws a clear error outside a repository', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'toon-rig-notrepo-'));
    try {
      await expect(resolveRepoRoot(outside)).rejects.toThrow(
        /not a git repository/
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('initGitRepository', () => {
  it('creates a repo whose initial branch is `main`, even under a hostile init.defaultBranch=master', async () => {
    const fresh = mkdtempSync(join(tmpdir(), 'toon-rig-init-'));
    // Force the machine default to `master` for the git children that
    // initGitRepository spawns (they inherit process.env). This proves we
    // pin `main` deterministically rather than inheriting the system default.
    const saved = {
      count: process.env.GIT_CONFIG_COUNT,
      key: process.env.GIT_CONFIG_KEY_0,
      value: process.env.GIT_CONFIG_VALUE_0,
    };
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = 'init.defaultBranch';
    process.env.GIT_CONFIG_VALUE_0 = 'master';
    try {
      await initGitRepository(fresh);
      expect(git(['symbolic-ref', 'HEAD'], fresh)).toBe('refs/heads/main');
    } finally {
      if (saved.count === undefined) delete process.env.GIT_CONFIG_COUNT;
      else process.env.GIT_CONFIG_COUNT = saved.count;
      if (saved.key === undefined) delete process.env.GIT_CONFIG_KEY_0;
      else process.env.GIT_CONFIG_KEY_0 = saved.key;
      if (saved.value === undefined) delete process.env.GIT_CONFIG_VALUE_0;
      else process.env.GIT_CONFIG_VALUE_0 = saved.value;
      rmSync(fresh, { recursive: true, force: true });
    }
  });
});

describe('read/write toon config', () => {
  it('reads empty config as undefined fields + empty relay list', async () => {
    const config = await readToonConfig(repoDir);
    expect(config.repoId).toBeUndefined();
    expect(config.owner).toBeUndefined();
    expect(config.relays).toEqual([]);
  });

  it('round-trips repoId, owner, and a multi-valued relay list', async () => {
    await writeToonConfig(repoDir, {
      repoId: 'demo-repo',
      owner: 'ab'.repeat(32),
      relays: ['wss://relay-one.example', 'wss://relay-two.example'],
    });
    const config = await readToonConfig(repoDir);
    expect(config.repoId).toBe('demo-repo');
    expect(config.owner).toBe('ab'.repeat(32));
    expect(config.relays).toEqual([
      'wss://relay-one.example',
      'wss://relay-two.example',
    ]);
  });

  it('replaces the relay list wholesale on rewrite', async () => {
    await writeToonConfig(repoDir, { relays: ['wss://only.example'] });
    const config = await readToonConfig(repoDir);
    expect(config.relays).toEqual(['wss://only.example']);
    // Other keys untouched.
    expect(config.repoId).toBe('demo-repo');
  });

  it('leaves omitted fields alone', async () => {
    await writeToonConfig(repoDir, { repoId: 'renamed' });
    const config = await readToonConfig(repoDir);
    expect(config.repoId).toBe('renamed');
    expect(config.owner).toBe('ab'.repeat(32));
    expect(config.relays).toEqual(['wss://only.example']);
  });

  it('stores the keys under the file-visible toon.* section', () => {
    const raw = git(['config', '--get', 'toon.repoid'], repoDir);
    expect(raw).toBe('renamed');
  });
});
